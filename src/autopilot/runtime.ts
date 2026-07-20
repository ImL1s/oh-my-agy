import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  AutopilotActivePhase,
  AutopilotPhase,
  SessionAggregateStore,
  SessionAggregateV1,
  createInitialSessionAggregate,
  sessionAggregatePath,
} from '../continuation/session-aggregate';
import { sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { resolveStateRoot, resolveWorkspaceIdentity } from '../runtime/state-root';
import { Result, err, ok } from '../runtime/types';
import { ProgressOracleV1 } from '../continuation/progress-oracle';
import { GateEvidenceV1, GateKind, GateValidator } from '../verification/evidence';
import { ParsedAutopilotCommand, parseAutopilotCommand } from './commands';

export interface AutopilotSessionView {
  sessionId: string;
  revision: number;
  phase: AutopilotPhase;
  lastActivePhase: AutopilotActivePhase;
  goal: string;
  conversationId: string | null;
  noProgressStreak: number;
  retryableBlocker: SessionAggregateV1['autopilot']['retryableBlocker'];
  terminal: SessionAggregateV1['autopilot']['terminal'];
  acceptedEvidenceCount: number;
  /** OMX pipeline (session 完整使用) */
  phaseCycle: string[];
  iteration: number;
  reviewCycle: number;
  handoffArtifacts: SessionAggregateV1['autopilot']['handoffArtifacts'];
  reviewVerdict: SessionAggregateV1['autopilot']['reviewVerdict'];
  qaVerdict: SessionAggregateV1['autopilot']['qaVerdict'];
  returnToRalplanReason: string | null;
}

export interface AutopilotRuntimeOptions {
  stateRoot?: string;
  workspaceRoot?: string;
  workspaceKey?: string;
  repoKey?: string | null;
  sessionIdFactory?: () => string;
  now?: () => Date;
  gateValidator?: GateValidator;
}

import {
  OMX_PHASE_CYCLE,
  gateMatchesPhase,
  nextOmxPhaseAfterGate,
  toOmxPhaseName,
} from './phases';

const PHASE_ORDER: readonly AutopilotActivePhase[] = [
  ...OMX_PHASE_CYCLE,
  // legacy accepted during migration reads
  'requirements', 'planning', 'executing', 'review', 'qa',
];

/**
 * 設計概念映射：Autopilot FSM 完整對齊 OMX 五階段
 * deep-interview → ralplan → ultragoal → code-review → ultraqa（+ production 終端 gate）。
 * 狀態唯一 authority 為 SessionAggregateV1；argv 解析與 phase mutation 分離。
 */
export class AutopilotRuntime {
  readonly stateRoot: string;
  readonly workspaceKey: string;
  readonly repoKey: string | null;
  private readonly sessionIdFactory: () => string;
  private readonly now: () => Date;
  private readonly gateValidator: GateValidator;

  static create(options: Readonly<AutopilotRuntimeOptions> = {}): Result<AutopilotRuntime, RuntimeError> {
    let stateRoot = options.stateRoot;
    if (stateRoot === undefined) {
      const resolved = resolveStateRoot({ create: true });
      if (!resolved.ok) return resolved;
      stateRoot = resolved.value.path;
    }
    let workspaceKey = options.workspaceKey;
    let repoKey = options.repoKey ?? null;
    if (workspaceKey === undefined) {
      const workspace = resolveWorkspaceIdentity(options.workspaceRoot ?? process.cwd());
      if (!workspace.ok) return workspace;
      workspaceKey = workspace.value.workspaceKey;
      repoKey = workspace.value.repoKey;
    }
    return ok(new AutopilotRuntime(stateRoot, workspaceKey, repoKey, options));
  }

  private constructor(
    stateRoot: string,
    workspaceKey: string,
    repoKey: string | null,
    options: Readonly<AutopilotRuntimeOptions>,
  ) {
    this.stateRoot = path.resolve(stateRoot);
    this.workspaceKey = workspaceKey;
    this.repoKey = repoKey;
    this.sessionIdFactory = options.sessionIdFactory ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date());
    this.gateValidator = options.gateValidator ?? new GateValidator();
  }

  async dispatch(argv: readonly string[]): Promise<Result<unknown, RuntimeError>> {
    const parsed = parseAutopilotCommand(argv);
    if (!parsed.ok) return parsed;
    return this.execute(parsed.value);
  }

  async execute(command: ParsedAutopilotCommand): Promise<Result<unknown, RuntimeError>> {
    switch (command.kind) {
      case 'start':
        return this.start(command.goal);
      case 'status':
        return this.status(command.sessionId);
      case 'doctor':
        return this.doctor(command.sessionId);
      case 'checkpoint':
      case 'advance':
        return this.acceptGate('checkpoint', command.sessionId, command.expectedRevision, command.evidencePath);
      case 'review':
      case 'qa':
        return this.acceptGate(command.kind, command.sessionId, command.expectedRevision, command.evidencePath);
      case 'resume':
        return this.resume(command.sessionId, command.conversationId, command.expectedRevision);
      case 'drive':
        return this.drive(command.sessionId, command.conversationId, command.expectedRevision);
      case 'cancel':
        return this.cancel(command.sessionId, command.expectedRevision, command.reason);
      case 'reset-breaker':
        return this.resetBreaker(command.sessionId, command.expectedRevision);
      case 'handoff':
        return this.recordHandoff(
          command.sessionId,
          command.expectedRevision,
          command.key,
          command.path,
        );
      case 'consensus':
        return this.recordConsensus(
          command.sessionId,
          command.expectedRevision,
          command.role,
          command.verdict,
          command.note,
        );
      case 'return-ralplan':
        return this.returnToRalplan(command.sessionId, command.expectedRevision, command.reason);
    }
  }

  async start(goal: string): Promise<Result<AutopilotSessionView, RuntimeError>> {
    const trimmed = goal.trim();
    if (trimmed === '') {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'Autopilot goal must not be empty'));
    }
    const sessionId = this.sessionIdFactory();
    const store = this.storeFor(sessionId);
    const aggregate = createInitialSessionAggregate({
      sessionId,
      repoKey: this.repoKey,
      workspaceKey: this.workspaceKey,
      launchNonceDigest: sha256(crypto.randomBytes(32)),
      phase: 'deep-interview',
      workspacePath: process.cwd(),
    });
    const created = await store.initialize(aggregate);
    if (!created.ok) return created;
    this.writeGoal(sessionId, trimmed);
    return ok(this.view(created.value, trimmed));
  }

  async status(sessionId: string): Promise<Result<AutopilotSessionView, RuntimeError>> {
    const snapshot = this.storeFor(sessionId).read();
    if (!snapshot.ok) return snapshot;
    return ok(this.view(snapshot.value, this.readGoal(sessionId)));
  }

  async doctor(sessionId: string): Promise<Result<Record<string, unknown>, RuntimeError>> {
    const snapshot = this.storeFor(sessionId).read();
    if (!snapshot.ok) return snapshot;
    const view = this.view(snapshot.value, this.readGoal(sessionId));
    const aggregatePath = this.storeFor(sessionId).aggregatePath;
    return ok({
      ...view,
      aggregatePath,
      healthy: view.terminal === null && view.phase !== 'tripped' && view.phase !== 'failed',
      bindingState: snapshot.value.binding.state,
      bindingRoute: snapshot.value.binding.bindingRoute,
      diagnosis: this.diagnose(snapshot.value),
    });
  }

  async acceptGate(
    commandKind: 'checkpoint' | 'review' | 'qa',
    sessionId: string,
    expectedRevision: number,
    evidencePath: string,
  ): Promise<Result<AutopilotSessionView, RuntimeError>> {
    const evidence = this.readEvidenceFile(evidencePath);
    if (!evidence.ok) return evidence;
    const store = this.storeFor(sessionId);
    const current = store.read();
    if (!current.ok) return current;
    if (isTerminal(current.value.autopilot.phase)) {
      return err(runtimeError('E_TERMINAL_STATE', 'Terminal Autopilot sessions cannot accept gates'));
    }
    const gateKind = gateKindFor(commandKind, current.value.autopilot.phase, evidence.value.kind);
    if (!gateKind.ok) return gateKind;
    const validated = this.gateValidator.validate(gateKind.value, evidence.value, current.value);
    if (validated.kind === 'Rejected') return err(validated.error);

    const updated = await store.compareAndSwap(expectedRevision, (snapshot) => {
      const nextPhase = nextPhaseAfter(snapshot.autopilot.phase, gateKind.value);
      const now = this.now().toISOString();
      const accepted = {
        revision: expectedRevision + 1,
        digest: evidence.value.artifact.digest,
        kind: evidence.value.kind,
        id: evidence.value.invocationNonce,
      };
      const acceptedGateRevisions = [
        ...snapshot.autopilot.acceptedGateRevisions,
        { id: evidence.value.kind, revision: expectedRevision + 1 },
      ];
      const acceptedTaskProgressRevisions = [
        ...snapshot.autopilot.acceptedTaskProgressRevisions,
        expectedRevision + 1,
      ];
      const acceptedEvidence = [...snapshot.autopilot.acceptedEvidence, accepted];
      const verifiedArtifacts = [
        ...snapshot.autopilot.verifiedArtifacts,
        { path: evidence.value.artifact.path, digest: evidence.value.artifact.digest },
      ];
      // PRD progress fingerprint：只由 accepted gate/task/evidence/artifacts 決定。
      const progressFingerprint = new ProgressOracleV1().fingerprint({
        acceptedGateRevisions,
        acceptedTaskProgressRevisions,
        acceptedEvidenceRevisionsAndDigests: acceptedEvidence,
        verifiedArtifactDigests: verifiedArtifacts,
      });
      const gateOmx = toOmxPhaseName(evidence.value.kind);
      let reviewVerdict = snapshot.autopilot.reviewVerdict;
      let qaVerdict = snapshot.autopilot.qaVerdict;
      let returnToRalplanReason = snapshot.autopilot.returnToRalplanReason;
      if (gateOmx === 'code-review' || evidence.value.kind === 'review') {
        reviewVerdict = { clean: true, recommendation: 'APPROVE', at: now };
        returnToRalplanReason = null;
      }
      if (gateOmx === 'ultraqa' || evidence.value.kind === 'qa') {
        qaVerdict = { clean: true, skipped: false, reason: null, at: now };
        returnToRalplanReason = null;
      }
      const autopilot = {
        ...snapshot.autopilot,
        phase: nextPhase.phase,
        lastActivePhase: nextPhase.active,
        acceptedGateRevisions,
        acceptedTaskProgressRevisions,
        acceptedEvidence,
        verifiedArtifacts,
        progressFingerprint,
        noProgressStreak: 0,
        retryableBlocker: null,
        reviewVerdict,
        qaVerdict,
        returnToRalplanReason,
        terminal: nextPhase.phase === 'completed'
          ? {
            phase: 'completed' as const,
            reason: `gate ${evidence.value.kind} accepted`,
            actor: evidence.value.actor,
            actorNonce: evidence.value.invocationNonce,
            evidenceDigest: evidence.value.artifact.digest,
            at: now,
          }
          : snapshot.autopilot.terminal,
      };
      return {
        ...snapshot,
        revision: expectedRevision + 1,
        autopilot,
      };
    });
    if (!updated.ok) return updated;
    return ok(this.view(updated.value, this.readGoal(sessionId)));
  }

  async resume(
    sessionId: string,
    conversationId: string,
    expectedRevision: number,
  ): Promise<Result<AutopilotSessionView, RuntimeError>> {
    const updated = await this.applyResumeBinding(sessionId, conversationId, expectedRevision);
    if (!updated.ok) return updated;
    return ok(this.view(updated.value, this.readGoal(sessionId)));
  }

  /**
   * drive：更新 ledger binding 後回傳 launch 座標，由 CLI 呼叫 resumeConversation spawn。
   * 設計概念映射：與 resume 分離 — resume 純記帳；drive 才接程序。
   */
  async drive(
    sessionId: string,
    conversationId: string,
    expectedRevision: number,
  ): Promise<Result<{
    view: AutopilotSessionView;
    launch: { sessionId: string; conversationId: string; expectedRevision: number };
  }, RuntimeError>> {
    const updated = await this.applyResumeBinding(sessionId, conversationId, expectedRevision);
    if (!updated.ok) return updated;
    return ok({
      view: this.view(updated.value, this.readGoal(sessionId)),
      launch: {
        sessionId,
        conversationId,
        expectedRevision: updated.value.revision,
      },
    });
  }

  private async applyResumeBinding(
    sessionId: string,
    conversationId: string,
    expectedRevision: number,
  ): Promise<Result<SessionAggregateV1, RuntimeError>> {
    const store = this.storeFor(sessionId);
    const current = store.read();
    if (!current.ok) return current;
    if (isTerminal(current.value.autopilot.phase)) {
      return err(runtimeError('E_TERMINAL_STATE', 'Terminal Autopilot sessions cannot be resumed'));
    }
    const updated = await store.compareAndSwap(expectedRevision, (snapshot) => ({
      ...snapshot,
      revision: expectedRevision + 1,
      binding: {
        ...snapshot.binding,
        conversationId,
        state: snapshot.binding.state === 'bound' ? 'bound' : 'resume_pending',
      },
      autopilot: {
        ...snapshot.autopilot,
        retryableBlocker: null,
        interactionBlocker: null,
      },
    }));
    if (!updated.ok) return updated;
    return ok(updated.value);
  }

  async cancel(
    sessionId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<Result<AutopilotSessionView, RuntimeError>> {
    const store = this.storeFor(sessionId);
    const current = store.read();
    if (!current.ok) return current;
    if (isTerminal(current.value.autopilot.phase) && current.value.autopilot.phase !== 'cancelled') {
      return err(runtimeError('E_TERMINAL_STATE', 'Session is already terminal'));
    }
    const updated = await store.compareAndSwap(expectedRevision, (snapshot) => {
      const now = this.now().toISOString();
      return {
        ...snapshot,
        revision: expectedRevision + 1,
        autopilot: {
          ...snapshot.autopilot,
          phase: 'cancelled',
          retryableBlocker: null,
          terminal: {
            phase: 'cancelled',
            reason,
            actor: 'operator',
            actorNonce: sha256(reason),
            evidenceDigest: sha256(reason),
            at: now,
          },
        },
      };
    });
    if (!updated.ok) return updated;
    return ok(this.view(updated.value, this.readGoal(sessionId)));
  }

  async resetBreaker(
    sessionId: string,
    expectedRevision: number,
  ): Promise<Result<AutopilotSessionView, RuntimeError>> {
    const store = this.storeFor(sessionId);
    const current = store.read();
    if (!current.ok) return current;
    if (current.value.autopilot.phase !== 'tripped') {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'reset-breaker requires phase=tripped'));
    }
    const updated = await store.compareAndSwap(expectedRevision, (snapshot) => ({
      ...snapshot,
      revision: expectedRevision + 1,
      autopilot: {
        ...snapshot.autopilot,
        phase: snapshot.autopilot.lastActivePhase,
        terminal: null,
        noProgressStreak: 0,
        lastEligibleFingerprint: null,
        retryableBlocker: null,
      },
    }));
    if (!updated.ok) return updated;
    return ok(this.view(updated.value, this.readGoal(sessionId)));
  }

  private storeFor(sessionId: string): SessionAggregateStore {
    return new SessionAggregateStore(
      sessionAggregatePath(this.stateRoot, this.workspaceKey, sessionId),
    );
  }

  private goalPath(sessionId: string): string {
    return path.join(
      this.stateRoot,
      'workspaces',
      this.workspaceKey,
      'sessions',
      sha256(sessionId),
      'goal.txt',
    );
  }

  private writeGoal(sessionId: string, goal: string): void {
    const target = this.goalPath(sessionId);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, `${goal}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private readGoal(sessionId: string): string {
    try {
      return fs.readFileSync(this.goalPath(sessionId), 'utf8').trim();
    } catch {
      return '';
    }
  }

  private readEvidenceFile(evidencePath: string): Result<GateEvidenceV1, RuntimeError> {
    try {
      const raw = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as unknown;
      return ok(raw as GateEvidenceV1);
    } catch (error) {
      return err(runtimeError('E_CORRUPT_STATE', 'Gate evidence file cannot be read', {
        evidencePath,
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private view(aggregate: SessionAggregateV1, goal: string): AutopilotSessionView {
    const ap = aggregate.autopilot;
    return {
      sessionId: aggregate.sessionId,
      revision: aggregate.revision,
      phase: ap.phase,
      lastActivePhase: ap.lastActivePhase,
      goal,
      conversationId: aggregate.binding.conversationId,
      noProgressStreak: ap.noProgressStreak,
      retryableBlocker: ap.retryableBlocker,
      terminal: ap.terminal,
      acceptedEvidenceCount: ap.acceptedEvidence.length,
      phaseCycle: ap.phaseCycle ?? [...OMX_PHASE_CYCLE],
      iteration: ap.iteration ?? 1,
      reviewCycle: ap.reviewCycle ?? 0,
      handoffArtifacts: ap.handoffArtifacts,
      reviewVerdict: ap.reviewVerdict ?? null,
      qaVerdict: ap.qaVerdict ?? null,
      returnToRalplanReason: ap.returnToRalplanReason ?? null,
    };
  }

  async recordHandoff(
    sessionId: string,
    expectedRevision: number,
    key: 'deepInterview' | 'ralplan' | 'ultragoal' | 'codeReview' | 'ultraqa',
    artifactPath: string,
  ): Promise<Result<AutopilotSessionView, RuntimeError>> {
    if (artifactPath.trim() === '') {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'handoff path must not be empty'));
    }
    const store = this.storeFor(sessionId);
    const current = store.read();
    if (!current.ok) return current;
    if (isTerminal(current.value.autopilot.phase)) {
      return err(runtimeError('E_TERMINAL_STATE', 'Terminal Autopilot sessions cannot record handoff'));
    }
    const updated = await store.compareAndSwap(expectedRevision, (snapshot) => {
      const handoff = {
        ...snapshot.autopilot.handoffArtifacts,
        [key]: artifactPath,
      };
      return {
        ...snapshot,
        revision: expectedRevision + 1,
        autopilot: {
          ...snapshot.autopilot,
          handoffArtifacts: handoff,
        },
      };
    });
    if (!updated.ok) return updated;
    return ok(this.view(updated.value, this.readGoal(sessionId)));
  }

  async recordConsensus(
    sessionId: string,
    expectedRevision: number,
    role: 'architect' | 'critic',
    verdict: 'approve' | 'revise',
    note: string,
  ): Promise<Result<AutopilotSessionView, RuntimeError>> {
    const store = this.storeFor(sessionId);
    const current = store.read();
    if (!current.ok) return current;
    if (isTerminal(current.value.autopilot.phase)) {
      return err(runtimeError('E_TERMINAL_STATE', 'Terminal Autopilot sessions cannot record consensus'));
    }
    const updated = await store.compareAndSwap(expectedRevision, (snapshot) => {
      const now = this.now().toISOString();
      const gate = { ...snapshot.autopilot.handoffArtifacts.ralplanConsensusGate };
      const entry = { verdict, at: now, note };
      if (role === 'architect') gate.architectReview = entry;
      else gate.criticReview = entry;
      gate.complete = gate.architectReview?.verdict === 'approve'
        && gate.criticReview?.verdict === 'approve';
      return {
        ...snapshot,
        revision: expectedRevision + 1,
        autopilot: {
          ...snapshot.autopilot,
          handoffArtifacts: {
            ...snapshot.autopilot.handoffArtifacts,
            ralplanConsensusGate: gate,
          },
        },
      };
    });
    if (!updated.ok) return updated;
    return ok(this.view(updated.value, this.readGoal(sessionId)));
  }

  async returnToRalplan(
    sessionId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<Result<AutopilotSessionView, RuntimeError>> {
    if (reason.trim() === '') {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'return-ralplan reason must not be empty'));
    }
    const store = this.storeFor(sessionId);
    const current = store.read();
    if (!current.ok) return current;
    if (isTerminal(current.value.autopilot.phase)) {
      return err(runtimeError('E_TERMINAL_STATE', 'Terminal Autopilot sessions cannot return to ralplan'));
    }
    const updated = await store.compareAndSwap(expectedRevision, (snapshot) => ({
      ...snapshot,
      revision: expectedRevision + 1,
      autopilot: {
        ...snapshot.autopilot,
        phase: 'ralplan',
        lastActivePhase: 'ralplan',
        returnToRalplanReason: reason,
        reviewCycle: (snapshot.autopilot.reviewCycle ?? 0) + 1,
        iteration: (snapshot.autopilot.iteration ?? 1) + 1,
        reviewVerdict: snapshot.autopilot.reviewVerdict
          ? { ...snapshot.autopilot.reviewVerdict, clean: false }
          : { clean: false, recommendation: 'REQUEST CHANGES', at: this.now().toISOString() },
        handoffArtifacts: {
          ...snapshot.autopilot.handoffArtifacts,
          ralplanConsensusGate: {
            complete: false,
            architectReview: null,
            criticReview: null,
          },
        },
      },
    }));
    if (!updated.ok) return updated;
    return ok(this.view(updated.value, this.readGoal(sessionId)));
  }

  private diagnose(aggregate: SessionAggregateV1): string[] {
    const notes: string[] = [];
    if (aggregate.autopilot.phase === 'tripped') {
      notes.push('breaker tripped; use reset-breaker --expected-revision');
    }
    if (aggregate.autopilot.retryableBlocker !== null) {
      notes.push(`retryable blocker: ${aggregate.autopilot.retryableBlocker.kind}`);
    }
    if (aggregate.autopilot.noProgressStreak > 0) {
      notes.push(`no-progress streak=${aggregate.autopilot.noProgressStreak}`);
    }
    if (aggregate.binding.conversationId === null) {
      notes.push('conversation unbound; resume with --conversation when ready');
    }
    if (notes.length === 0) notes.push('no blocking diagnostics');
    return notes;
  }
}

function isTerminal(phase: AutopilotPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'tripped' || phase === 'cancelled';
}

function gateKindFor(
  commandKind: 'checkpoint' | 'review' | 'qa',
  phase: AutopilotPhase,
  evidenceKind: GateKind,
): Result<GateKind, RuntimeError> {
  const phaseOmx = toOmxPhaseName(phase);
  const kindOmx = toOmxPhaseName(evidenceKind);
  if (commandKind === 'review') {
    if (phaseOmx !== 'code-review' && phaseOmx !== 'ultragoal') {
      return err(runtimeError(
        'E_VALIDATOR_REJECTED',
        'review is only valid in ultragoal/code-review phase',
      ));
    }
    if (kindOmx !== 'code-review' && evidenceKind !== 'review') {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'review command requires code-review evidence'));
    }
    return ok(evidenceKind === 'review' ? 'review' : 'code-review');
  }
  if (commandKind === 'qa') {
    if (phaseOmx !== 'ultraqa' && phaseOmx !== 'code-review') {
      return err(runtimeError(
        'E_VALIDATOR_REJECTED',
        'qa is only valid in code-review/ultraqa phase',
      ));
    }
    if (kindOmx !== 'ultraqa' && evidenceKind !== 'qa') {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'qa command requires ultraqa/qa evidence'));
    }
    return ok(evidenceKind === 'qa' ? 'qa' : 'ultraqa');
  }
  // production gate only completes Autopilot (must follow ultraqa)
  if ((phaseOmx === 'ultraqa' || phase === 'qa') && evidenceKind === 'production') {
    return ok('production');
  }
  if (!isActivePhase(phase)) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'checkpoint requires an active Autopilot phase'));
  }
  if (!gateMatchesPhase(phase, evidenceKind)) {
    return err(runtimeError(
      'E_VALIDATOR_REJECTED',
      `checkpoint evidence kind must match phase ${phaseOmx}`,
    ));
  }
  return ok(evidenceKind);
}

function isActivePhase(phase: AutopilotPhase): phase is AutopilotActivePhase {
  return (PHASE_ORDER as readonly string[]).includes(phase);
}

function nextPhaseAfter(
  current: AutopilotPhase,
  gate: GateKind,
): { phase: AutopilotPhase; active: AutopilotActivePhase } {
  const next = nextOmxPhaseAfterGate(current, gate);
  return {
    phase: next.phase as AutopilotPhase,
    active: next.active as AutopilotActivePhase,
  };
}
