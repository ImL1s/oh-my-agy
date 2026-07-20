import * as fs from 'fs';
import * as path from 'path';
import {
  AtomicFaultContext,
  FaultInjector,
  NO_FAULTS,
  atomicWriteJson,
  canonicalJson,
  sha256,
} from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { acquireOwnerLock, releaseOwnerLock } from '../runtime/lock';
import { Result, err, ok } from '../runtime/types';
import { ProcessIdentity } from '../runtime/types';
import { StopEventIdentity, stopEventKey, validateStopEventIdentity } from './event-identity';

/** OMX canonical + legacy aliases + terminals */
export type AutopilotPhase =
  | 'deep-interview'
  | 'ralplan'
  | 'ultragoal'
  | 'code-review'
  | 'ultraqa'
  // legacy aliases (仍可出現在舊 aggregate / 測試)
  | 'requirements'
  | 'planning'
  | 'executing'
  | 'review'
  | 'qa'
  | 'completed'
  | 'failed'
  | 'tripped'
  | 'cancelled';

export type AutopilotActivePhase =
  | 'deep-interview'
  | 'ralplan'
  | 'ultragoal'
  | 'code-review'
  | 'ultraqa'
  | 'requirements'
  | 'planning'
  | 'executing'
  | 'review'
  | 'qa';

export interface AcceptedRevisionRefV1 {
  id: string;
  revision: number;
}

export interface RetryableBlockerV1 {
  code: 'E_RETRYABLE_BLOCKER';
  phase: AutopilotActivePhase;
  kind: string;
  attempt: number;
  lastErrorDigest: string;
  firstSeenAt: string;
  lastSeenAt: string;
  retryAfter?: string;
  nextRetryAt?: string;
  deadlineAt?: string;
  runnerIdentity: ProcessIdentity | null;
}

export interface AcceptedEvidenceV1 {
  id?: string;
  revision: number;
  digest: string;
  kind: string;
}

export interface VerifiedArtifactV1 {
  path: string;
  digest: string;
}

export interface SessionBindingV1 {
  conversationId: string | null;
  activeInvocationGeneration: number;
  launchNonceDigest: string;
  state: 'launch_pending' | 'resume_pending' | 'bound' | 'idle';
  bindingRoute: 'exact_env' | null;
  workspacePath: string;
  owner: ProcessIdentity | null;
  expiresAtMs: number | null;
}

export interface AutopilotTerminalRecordV1 {
  phase: 'completed' | 'failed' | 'tripped' | 'cancelled';
  reason: string;
  actor: string;
  actorNonce: string;
  evidenceDigest: string;
  at: string;
}

export interface RalplanConsensusGateV1 {
  complete: boolean;
  architectReview: { verdict: string; at: string; note?: string } | null;
  criticReview: { verdict: string; at: string; note?: string } | null;
}

export interface AutopilotHandoffArtifactsV1 {
  contextSnapshotPath: string | null;
  deepInterview: string | null;
  ralplan: string | null;
  ralplanConsensusGate: RalplanConsensusGateV1;
  ultragoal: string | null;
  codeReview: string | null;
  ultraqa: string | null;
}

export interface AutopilotAggregateV1 {
  phase: AutopilotPhase;
  lastActivePhase: AutopilotActivePhase;
  terminal: AutopilotTerminalRecordV1 | null;
  retryableBlocker: RetryableBlockerV1 | null;
  interactionBlocker: string | null;
  liveCommand: ProcessIdentity | null;
  acceptedGateRevisions: Array<number | AcceptedRevisionRefV1>;
  acceptedTaskProgressRevisions: Array<number | AcceptedRevisionRefV1>;
  acceptedEvidence: AcceptedEvidenceV1[];
  verifiedArtifacts: VerifiedArtifactV1[];
  progressFingerprint: string;
  lastEligibleFingerprint: string | null;
  noProgressStreak: number;
  /** OMX 五階段 pipeline 欄位（session 內完整使用） */
  phaseCycle: string[];
  iteration: number;
  reviewCycle: number;
  handoffArtifacts: AutopilotHandoffArtifactsV1;
  reviewVerdict: { clean: boolean; recommendation: string; at: string } | null;
  qaVerdict: { clean: boolean; skipped: boolean; reason: string | null; at: string } | null;
  returnToRalplanReason: string | null;
}

export interface StopEffectV1 {
  beforeRevision: number;
  afterRevision: number;
  streakBefore: number;
  streakAfter: number;
  phaseBefore: AutopilotPhase;
  phaseAfter: AutopilotPhase;
}

export type ProcessedStopDecision =
  | { decision: 'allow' }
  | { decision: 'continue'; reason: string };

export interface ProcessedStopRecordV1 {
  identity: StopEventIdentity;
  inputDigest: string;
  decisionJson: string;
  progressFingerprint: string;
  breakerEligible: boolean;
  effect: StopEffectV1;
  effectDigest: string;
}

export interface SessionAggregateV1 {
  schemaVersion: 1;
  revision: number;
  sessionId: string;
  repoKey: string | null;
  workspaceKey: string;
  binding: SessionBindingV1;
  autopilot: AutopilotAggregateV1;
  processedStops: Record<string, ProcessedStopRecordV1>;
}

export interface InitialSessionAggregateInput {
  sessionId: string;
  repoKey: string | null;
  workspaceKey: string;
  launchNonceDigest: string;
  invocationGeneration?: number;
  phase?: AutopilotPhase;
  workspacePath?: string;
  owner?: ProcessIdentity | null;
  expiresAtMs?: number | null;
}

export type StopCandidateKind = 'Continue' | 'Trip' | 'NonCounting';

export interface AggregateCandidate<D extends ProcessedStopDecision = ProcessedStopDecision> {
  kind: StopCandidateKind;
  aggregate: SessionAggregateV1;
  decision: D;
  breakerEligible: boolean;
  effect: StopEffectV1;
}

export type StopReducerV1 = (
  snapshot: Readonly<SessionAggregateV1>,
) => AggregateCandidate;

export type SessionAggregateMutatorV1 = (
  snapshot: Readonly<SessionAggregateV1>,
) => SessionAggregateV1;

export interface AppliedStopCommit {
  kind: 'Applied';
  snapshot: SessionAggregateV1;
  decision: ProcessedStopDecision;
  decisionJson: string;
}

export interface ReplayedStopCommit {
  kind: 'Replayed';
  snapshot: SessionAggregateV1;
  decision: ProcessedStopDecision;
  decisionJson: string;
}

export type StopCommitResult = AppliedStopCommit | ReplayedStopCommit;

export interface SessionAggregateStoreOptions {
  lockTimeoutMs?: number;
  faultInjector?: FaultInjector;
}

export function sessionAggregateRelativePath(workspaceKey: string, sessionId: string): string {
  return path.join('workspaces', workspaceKey, 'sessions', sha256(sessionId), 'aggregate.json');
}

export function sessionAggregatePath(
  stateRoot: string,
  workspaceKey: string,
  sessionId: string,
): string {
  return path.resolve(stateRoot, sessionAggregateRelativePath(workspaceKey, sessionId));
}

export function createInitialSessionAggregate(
  input: Readonly<InitialSessionAggregateInput>,
): SessionAggregateV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    sessionId: input.sessionId,
    repoKey: input.repoKey,
    workspaceKey: input.workspaceKey,
    binding: {
      conversationId: null,
      activeInvocationGeneration: input.invocationGeneration ?? 1,
      launchNonceDigest: input.launchNonceDigest,
      state: 'launch_pending',
      bindingRoute: null,
      workspacePath: input.workspacePath ?? '',
      owner: input.owner ?? null,
      expiresAtMs: input.expiresAtMs ?? null,
    },
    autopilot: {
      phase: input.phase ?? 'deep-interview',
      lastActivePhase: isActivePhase(input.phase) ? input.phase : 'deep-interview',
      terminal: null,
      retryableBlocker: null,
      interactionBlocker: null,
      liveCommand: null,
      acceptedGateRevisions: [],
      acceptedTaskProgressRevisions: [],
      acceptedEvidence: [],
      verifiedArtifacts: [],
      progressFingerprint: '',
      lastEligibleFingerprint: null,
      noProgressStreak: 0,
      phaseCycle: [
        'deep-interview',
        'ralplan',
        'ultragoal',
        'code-review',
        'ultraqa',
      ],
      iteration: 1,
      reviewCycle: 0,
      handoffArtifacts: emptyHandoffArtifacts(),
      reviewVerdict: null,
      qaVerdict: null,
      returnToRalplanReason: null,
    },
    processedStops: {},
  };
}

export function emptyHandoffArtifacts(): AutopilotHandoffArtifactsV1 {
  return {
    contextSnapshotPath: null,
    deepInterview: null,
    ralplan: null,
    ralplanConsensusGate: {
      complete: false,
      architectReview: null,
      criticReview: null,
    },
    ultragoal: null,
    codeReview: null,
    ultraqa: null,
  };
}

function isActivePhase(phase: AutopilotPhase | undefined): phase is AutopilotActivePhase {
  return phase !== undefined && [
    'deep-interview',
    'ralplan',
    'ultragoal',
    'code-review',
    'ultraqa',
    'requirements',
    'planning',
    'executing',
    'review',
    'qa',
  ].includes(phase);
}

export class SessionAggregateStore {
  readonly aggregatePath: string;
  private readonly lockTimeoutMs: number;
  private readonly faultInjector: FaultInjector;

  constructor(aggregatePath: string, options: SessionAggregateStoreOptions = {}) {
    this.aggregatePath = path.resolve(aggregatePath);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.faultInjector = options.faultInjector ?? NO_FAULTS;
  }

  async initialize(
    aggregate: Readonly<SessionAggregateV1>,
  ): Promise<Result<SessionAggregateV1, RuntimeError>> {
    const lock = await acquireOwnerLock(`${this.aggregatePath}.lock`, { timeoutMs: this.lockTimeoutMs });
    if (!lock.ok) return lock;
    try {
      if (fs.existsSync(this.aggregatePath)) {
        return err(runtimeError('E_ALREADY_EXISTS', 'Session aggregate already exists', {
          aggregatePath: this.aggregatePath,
        }));
      }
      const validated = validateAggregate(aggregate);
      if (!validated.ok) return validated;
      atomicWriteJson(this.aggregatePath, aggregate, {
        nextRevision: aggregate.revision,
        faultInjector: this.faultInjector,
      });
      return ok(structuredClone(aggregate));
    } finally {
      releaseOwnerLock(lock.value);
    }
  }

  read(): Result<SessionAggregateV1, RuntimeError> {
    if (!fs.existsSync(this.aggregatePath)) {
      return err(runtimeError('E_NOT_FOUND', 'Session aggregate does not exist', {
        aggregatePath: this.aggregatePath,
      }));
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.aggregatePath, 'utf8')) as unknown;
      return validateAggregate(parsed);
    } catch (error) {
      return err(runtimeError('E_CORRUPT_STATE', 'Session aggregate JSON is corrupt', {
        aggregatePath: this.aggregatePath,
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async compareAndSwap(
    expectedRevision: number,
    pureMutator: SessionAggregateMutatorV1,
  ): Promise<Result<SessionAggregateV1, RuntimeError>> {
    const lock = await acquireOwnerLock(`${this.aggregatePath}.lock`, { timeoutMs: this.lockTimeoutMs });
    if (!lock.ok) return lock;
    try {
      const current = this.read();
      if (!current.ok) return current;
      if (current.value.revision !== expectedRevision) {
        return err(runtimeError('E_REVISION_CONFLICT', 'Session aggregate revision changed', {
          expectedRevision,
          actualRevision: current.value.revision,
        }));
      }
      let next: SessionAggregateV1;
      try {
        next = pureMutator(structuredClone(current.value));
      } catch (error) {
        return err(runtimeError('E_CORRUPT_STATE', 'Session aggregate mutator failed', {
          cause: error instanceof Error ? error.message : String(error),
        }));
      }
      const validated = validateAggregate(next);
      if (!validated.ok) return validated;
      if (
        next.revision !== expectedRevision + 1
        || next.sessionId !== current.value.sessionId
        || next.workspaceKey !== current.value.workspaceKey
        || next.repoKey !== current.value.repoKey
        || canonicalJson(next.processedStops) !== canonicalJson(current.value.processedStops)
      ) {
        return err(runtimeError(
          'E_REVISION_CONFLICT',
          'Aggregate CAS must advance one revision, preserve identity, and leave processed Stops authoritative',
        ));
      }
      atomicWriteJson(this.aggregatePath, next, {
        expectedRevision,
        nextRevision: next.revision,
        faultInjector: this.faultInjector,
      });
      return ok(next);
    } finally {
      releaseOwnerLock(lock.value);
    }
  }

  async commitStop(
    identity: Readonly<StopEventIdentity>,
    inputDigest: string,
    pureReducer: StopReducerV1,
  ): Promise<Result<StopCommitResult, RuntimeError>> {
    const validIdentity = validateStopEventIdentity(identity);
    if (!validIdentity.ok) return validIdentity;
    if (!/^[a-f0-9]{64}$/i.test(inputDigest)) {
      return err(runtimeError('E_CORRUPT_STATE', 'Stop input digest must be SHA-256 hex'));
    }

    const lock = await acquireOwnerLock(`${this.aggregatePath}.lock`, { timeoutMs: this.lockTimeoutMs });
    if (!lock.ok) return lock;
    try {
      const current = this.read();
      if (!current.ok) return current;
      const key = stopEventKey(identity);
      const previous = current.value.processedStops[key];
      if (previous !== undefined) {
        if (previous.inputDigest !== inputDigest) {
          return err(runtimeError('E_STOP_EVENT_CONFLICT', 'Stop identity was reused with different input', {
            identity,
          }));
        }
        return ok({
          kind: 'Replayed',
          snapshot: current.value,
          decision: JSON.parse(previous.decisionJson) as ProcessedStopDecision,
          decisionJson: previous.decisionJson,
        });
      }

      const candidate = pureReducer(structuredClone(current.value));
      const candidateError = validateCandidate(current.value, candidate);
      if (candidateError !== undefined) return err(candidateError);
      const context: AtomicFaultContext = {
        targetPath: this.aggregatePath,
        transactionId: key,
        expectedRevision: current.value.revision,
        nextRevision: current.value.revision + 1,
      };
      this.faultInjector.inject('record-only-candidate', context);
      this.faultInjector.inject('state-only-candidate', context);

      const decisionJson = canonicalJson(candidate.decision);
      const recordWithoutDigest = {
        identity: validIdentity.value,
        inputDigest,
        decisionJson,
        progressFingerprint: candidate.aggregate.autopilot.progressFingerprint,
        breakerEligible: candidate.breakerEligible,
        effect: candidate.effect,
      };
      const record: ProcessedStopRecordV1 = {
        ...recordWithoutDigest,
        effectDigest: sha256(canonicalJson(recordWithoutDigest)),
      };
      const next: SessionAggregateV1 = {
        ...structuredClone(candidate.aggregate),
        revision: current.value.revision + 1,
        processedStops: {
          ...candidate.aggregate.processedStops,
          [key]: record,
        },
      };

      atomicWriteJson(this.aggregatePath, next, {
        transactionId: key,
        expectedRevision: current.value.revision,
        nextRevision: next.revision,
        faultInjector: this.faultInjector,
      });
      return ok({ kind: 'Applied', snapshot: next, decision: candidate.decision, decisionJson });
    } finally {
      releaseOwnerLock(lock.value);
    }
  }
}

function validateAggregate(value: unknown): Result<SessionAggregateV1, RuntimeError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(runtimeError('E_CORRUPT_STATE', 'Session aggregate must be an object'));
  }
  const candidate = value as Partial<SessionAggregateV1>;
  if (typeof candidate.schemaVersion === 'number' && candidate.schemaVersion > 1) {
    return err(runtimeError('E_FUTURE_SCHEMA', 'Session aggregate uses a future schema', {
      schemaVersion: candidate.schemaVersion,
    }));
  }
  if (
    candidate.schemaVersion !== 1
    || !Number.isSafeInteger(candidate.revision)
    || (candidate.revision as number) < 0
    || typeof candidate.sessionId !== 'string'
    || typeof candidate.workspaceKey !== 'string'
    || typeof candidate.binding !== 'object'
    || candidate.binding === null
    || typeof candidate.autopilot !== 'object'
    || candidate.autopilot === null
    || typeof candidate.processedStops !== 'object'
    || candidate.processedStops === null
    || Array.isArray(candidate.processedStops)
  ) {
    return err(runtimeError('E_CORRUPT_STATE', 'Session aggregate shape is invalid'));
  }
  const migrated = structuredClone(candidate as SessionAggregateV1);
  migrated.autopilot = migrateAutopilotAggregate(migrated.autopilot);
  return ok(migrated);
}

/** 舊 aggregate 補 OMX pipeline 欄位，並把 phase 映到 canonical 名。 */
export function migrateAutopilotAggregate(raw: AutopilotAggregateV1): AutopilotAggregateV1 {
  const phaseMap: Record<string, AutopilotPhase> = {
    requirements: 'deep-interview',
    planning: 'ralplan',
    executing: 'ultragoal',
    review: 'code-review',
    qa: 'ultraqa',
  };
  const phase = (phaseMap[raw.phase] ?? raw.phase) as AutopilotPhase;
  const lastActive = (phaseMap[raw.lastActivePhase] ?? raw.lastActivePhase) as AutopilotActivePhase;
  const handoff = raw.handoffArtifacts ?? emptyHandoffArtifacts();
  return {
    ...raw,
    phase,
    lastActivePhase: isActivePhase(lastActive) ? lastActive : 'deep-interview',
    phaseCycle: raw.phaseCycle ?? [
      'deep-interview', 'ralplan', 'ultragoal', 'code-review', 'ultraqa',
    ],
    iteration: typeof raw.iteration === 'number' ? raw.iteration : 1,
    reviewCycle: typeof raw.reviewCycle === 'number' ? raw.reviewCycle : 0,
    handoffArtifacts: {
      ...emptyHandoffArtifacts(),
      ...handoff,
      ralplanConsensusGate: {
        complete: handoff.ralplanConsensusGate?.complete ?? false,
        architectReview: handoff.ralplanConsensusGate?.architectReview ?? null,
        criticReview: handoff.ralplanConsensusGate?.criticReview ?? null,
      },
    },
    reviewVerdict: raw.reviewVerdict ?? null,
    qaVerdict: raw.qaVerdict ?? null,
    returnToRalplanReason: raw.returnToRalplanReason ?? null,
  };
}

function validateCandidate(
  current: Readonly<SessionAggregateV1>,
  candidate: Readonly<AggregateCandidate>,
): RuntimeError | undefined {
  if (
    candidate.aggregate.schemaVersion !== 1
    || candidate.aggregate.sessionId !== current.sessionId
    || candidate.aggregate.workspaceKey !== current.workspaceKey
    || candidate.aggregate.revision !== current.revision + 1
    || Object.keys(candidate.aggregate.processedStops).length !== Object.keys(current.processedStops).length
    || candidate.effect.beforeRevision !== current.revision
    || candidate.effect.afterRevision !== current.revision + 1
  ) {
    return runtimeError('E_REVISION_CONFLICT', 'Stop reducer violated the aggregate transaction contract');
  }
  return undefined;
}
