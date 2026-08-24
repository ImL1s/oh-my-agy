/**
 * 設計概念映射：OMA worker 協定的 CLI authority host。
 * OMC `inbox-outbox.ts` + `worker-activation-gate.ts`、OMX `$worker` + `omx team api`
 * ACK/mailbox/claim、OMG `omg worker own|prepare|seal` no-shell bridge —— 本模組把既有
 * `runWorkerProtocolLoop` 綁到 `TeamStateStore` + P0 `executeTeamApiOperation`，
 * 完成順序由程式決定，worker 無法靠 prompt 偽造完成。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WorkerEnvelopeV1, validateWorkerEnvelope } from '../contracts/worker-envelope';
import { canonicalJson, sha256 } from '../runtime/atomic';
import { RUNTIME_ERROR_CODES, RuntimeError, RuntimeErrorCode, runtimeError } from '../runtime/errors';
import { currentProcessIdentity } from '../runtime/process';
import { Result, err, ok } from '../runtime/types';
import { TeamApiEnvelope, executeTeamApiOperation } from './api-interop';
import { createDeliveryEvidence, DeliveryValidator, ValidatedDeliveryV1 } from './delivery';
import { IntegrationManager } from './integration';
import { FastForwardPublisherV1 } from './publisher';
import { TeamStateStore } from './state';
import {
  CanonicalTeamTaskV1,
  CommandEvidenceV1,
  DeliveryEvidenceV1,
  MailboxMessageV1,
  ProcessMarkerV1,
  TeamAggregateV1,
  WorkerAuthorityBindingV1,
  WorkerHeartbeatReceiptV1,
  WorkerPaneReceiptV1,
} from './types';
import { WorkerProvider } from '../contracts/worker-envelope';
import { resolveGitWorktreeIdentity } from './worktree';
import {
  VerificationOutcomeV1,
  WorkerLoopHost,
  WorkerLoopResultV1,
  runWorkerProtocolLoop,
} from './worker-loop';

const MISSING_VERIFICATION_EVIDENCE = 'Delivery is missing required verification command evidence';
const FENCE_MESSAGE = 'Task claim token or generation is stale';
const DEFAULT_LEASE_MS = 300_000;
const DEFAULT_DEADLINE_MS = 300_000;
const RUNTIME_RELATIVES = ['.oma-worker-ready', '.oma-worker-descriptor.json'] as const;

export interface TeamWorkerRuntimeOptions {
  store: TeamStateStore;
  teamId: string;
  taskId: string;
  claimToken: string;
  generation: number;
  worktreePath: string;
  leaderRepo?: string;
  managedWorktreesRoot?: string;
  nowMs?: () => number;
  leaseMs?: number;
  processMarker?: ProcessMarkerV1;
  pane?: WorkerPaneReceiptV1;
  provider?: WorkerProvider;
  providerReceiptHash?: string;
  capabilityPlaintextPath?: string;
  runVerification?: (
    argv: readonly string[],
    deadlineMs: number,
  ) => Promise<Result<VerificationOutcomeV1, RuntimeError>>;
}

interface PendingDeliveryV1 {
  handle: string;
  baseSha: string;
  orderedCommits: readonly string[];
  headSha: string;
  commandEvidenceIds: readonly string[];
  workerWorkspaceKey: string;
  workerWorktreeRealpath: string;
}

export class TeamWorkerRuntimeHost implements WorkerLoopHost {
  private interrupted = false;
  private readonly mailboxBodies = new Map<string, string>();
  private pendingDelivery: PendingDeliveryV1 | undefined;
  private acceptedDeliveryDigest: string | undefined;
  private signalDisposers: Array<() => void> = [];

  constructor(private readonly options: Readonly<TeamWorkerRuntimeOptions>) {}

  /** SIGTERM/SIGINT：拒絕後續 CAS；進行中的 atomic rename 要麼完整落地、要麼暫存檔清除。 */
  armInterruption(): void {
    const onSignal = (): void => {
      this.interrupted = true;
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    this.signalDisposers.push(() => {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    });
  }

  disarmInterruption(): void {
    for (const dispose of this.signalDisposers) dispose();
    this.signalDisposers = [];
  }

  /** 測試注入：模擬 pane 收到 SIGTERM 但 CAS 尚未開始。 */
  interrupt(): void {
    this.interrupted = true;
  }

  get interruptedForTest(): boolean {
    return this.interrupted;
  }

  /** 設計概念映射：OMX/OMG worker heartbeat；OMA 走 generation-fenced `recordWorkerHeartbeat`。 */
  async heartbeat(): Promise<Result<void, RuntimeError>> {
    const gated = this.assertWritable();
    if (!gated.ok) return gated;
    const bound = this.requireBoundIdentity();
    if (!bound.ok) return bound;
    const snapshot = this.snapshot();
    if (!snapshot.ok) return snapshot;
    const receipt: WorkerHeartbeatReceiptV1 = {
      schemaVersion: 1,
      taskId: this.options.taskId,
      claimTokenDigest: sha256(this.options.claimToken),
      generation: this.options.generation,
      provider: bound.value.provider,
      providerReceiptHash: bound.value.providerReceiptHash,
      ...(bound.value.process === undefined ? {} : { process: bound.value.process }),
      ...(bound.value.pane === undefined ? {} : { pane: bound.value.pane }),
      recordedAtMs: this.nowMs(),
    };
    const recorded = await this.options.store.recordWorkerHeartbeat(snapshot.value.revision, receipt);
    return recorded.ok ? ok(undefined) : err(recorded.error);
  }

  /** 經 P0 mailbox-list 讀取；bodies 快取供後續 readMailbox 對 digest。 */
  async listMailbox(cursor: number): Promise<Result<readonly MailboxMessageV1[], RuntimeError>> {
    const fenced = this.proveClaim();
    if (!fenced.ok) return fenced;
    const listed = await executeTeamApiOperation('mailbox-list', {
      worker: this.options.taskId,
      claim_token: this.options.claimToken,
      generation: this.options.generation,
      after_cursor: cursor,
    }, { store: this.options.store, nowMs: this.nowMs() });
    if (!listed.ok) return err(teamApiError(listed));
    const raw = listed.data.messages;
    if (!Array.isArray(raw)) {
      return err(runtimeError('E_CORRUPT_STATE', 'mailbox-list did not return messages'));
    }
    const messages: MailboxMessageV1[] = [];
    this.mailboxBodies.clear();
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return err(runtimeError('E_CORRUPT_STATE', 'mailbox-list message is not an object'));
      }
      const record = entry as Record<string, unknown>;
      const coerced = coerceMailboxMessage(record);
      if (!coerced.ok) return coerced;
      const body = typeof record.body === 'string' ? record.body : undefined;
      if (body === undefined) {
        return err(runtimeError('E_CORRUPT_STATE', 'Mailbox body missing from mailbox-list', {
          messageId: coerced.value.id,
        }));
      }
      this.mailboxBodies.set(coerced.value.id, body);
      messages.push(coerced.value);
    }
    return ok(messages);
  }

  async readMailbox(message: Readonly<MailboxMessageV1>): Promise<Result<string, RuntimeError>> {
    const fenced = this.proveClaim();
    if (!fenced.ok) return fenced;
    const cached = this.mailboxBodies.get(message.id);
    if (cached === undefined) {
      return err(runtimeError('E_CORRUPT_STATE', 'Mailbox body was not listed before read', {
        messageId: message.id,
      }));
    }
    return ok(cached);
  }

  /** 經 P0 mailbox-mark-delivered 前進 cursor；重複 ack 為幂等，禁止倒退。 */
  async acknowledgeMailbox(
    messageIds: readonly string[],
    nextCursor: number,
  ): Promise<Result<void, RuntimeError>> {
    const gated = this.assertWritable();
    if (!gated.ok) return gated;
    const fenced = this.proveClaim();
    if (!fenced.ok) return fenced;
    const snapshot = this.snapshot();
    if (!snapshot.ok) return snapshot;
    const cursor = (snapshot.value.value.mailboxCursors ?? {})[this.options.taskId];
    if (cursor === undefined || cursor.generation !== this.options.generation) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Mailbox cursor or worker capability is stale'));
    }
    if (cursor.cursor > nextCursor) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Mailbox acknowledgement cursor is stale or non-contiguous'));
    }
    if (cursor.cursor === nextCursor) {
      const alreadyAcked = messageIds.every((id) => {
        const message = snapshot.value.value.mailbox[id];
        return message !== undefined && message.acknowledgedAtMs !== undefined;
      });
      if (alreadyAcked || messageIds.length === 0) return ok(undefined);
      return err(runtimeError('E_REVISION_CONFLICT', 'Mailbox acknowledgement cursor is stale or non-contiguous'));
    }
    if (cursor.cursor + messageIds.length !== nextCursor) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Mailbox acknowledgement cursor is stale or non-contiguous'));
    }
    for (const messageId of messageIds) {
      const marked = await executeTeamApiOperation('mailbox-mark-delivered', {
        worker: this.options.taskId,
        message_id: messageId,
        claim_token: this.options.claimToken,
        generation: this.options.generation,
      }, { store: this.options.store, nowMs: this.nowMs() });
      if (!marked.ok) return err(teamApiError(marked));
    }
    const after = this.snapshot();
    if (!after.ok) return after;
    const advanced = (after.value.value.mailboxCursors ?? {})[this.options.taskId];
    if (advanced?.cursor !== nextCursor) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Mailbox acknowledgement cursor is stale or non-contiguous'));
    }
    return ok(undefined);
  }

  async recordProgress(
    kind: 'checkpoint' | 'artifact' | 'verification',
    artifactHash: string,
  ): Promise<Result<void, RuntimeError>> {
    const gated = this.assertWritable();
    if (!gated.ok) return gated;
    const bound = this.requireBoundIdentity();
    if (!bound.ok) return bound;
    const snapshot = this.snapshot();
    if (!snapshot.ok) return snapshot;
    const task = snapshot.value.value.tasks[this.options.taskId];
    if (task === undefined) {
      return err(runtimeError('E_NOT_FOUND', 'Team task does not exist', { taskId: this.options.taskId }));
    }
    const child = bound.value.process ?? this.processMarker();
    const recorded = await this.options.store.recordProgress(snapshot.value.revision, {
      schemaVersion: 1,
      taskId: this.options.taskId,
      taskRevision: task.revision,
      claimToken: this.options.claimToken,
      generation: this.options.generation,
      kind,
      artifactDigest: artifactHash,
      child,
      recordedAtMs: this.nowMs(),
      providerReceiptHash: bound.value.providerReceiptHash,
    }, this.leaseMs());
    return recorded.ok ? ok(undefined) : err(recorded.error);
  }

  /** WorkerExecutionState 只能依法定邊前進；亂序回 E_REVISION_CONFLICT。 */
  async transition(
    expected: 'claimed' | 'launched' | 'running' | 'verifying' | 'delivery_ready',
    next: 'launched' | 'running' | 'verifying' | 'delivery_ready' | 'integration_requested',
  ): Promise<Result<void, RuntimeError>> {
    const gated = this.assertWritable();
    if (!gated.ok) return gated;
    const bound = this.requireBoundIdentity();
    if (!bound.ok) return bound;
    if (bound.value.state !== expected) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Worker authority transition is stale or illegal', {
        taskId: this.options.taskId,
        generation: this.options.generation,
        expected,
        actual: bound.value.state,
      }));
    }
    const snapshot = this.snapshot();
    if (!snapshot.ok) return snapshot;
    const moved = await this.options.store.transitionWorkerAuthority({
      expectedRevision: snapshot.value.revision,
      taskId: this.options.taskId,
      claimToken: this.options.claimToken,
      generation: this.options.generation,
      providerReceiptHash: bound.value.providerReceiptHash,
      expectedState: expected,
      expectedSequence: bound.value.transitionSequence,
      nextState: next,
    });
    return moved.ok ? ok(undefined) : err(moved.error);
  }

  /** 驗證命令一律 spawnSync + argv；禁止 shell 字串（CLAUDE.md）。 */
  async runVerification(
    argv: readonly string[],
    deadlineMs: number,
  ): Promise<Result<VerificationOutcomeV1, RuntimeError>> {
    const fenced = this.proveClaim();
    if (!fenced.ok) return fenced;
    if (this.options.runVerification !== undefined) {
      return this.options.runVerification(argv, deadlineMs);
    }
    if (argv.length === 0) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'Verification argv must be a non-empty vector'));
    }
    const started = Date.now();
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: this.options.worktreePath,
      encoding: 'utf8',
      env: process.env,
      shell: false,
      timeout: deadlineMs,
      killSignal: 'SIGTERM',
    });
    const finished = Date.now();
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const exitCode = typeof result.status === 'number' ? result.status : 1;
    return ok({
      argv,
      exitCode,
      stdoutHash: sha256(stdout),
      stderrHash: sha256(stderr),
      artifactHash: sha256(canonicalJson({
        argv,
        exitCode,
        durationMs: Math.max(0, finished - started),
      })),
    });
  }

  /** 驗證證據寫入 store；缺此紀錄則 createImmutableDelivery 必拒。 */
  async recordCommandEvidence(outcome: Readonly<VerificationOutcomeV1>): Promise<Result<void, RuntimeError>> {
    const gated = this.assertWritable();
    if (!gated.ok) return gated;
    const bound = this.requireBoundIdentity();
    if (!bound.ok) return bound;
    const snapshot = this.snapshot();
    if (!snapshot.ok) return snapshot;
    const finishedAtMs = this.nowMs();
    const startedAtMs = Math.max(0, finishedAtMs - 1);
    const evidence: CommandEvidenceV1 = {
      schemaVersion: 1,
      commandId: sha256(canonicalJson({ argv: outcome.argv, generation: this.options.generation })),
      taskId: this.options.taskId,
      claimToken: this.options.claimToken,
      generation: this.options.generation,
      argvDigest: sha256(canonicalJson(outcome.argv)),
      process: bound.value.process ?? this.processMarker(),
      startedAtMs,
      finishedAtMs,
      deadlineMs: DEFAULT_DEADLINE_MS,
      exitCode: outcome.exitCode,
      artifactDigest: outcome.artifactHash,
      outputDigest: sha256(`${outcome.stdoutHash}:${outcome.stderrHash}`),
      providerReceiptHash: bound.value.providerReceiptHash,
    };
    const recorded = await this.options.store.recordCommandEvidence(
      snapshot.value.revision,
      evidence,
      this.leaseMs(),
    );
    return recorded.ok ? ok(undefined) : err(recorded.error);
  }

  /**
   * 缺驗證證據時必須以穩定碼 E_DELIVERY_UNINTEGRATED 拒絕，且不得寫入 aggregate。
   * 回傳的 digest 是 git 證據 handle；accept 時再綁當下 task.revision。
   */
  async createImmutableDelivery(): Promise<Result<{ deliveryDigest: string }, RuntimeError>> {
    const gated = this.assertWritable();
    if (!gated.ok) return gated;
    const fenced = this.proveClaim();
    if (!fenced.ok) return fenced;
    const snapshot = this.snapshot();
    if (!snapshot.ok) return snapshot;
    const aggregate = snapshot.value.value;
    const task = aggregate.tasks[this.options.taskId];
    const spec = aggregate.manifest.tasks.find((entry) => entry.id === this.options.taskId);
    if (task === undefined || spec === undefined) {
      return err(runtimeError('E_NOT_FOUND', 'Team task does not exist', { taskId: this.options.taskId }));
    }
    const commandEvidenceIds = Object.keys(task.commandEvidence);
    if (spec.verification.commands.length > commandEvidenceIds.length) {
      return err(runtimeError('E_DELIVERY_UNINTEGRATED', MISSING_VERIFICATION_EVIDENCE, {
        required: spec.verification.commands.length,
        recorded: commandEvidenceIds.length,
      }));
    }
    const cleaned = cleanWorkerRuntimeFiles(this.options.worktreePath);
    if (!cleaned.ok) return cleaned;
    const baseSha = readManagedBaseSha(this.options.worktreePath);
    if (!baseSha.ok) return baseSha;
    const head = gitRevParse(this.options.worktreePath);
    if (!head.ok) return head;
    const commits = gitFirstParentRange(this.options.worktreePath, baseSha.value, head.value);
    if (!commits.ok) return commits;
    if (commits.value.length === 0) {
      return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'No commits to deliver'));
    }
    let workerWorkspaceKey: string;
    let worktreeRealpath: string;
    try {
      const identity = resolveGitWorktreeIdentity(this.options.worktreePath);
      workerWorkspaceKey = identity.workspaceKey;
      worktreeRealpath = identity.canonicalRealpath;
    } catch (error) {
      return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Worker worktree identity failed', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
    const evidence = createDeliveryEvidence({
      taskId: this.options.taskId,
      taskRevision: task.revision,
      manifestRevision: aggregate.manifest.revision,
      claimToken: this.options.claimToken,
      generation: this.options.generation,
      baseSha: baseSha.value,
      orderedCommits: commits.value,
      headSha: head.value,
      commandEvidenceIds,
      workerWorkspaceKey,
      workerWorktreeRealpath: worktreeRealpath,
    });
    if (!evidence.ok) return evidence;
    const validated = this.validateDelivery(evidence.value, spec, task.revision, aggregate);
    if (!validated.ok) return validated;
    const pending: PendingDeliveryV1 = {
      handle: sha256(canonicalJson({
        baseSha: baseSha.value,
        orderedCommits: commits.value,
        headSha: head.value,
        commandEvidenceIds,
        workerWorktreeRealpath: worktreeRealpath,
      })),
      baseSha: baseSha.value,
      orderedCommits: commits.value,
      headSha: head.value,
      commandEvidenceIds,
      workerWorkspaceKey,
      workerWorktreeRealpath: worktreeRealpath,
    };
    this.pendingDelivery = pending;
    return ok({ deliveryDigest: pending.handle });
  }

  async requestIntegration(deliveryDigest: string): Promise<Result<{ integrationReceiptHash: string }, RuntimeError>> {
    const gated = this.assertWritable();
    if (!gated.ok) return gated;
    const fenced = this.proveClaim();
    if (!fenced.ok) return fenced;
    const pending = this.pendingDelivery;
    if (pending === undefined || pending.handle !== deliveryDigest) {
      return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Immutable delivery evidence is not ready for integration'));
    }
    const snapshot = this.snapshot();
    if (!snapshot.ok) return snapshot;
    const aggregate = snapshot.value.value;
    const task = aggregate.tasks[this.options.taskId];
    const spec = aggregate.manifest.tasks.find((entry) => entry.id === this.options.taskId);
    if (task === undefined || spec === undefined) {
      return err(runtimeError('E_NOT_FOUND', 'Team task does not exist', { taskId: this.options.taskId }));
    }
    // recordProgress 會推進 task.revision；在 accept 當下重綁 revision，digest handle 仍指向同一 git 證據。
    const evidence = createDeliveryEvidence({
      taskId: this.options.taskId,
      taskRevision: task.revision,
      manifestRevision: aggregate.manifest.revision,
      claimToken: this.options.claimToken,
      generation: this.options.generation,
      baseSha: pending.baseSha,
      orderedCommits: pending.orderedCommits,
      headSha: pending.headSha,
      commandEvidenceIds: pending.commandEvidenceIds,
      workerWorkspaceKey: pending.workerWorkspaceKey,
      workerWorktreeRealpath: pending.workerWorktreeRealpath,
    });
    if (!evidence.ok) return evidence;
    const validated = this.validateDelivery(evidence.value, spec, task.revision, aggregate);
    if (!validated.ok) return validated;
    const accepted = await this.options.store.acceptDelivery(snapshot.value.revision, evidence.value);
    if (!accepted.ok) return err(accepted.error);
    const leaderRepoResult = this.options.leaderRepo !== undefined
      ? ok(this.options.leaderRepo)
      : inferLeaderRepo(this.options.worktreePath);
    if (!leaderRepoResult.ok) return err(leaderRepoResult.error);
    const leaderRepo = leaderRepoResult.value;
    const managedRoot = this.options.managedWorktreesRoot
      ?? path.resolve(this.options.store.teamDirectory(), '..', '..', '..', 'managed-worktrees');
    const prepared = new IntegrationManager(managedRoot).prepare({
      leaderRepo,
      stateRevision: accepted.value.revision,
      ownerNonce: accepted.value.value.ownerNonce,
      delivery: validated.value,
    });
    if (!prepared.ok) return prepared;
    const published = await new FastForwardPublisherV1().publishCheckedOutRef(prepared.value);
    if (!published.ok) return published;
    // markIntegrated 會清 claim，必須留到 terminal(completed)；否則 loop 的
    // delivery_ready → integration_requested 會被 fencing 擋住。
    this.acceptedDeliveryDigest = validated.value.deliveryDigest;
    const integrationReceiptHash = sha256(canonicalJson({
      deliveryDigest: validated.value.deliveryDigest,
      integrationTip: published.value.integrationTip ?? '',
      revision: accepted.value.revision,
    }));
    return ok({ integrationReceiptHash });
  }

  async cleanupCapabilityPlaintext(): Promise<Result<void, RuntimeError>> {
    const target = this.options.capabilityPlaintextPath
      ?? path.join(this.options.worktreePath, '.oma', 'worker-capability.json');
    try {
      fs.rmSync(target, { force: true });
    } catch (error) {
      return err(runtimeError('E_CORRUPT_STATE', 'Capability plaintext could not be removed', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
    return ok(undefined);
  }

  async terminal(
    outcome: 'completed' | 'failed' | 'cancelled',
    materialHash: string,
  ): Promise<Result<void, RuntimeError>> {
    void materialHash;
    const gated = this.assertWritable();
    if (!gated.ok) return gated;
    let snapshot = this.snapshot();
    if (!snapshot.ok) return snapshot;
    if (outcome === 'completed' && this.acceptedDeliveryDigest !== undefined) {
      const task = snapshot.value.value.tasks[this.options.taskId];
      if (task?.status === 'delivered_unintegrated') {
        const integrated = await this.options.store.markIntegrated(
          this.options.taskId,
          snapshot.value.revision,
          this.acceptedDeliveryDigest,
        );
        if (!integrated.ok) return err(integrated.error);
        snapshot = integrated;
      }
    }
    const binding = (snapshot.value.value.workerBindings ?? {})[this.options.taskId];
    if (binding === undefined || binding.generation !== this.options.generation) {
      return err(runtimeError('E_TERMINAL_STATE', 'Terminal receipt is stale, foreign, or precedes capability cleanup'));
    }
    if (binding.state === 'terminal') {
      return err(runtimeError('E_TERMINAL_STATE', 'Worker is already terminal'));
    }
    const recorded = await this.options.store.terminalizeWorker({
      expectedRevision: snapshot.value.revision,
      claimToken: this.options.claimToken,
      expectedState: binding.state,
      expectedSequence: binding.transitionSequence,
      receipt: {
        schemaVersion: 1,
        taskId: this.options.taskId,
        generation: this.options.generation,
        provider: binding.provider,
        providerReceiptHash: binding.providerReceiptHash,
        transitionSequence: binding.transitionSequence + 1,
        outcome,
        ...(outcome === 'completed' && this.acceptedDeliveryDigest !== undefined
          ? { deliveryDigest: this.acceptedDeliveryDigest }
          : {}),
        capabilityPlaintextRemoved: true,
        recordedAtMs: this.nowMs(),
      },
    });
    return recorded.ok ? ok(undefined) : err(recorded.error);
  }

  /** 只讀 fencing；錯誤 token/generation 不得觸發 CAS。 */
  proveClaim(): Result<void, RuntimeError> {
    const snapshot = this.options.store.read();
    if (!snapshot.ok) return snapshot;
    const task = snapshot.value.value.tasks[this.options.taskId];
    if (task === undefined) {
      return err(runtimeError('E_NOT_FOUND', 'Team task does not exist', { taskId: this.options.taskId }));
    }
    if (task.claim?.token !== this.options.claimToken || task.claim.generation !== this.options.generation) {
      return err(runtimeError('E_REVISION_CONFLICT', FENCE_MESSAGE, {
        taskId: this.options.taskId,
        generation: this.options.generation,
      }));
    }
    return ok(undefined);
  }

  /** 若尚無 claimed binding 則寫入；已存在則只核對 generation。 */
  async ensureBound(): Promise<Result<WorkerAuthorityBindingV1, RuntimeError>> {
    const gated = this.assertWritable();
    if (!gated.ok) return gated;
    const fenced = this.proveClaim();
    if (!fenced.ok) return fenced;
    const existing = this.requireBoundIdentity();
    if (existing.ok) return existing;
    if (existing.error.code !== 'E_NOT_FOUND') return existing;
    const snapshot = this.snapshot();
    if (!snapshot.ok) return snapshot;
    const processMarker = this.processMarker();
    // tmux pane 啟動時 heartbeat 可能尚未落盤；沒有 pane receipt 時以 process-only
    // agy_headless binding 跑協定（OMC/OMX worker 仍以 CLI 為 authority）。
    const provider = this.options.pane !== undefined
      ? (this.options.provider ?? 'tmux_agy')
      : 'agy_headless';
    if (provider === 'antigravity_native') {
      return err(runtimeError('E_NATIVE_ADAPTER_UNAVAILABLE', 'Antigravity native worker adapter is unavailable'));
    }
    const binding: WorkerAuthorityBindingV1 = {
      schemaVersion: 1,
      taskId: this.options.taskId,
      claimTokenDigest: sha256(this.options.claimToken),
      generation: this.options.generation,
      provider,
      providerReceiptHash: this.options.providerReceiptHash
        ?? sha256(`oma-worker:${this.options.teamId}:${this.options.taskId}:${this.options.generation}`),
      process: processMarker,
      ...(this.options.pane === undefined ? {} : { pane: this.options.pane }),
      ...(provider === 'tmux_agy' ? { readinessPhase: 'pane_created' as const } : {}),
      state: 'claimed',
      transitionSequence: 0,
      boundAtMs: this.nowMs(),
    };
    const bound = await this.options.store.bindWorkerAuthority(
      snapshot.value.revision,
      this.options.claimToken,
      binding,
    );
    if (!bound.ok) return err(bound.error);
    const stored = bound.value.value.workerBindings?.[this.options.taskId];
    if (stored === undefined) {
      return err(runtimeError('E_CORRUPT_STATE', 'Worker authority binding did not persist'));
    }
    return ok(stored);
  }

  private assertWritable(): Result<void, RuntimeError> {
    if (this.interrupted) {
      return err(runtimeError('E_TERMINAL_STATE', 'Worker interrupted before CAS completed'));
    }
    return ok(undefined);
  }

  private snapshot() {
    return this.options.store.read();
  }

  private requireBoundIdentity(): Result<WorkerAuthorityBindingV1, RuntimeError> {
    const fenced = this.proveClaim();
    if (!fenced.ok) return fenced;
    const snapshot = this.options.store.read();
    if (!snapshot.ok) return snapshot;
    const binding = (snapshot.value.value.workerBindings ?? {})[this.options.taskId];
    if (binding === undefined) {
      return err(runtimeError('E_NOT_FOUND', 'Worker authority binding does not exist', {
        taskId: this.options.taskId,
      }));
    }
    if (binding.generation !== this.options.generation
      || binding.claimTokenDigest !== sha256(this.options.claimToken)) {
      return err(runtimeError('E_REVISION_CONFLICT', FENCE_MESSAGE, {
        taskId: this.options.taskId,
        generation: this.options.generation,
      }));
    }
    return ok(binding);
  }

  private processMarker(): ProcessMarkerV1 {
    if (this.options.processMarker !== undefined) return this.options.processMarker;
    const identity = currentProcessIdentity();
    return { pid: identity.pid, startMarker: identity.startMarker };
  }

  private nowMs(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  private leaseMs(): number {
    return this.options.leaseMs ?? DEFAULT_LEASE_MS;
  }

  private validateDelivery(
    evidence: DeliveryEvidenceV1,
    spec: CanonicalTeamTaskV1,
    taskRevision: number,
    aggregate: TeamAggregateV1,
  ): Result<ValidatedDeliveryV1, RuntimeError> {
    const completedDeps = new Set(
      Object.values(aggregate.tasks)
        .filter((entry) => entry.status === 'completed')
        .map((entry) => entry.id),
    );
    return new DeliveryValidator().validate(evidence, {
      task: spec,
      currentTaskRevision: taskRevision,
      manifestRevision: aggregate.manifest.revision,
      claimToken: this.options.claimToken,
      generation: this.options.generation,
      completedDependencies: completedDeps,
      commandEvidenceIds: new Set(Object.keys(aggregate.tasks[this.options.taskId]?.commandEvidence ?? {})),
    });
  }
}

export function proveTeamWorkerClaim(
  store: TeamStateStore,
  taskId: string,
  claimToken: string,
  generation: number,
): Result<void, RuntimeError> {
  return new TeamWorkerRuntimeHost({
    store,
    teamId: 'unused',
    taskId,
    claimToken,
    generation,
    worktreePath: process.cwd(),
  }).proveClaim();
}

export function buildWorkerRuntimeEnvelope(
  store: TeamStateStore,
  input: {
    teamId: string;
    taskId: string;
    claimToken: string;
    generation: number;
  },
): Result<WorkerEnvelopeV1, RuntimeError> {
  const snapshot = store.read();
  if (!snapshot.ok) return snapshot;
  const aggregate = snapshot.value.value;
  const spec = aggregate.manifest.tasks.find((entry) => entry.id === input.taskId);
  const runtime = aggregate.tasks[input.taskId];
  if (spec === undefined || runtime === undefined) {
    return err(runtimeError('E_NOT_FOUND', 'Team task does not exist', { taskId: input.taskId }));
  }
  if (runtime.claim?.token !== input.claimToken || runtime.claim.generation !== input.generation) {
    return err(runtimeError('E_REVISION_CONFLICT', FENCE_MESSAGE, {
      taskId: input.taskId,
      generation: input.generation,
    }));
  }
  const binding = (aggregate.workerBindings ?? {})[input.taskId];
  const cursor = (aggregate.mailboxCursors ?? {})[input.taskId]?.cursor ?? 0;
  const dependencies: WorkerEnvelopeV1['dependencies'] = [];
  for (const dependencyId of spec.dependencies) {
    const dependency = aggregate.tasks[dependencyId];
    if (dependency?.status !== 'completed' || dependency.resultHash === undefined) {
      return err(runtimeError('E_TASK_DEPENDENCY_BLOCKED', 'Worker envelope requires exact ordered dependency results', {
        dependency: dependencyId,
      }));
    }
    dependencies.push({
      task_id: dependencyId,
      result_hash: dependency.resultHash,
      artifact_roots: dependency.artifactRoots !== undefined && dependency.artifactRoots.length > 0
        ? [...dependency.artifactRoots]
        : [`artifacts/${dependencyId}`],
    });
  }
  const writeScope = spec.write_scope === 'none' ? [] : spec.write_scope.map((entry) => entry.path);
  const verificationArgv = spec.verification.commands.map((command) => [command.command, ...command.argv]);
  const deadlines = spec.verification.commands.map((command) => command.deadlineMs);
  const deadlineMs = deadlines.length === 0 ? DEFAULT_DEADLINE_MS : Math.max(...deadlines);
  const envelope: WorkerEnvelopeV1 = {
    store_kind: 'oma_worker_envelope',
    schema_version: 1,
    repository_id: 'OMA',
    run_id: input.teamId,
    team_id: input.teamId,
    task_id: input.taskId,
    task_text: spec.description ?? spec.subject ?? `Execute team task ${input.taskId}`,
    dependencies,
    write_scope: writeScope,
    verification_argv: verificationArgv,
    artifact_contract: {
      proposal_root: `artifacts/${input.taskId}`,
      required_files: [...spec.verification.requiredArtifacts],
      terminal_receipt_path: `artifacts/${input.taskId}/terminal.json`,
    },
    contributor_guidance_hashes: [],
    mailbox_cursor: cursor,
    claim_id: sha256(input.claimToken),
    generation: input.generation,
    state_endpoint: `oma://team/${input.teamId}/task/${input.taskId}`,
    cancellation_token_hash: sha256(input.claimToken),
    provider: binding?.provider ?? 'agy_headless',
    native_role: spec.role ?? 'executor',
    capability_mode: spec.write_scope === 'none' ? 'read-only' : 'read-write',
    deadline_ms: deadlineMs > 86_400_000 ? 86_400_000 : Math.max(1, deadlineMs),
  };
  try {
    return ok(validateWorkerEnvelope(envelope));
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'Worker envelope failed the frozen v1 contract', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

/** 設計概念映射：OMC/OMX worker 進入點；先 fencing 再跑 loop。 */
export async function runTeamWorker(
  options: Readonly<TeamWorkerRuntimeOptions>,
): Promise<Result<WorkerLoopResultV1, RuntimeError>> {
  const host = new TeamWorkerRuntimeHost(options);
  const fenced = host.proveClaim();
  if (!fenced.ok) return fenced;
  const bound = await host.ensureBound();
  if (!bound.ok) return bound;
  const envelope = buildWorkerRuntimeEnvelope(options.store, {
    teamId: options.teamId,
    taskId: options.taskId,
    claimToken: options.claimToken,
    generation: options.generation,
  });
  if (!envelope.ok) return envelope;
  host.armInterruption();
  try {
    return await runWorkerProtocolLoop(envelope.value, host);
  } finally {
    host.disarmInterruption();
  }
}

function teamApiError(envelope: Extract<TeamApiEnvelope, { ok: false }>): RuntimeError {
  const details = envelope.error.details;
  const code = envelope.error.code;
  if ((RUNTIME_ERROR_CODES as readonly string[]).includes(code)) {
    return runtimeError(code as RuntimeErrorCode, envelope.error.message, details);
  }
  if (code === 'E_TEAM_API_INVALID_INPUT') {
    return runtimeError('E_VALIDATOR_REJECTED', envelope.error.message, details);
  }
  return runtimeError('E_CORRUPT_STATE', envelope.error.message, {
    ...details,
    teamApiCode: code,
  });
}

function coerceMailboxMessage(record: Record<string, unknown>): Result<MailboxMessageV1, RuntimeError> {
  const id = stringField(record, 'id') ?? stringField(record, 'message_id');
  const sender = stringField(record, 'sender') ?? stringField(record, 'from_worker');
  const recipient = stringField(record, 'recipient') ?? stringField(record, 'to_worker');
  const bodyDigest = stringField(record, 'body_digest') ?? stringField(record, 'bodyDigest');
  const createdAtMs = numberField(record, 'created_at_ms') ?? numberField(record, 'createdAtMs');
  if (id === undefined || sender === undefined || recipient === undefined
    || bodyDigest === undefined || createdAtMs === undefined) {
    return err(runtimeError('E_CORRUPT_STATE', 'Mailbox message fields are incomplete'));
  }
  const sequence = numberField(record, 'sequence');
  const generation = numberField(record, 'generation');
  const deliveredAtMs = numberField(record, 'delivered_at_ms') ?? numberField(record, 'deliveredAtMs');
  const acknowledgedAtMs = numberField(record, 'acknowledged_at_ms') ?? numberField(record, 'acknowledgedAtMs');
  return ok({
    schemaVersion: 1,
    id,
    sender,
    recipient,
    bodyDigest,
    createdAtMs,
    ...(deliveredAtMs === undefined ? {} : { deliveredAtMs }),
    ...(sequence === undefined ? {} : { sequence }),
    ...(generation === undefined ? {} : { generation }),
    ...(acknowledgedAtMs === undefined ? {} : { acknowledgedAtMs }),
  });
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function cleanWorkerRuntimeFiles(worktreePath: string): Result<void, RuntimeError> {
  for (const relative of RUNTIME_RELATIVES) {
    try { fs.rmSync(path.join(worktreePath, relative), { force: true }); } catch (_) { /* best-effort */ }
  }
  try { fs.rmSync(path.join(worktreePath, '.oma'), { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  return ok(undefined);
}

function readManagedBaseSha(worktreePath: string): Result<string, RuntimeError> {
  const markerPath = `${worktreePath}.owner.json`;
  if (!fs.existsSync(markerPath)) {
    return err(runtimeError('E_CORRUPT_STATE', 'Managed worktree owner marker baseSha is missing'));
  }
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { baseSha?: string };
    if (typeof marker.baseSha !== 'string' || marker.baseSha === '') {
      return err(runtimeError('E_CORRUPT_STATE', 'Managed worktree owner marker baseSha is missing'));
    }
    return ok(marker.baseSha);
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'Managed worktree owner marker is unreadable', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

function gitRevParse(cwd: string): Result<string, RuntimeError> {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    return err(runtimeError('E_RETRYABLE_BLOCKER', 'Unable to resolve worker HEAD', {
      stderr: result.stderr,
    }));
  }
  return ok(result.stdout.trim());
}

function gitFirstParentRange(
  cwd: string,
  baseSha: string,
  headSha: string,
): Result<string[], RuntimeError> {
  const result = spawnSync(
    'git',
    ['rev-list', '--reverse', '--first-parent', `${baseSha}..${headSha}`],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    return err(runtimeError('E_RETRYABLE_BLOCKER', 'Unable to list delivery commits', {
      stderr: result.stderr,
    }));
  }
  const commits = result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n');
  return ok(commits);
}

function inferLeaderRepo(worktreePath: string): Result<string, RuntimeError> {
  try {
    const identity = resolveGitWorktreeIdentity(worktreePath);
    if (identity.gitCommonDir.endsWith(`${path.sep}.git`)) {
      return ok(path.dirname(identity.gitCommonDir));
    }
    return ok(path.dirname(identity.gitCommonDir));
  } catch (error) {
    return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Leader repository cannot be inferred from worker worktree', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}
