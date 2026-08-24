import * as fs from 'fs';
import * as path from 'path';
import { canonicalJson, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { acquireOwnerLock, releaseOwnerLock } from '../runtime/lock';
import { StateStore } from '../runtime/state-store';
import { Result, Snapshot, err, ok } from '../runtime/types';
import {
  isWorkerReadinessPhaseV1,
  readinessPhaseForExecutionState,
  withMonotonicReadinessPhase,
} from './provider-readiness';
import {
  AgentProgressV1,
  CanonicalTeamManifestV1,
  CommandEvidenceV1,
  DeliveryEvidenceV1,
  MailboxMessageV1,
  MailboxCursorV1,
  SupervisorHeartbeatV1,
  TeamAggregateV1,
  TeamSupervisorAuthorityV1,
  TeamTaskRuntimeV1,
  TeamTaskStatus,
  WorkerAuthorityBindingV1,
  WorkerExecutionStateV1,
  WorkerHeartbeatReceiptV1,
  WorkerTerminalReceiptV1,
} from './types';

export class TeamStateStore {
  readonly key: string;
  private readonly stateRoot: string;
  private readonly store: StateStore<TeamAggregateV1>;
  private readonly repoKey: string | null;
  private readonly workspaceKey: string;

  constructor(stateRoot: string, repoKey: string | null, workspaceKey: string, teamId: string) {
    this.stateRoot = path.resolve(stateRoot);
    this.repoKey = repoKey;
    this.workspaceKey = workspaceKey;
    const partition = repoKey === null ? `workspaces/${workspaceKey}/teams-readonly` : `repositories/${repoKey}/teams`;
    this.key = `${partition}/${teamId}/aggregate`;
    this.store = new StateStore<TeamAggregateV1>(stateRoot);
  }

  /**
   * Remove a just-created launch aggregate only when both owner and revision
   * still match. This is the abort half of startFromManifest's transaction;
   * concurrent progress makes deletion fail closed.
   */
  async rollbackLaunch(
    expectedRevision: number,
    ownerNonce: string,
  ): Promise<Result<void, RuntimeError>> {
    const target = path.resolve(this.stateRoot, `${this.key}.json`);
    if (target !== this.stateRoot && !target.startsWith(`${this.stateRoot}${path.sep}`)) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Team rollback target escapes state root'));
    }
    const lock = await acquireOwnerLock(`${target}.lock`);
    if (!lock.ok) return lock;
    try {
      const snapshot = this.store.read(this.key);
      if (!snapshot.ok) return snapshot;
      if (snapshot.value.revision !== expectedRevision
        || snapshot.value.value.ownerNonce !== ownerNonce) {
        return err(runtimeError('E_REVISION_CONFLICT', 'Team launch rollback fence changed', {
          expectedRevision,
          actualRevision: snapshot.value.revision,
        }));
      }
      fs.unlinkSync(target);
      return ok(undefined);
    } catch (error) {
      return err(runtimeError('E_CORRUPT_STATE', 'Team launch rollback failed', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      releaseOwnerLock(lock.value);
    }
  }

  create(
    manifest: CanonicalTeamManifestV1,
    ownerNonce: string,
    repoKey: string | null = this.repoKey,
    leaderWorkspaceKey: string = this.workspaceKey,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const tasks: Record<string, TeamTaskRuntimeV1> = {};
    for (const task of manifest.tasks) {
      tasks[task.id] = { id: task.id, revision: 0, status: 'pending', commandEvidence: {} };
    }
    return this.store.create(this.key, {
      schemaVersion: 1,
      teamId: manifest.teamId,
      repoKey,
      leaderWorkspaceKey,
      ownerNonce,
      manifest,
      tasks,
      heartbeats: {},
      mailbox: {},
      workerBindings: {},
      mailboxCursors: {},
      terminalReceipts: {},
    });
  }

  read(): Result<Snapshot<TeamAggregateV1>, RuntimeError> {
    return this.store.read(this.key);
  }

  async claimTask(
    taskId: string,
    ownerId: string,
    expectedRevision: number,
    nowMs: number,
    leaseMs: number,
    claimToken: string,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireRevision(expectedRevision);
    if (!before.ok) return before;
    const task = before.value.value.tasks[taskId];
    if (task === undefined) return err(runtimeError('E_NOT_FOUND', 'Team task does not exist', { taskId }));
    const specification = before.value.value.manifest.tasks.find((entry) => entry.id === taskId)!;
    const blocked = specification.dependencies.find((dependency) => before.value.value.tasks[dependency]?.status !== 'completed');
    if (blocked !== undefined) {
      return err(runtimeError('E_TASK_DEPENDENCY_BLOCKED', 'Task dependency is not completed', { taskId, dependency: blocked }));
    }
    if (task.claim !== undefined) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Task retains an active or identity-unproven claim', {
        taskId,
        generation: task.claim.generation,
      }));
    }
    if (!['pending', 'awaiting_interaction', 'orphan_identity_unproven'].includes(task.status)) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Task is not claimable in its current state', { taskId, status: task.status }));
    }
    const generation = (task.lastClaimGeneration ?? 0) + 1;
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => updateTask(current, taskId, (entry) => ({
      ...entry,
      revision: entry.revision + 1,
      status: 'in_progress',
      claim: { ownerId, token: claimToken, generation, leasedUntilMs: nowMs + leaseMs },
      lastClaimGeneration: generation,
    })));
  }

  /**
   * Abort one failed worker launch without deleting the Team aggregate.
   * The claim token/generation/revision fence prevents a late rollback from
   * clearing authority that has already advanced or been reclaimed.
   */
  async rollbackTaskLaunch(input: {
    expectedRevision: number;
    taskId: string;
    claimToken: string;
    generation: number;
    ownerNonce: string;
  }): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireClaim(
      input.taskId,
      input.expectedRevision,
      input.claimToken,
      input.generation,
    );
    if (!before.ok) return before;
    if (before.value.value.ownerNonce !== input.ownerNonce) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Team launch rollback owner changed'));
    }
    return this.store.compareAndSwap(this.key, input.expectedRevision, (current) => {
      const heartbeats = { ...current.heartbeats };
      const workerBindings = { ...(current.workerBindings ?? {}) };
      const mailboxCursors = { ...(current.mailboxCursors ?? {}) };
      const terminalReceipts = { ...(current.terminalReceipts ?? {}) };
      delete heartbeats[input.taskId];
      delete workerBindings[input.taskId];
      delete mailboxCursors[input.taskId];
      delete terminalReceipts[input.taskId];
      return updateTask({
        ...current,
        heartbeats,
        workerBindings,
        mailboxCursors,
        terminalReceipts,
      }, input.taskId, (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        status: 'pending',
        claim: undefined,
        lastProgress: undefined,
      }));
    });
  }

  async bindWorkerAuthority(
    expectedRevision: number,
    claimToken: string,
    binding: WorkerAuthorityBindingV1,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireClaim(binding.taskId, expectedRevision, claimToken, binding.generation);
    if (!before.ok) return before;
    const task = before.value.value.tasks[binding.taskId];
    const invalid = validateWorkerBinding(binding, task.revision, claimToken);
    if (invalid !== null) return err(invalid);
    const existing = (before.value.value.workerBindings ?? {})[binding.taskId];
    if (existing !== undefined) {
      if (canonicalJson(existing) === canonicalJson(binding)) return before;
      if (existing.generation >= binding.generation) {
        return err(runtimeError('E_REVISION_CONFLICT', 'Worker provider binding is stale or conflicts'));
      }
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => ({
      ...current,
      workerBindings: {
        ...(current.workerBindings ?? {}),
        [binding.taskId]: binding,
      },
      mailboxCursors: {
        ...(current.mailboxCursors ?? {}),
        [binding.taskId]: {
          schemaVersion: 1,
          taskId: binding.taskId,
          generation: binding.generation,
          cursor: 0,
          acknowledgedAtMs: binding.boundAtMs,
        },
      },
    }));
  }

  async transitionWorkerAuthority(input: {
    expectedRevision: number;
    taskId: string;
    claimToken: string;
    generation: number;
    providerReceiptHash: string;
    expectedState: WorkerExecutionStateV1;
    expectedSequence: number;
    nextState: Exclude<WorkerExecutionStateV1, 'claimed' | 'terminal'>;
  }): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireClaim(
      input.taskId,
      input.expectedRevision,
      input.claimToken,
      input.generation,
    );
    if (!before.ok) return before;
    const binding = (before.value.value.workerBindings ?? {})[input.taskId];
    if (!matchesBinding(binding, input.generation, input.providerReceiptHash)
      || binding!.state !== input.expectedState
      || binding!.transitionSequence !== input.expectedSequence
      || !transitionAllowed(input.expectedState, input.nextState)) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Worker authority transition is stale or illegal', {
        taskId: input.taskId,
        generation: input.generation,
      }));
    }
    const nextPhase = readinessPhaseForExecutionState(input.nextState);
    const nextBinding: WorkerAuthorityBindingV1 = {
      ...binding!,
      state: input.nextState,
      transitionSequence: input.expectedSequence + 1,
    };
    // 僅對已有合法 phase 的 binding 單調推進；legacy（無欄位）保持省略。
    const phased = isWorkerReadinessPhaseV1(binding!.readinessPhase) && nextPhase !== undefined
      ? withMonotonicReadinessPhase(nextBinding, nextPhase)
      : nextBinding;
    return this.store.compareAndSwap(this.key, input.expectedRevision, (current) => ({
      ...current,
      workerBindings: {
        ...(current.workerBindings ?? {}),
        [input.taskId]: phased,
      },
    }));
  }

  async recordWorkerHeartbeat(
    expectedRevision: number,
    receipt: WorkerHeartbeatReceiptV1,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireRevision(expectedRevision);
    if (!before.ok) return before;
    const task = before.value.value.tasks[receipt.taskId];
    const binding = (before.value.value.workerBindings ?? {})[receipt.taskId];
    if (task === undefined || task.claim === undefined
      || sha256(task.claim.token) !== receipt.claimTokenDigest
      || task.claim.generation !== receipt.generation
      || receipt.schemaVersion !== 1
      || !matchesBinding(binding, receipt.generation, receipt.providerReceiptHash)
      || receipt.provider !== binding!.provider
      || !sameOptionalIdentity(binding!.process, receipt.process)
      || !sameOptionalIdentity(binding!.pane, receipt.pane)) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Worker heartbeat identity is stale or foreign'));
    }
    // Deliberately does not renew task.claim.leasedUntilMs.
    // startMarker 不再編碼 `tmux:<session>`，必須沿用 pane/既有心跳的 sessionName。
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => {
      const prior = current.heartbeats[receipt.taskId];
      const sessionName = receipt.pane?.sessionName ?? prior?.sessionName;
      const providerBasename = prior?.providerBasename;
      return {
        ...current,
        heartbeats: {
          ...current.heartbeats,
          [receipt.taskId]: {
            schemaVersion: 1,
            workerId: receipt.taskId,
            ownerNonce: current.ownerNonce,
            workerNonce: receipt.pane?.workerNonce ?? receipt.providerReceiptHash,
            process: receipt.process ?? { pid: 0, startMarker: `native:${receipt.providerReceiptHash}` },
            paneId: receipt.pane?.paneId ?? '',
            recordedAtMs: receipt.recordedAtMs,
            generation: receipt.generation,
            providerReceiptHash: receipt.providerReceiptHash,
            ...(sessionName === undefined ? {} : { sessionName }),
            ...(providerBasename === undefined ? {} : { providerBasename }),
          },
        },
      };
    });
  }

  async completeReadOnlyTask(
    taskId: string,
    expectedRevision: number,
    claimToken: string,
    generation: number,
    artifactDigest: string,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireClaim(taskId, expectedRevision, claimToken, generation);
    if (!before.ok) return before;
    const specification = before.value.value.manifest.tasks.find((entry) => entry.id === taskId);
    if (specification?.mode !== 'read_only' || specification.write_scope !== 'none' || !isDigest(artifactDigest)) {
      return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Only validated read-only tasks can complete without integration', { taskId }));
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => updateTask(current, taskId, (entry) => ({
      ...entry,
      revision: entry.revision + 1,
      status: 'completed',
      claim: undefined,
      resultHash: artifactDigest,
      artifactRoots: [],
    })));
  }

  async recordHeartbeat(
    expectedRevision: number,
    heartbeat: SupervisorHeartbeatV1,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireRevision(expectedRevision);
    if (!before.ok) return before;
    if (heartbeat.schemaVersion !== 1 || heartbeat.ownerNonce !== before.value.value.ownerNonce) {
      return err(runtimeError('E_TMUX_OWNER_MISMATCH', 'Heartbeat owner does not match Team authority'));
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => ({
      ...current,
      heartbeats: { ...current.heartbeats, [heartbeat.workerId]: heartbeat },
    }));
  }

  async recordProgress(
    expectedRevision: number,
    progress: AgentProgressV1,
    leaseMs: number,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireClaim(progress.taskId, expectedRevision, progress.claimToken, progress.generation);
    if (!before.ok) return before;
    const task = before.value.value.tasks[progress.taskId];
    const binding = (before.value.value.workerBindings ?? {})[progress.taskId];
    if (
      progress.schemaVersion !== 1
      || progress.taskRevision !== task.revision
      || !isDigest(progress.artifactDigest)
      || progress.recordedAtMs < 0
      || (binding !== undefined && (
        progress.providerReceiptHash !== binding.providerReceiptHash
        || !sameOptionalIdentity(binding.process, progress.child)
      ))
    ) {
      return err(runtimeError('E_CORRUPT_STATE', 'Agent progress evidence is invalid', { taskId: progress.taskId }));
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => updateTask(current, progress.taskId, (entry) => ({
      ...entry,
      revision: entry.revision + 1,
      lastProgress: progress,
      claim: entry.claim === undefined ? undefined : {
        ...entry.claim,
        leasedUntilMs: progress.recordedAtMs + leaseMs,
      },
    })));
  }

  async recordCommandEvidence(
    expectedRevision: number,
    evidence: CommandEvidenceV1,
    leaseMs: number,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireClaim(evidence.taskId, expectedRevision, evidence.claimToken, evidence.generation);
    if (!before.ok) return before;
    const binding = (before.value.value.workerBindings ?? {})[evidence.taskId];
    if (
      evidence.schemaVersion !== 1
      || !isDigest(evidence.argvDigest)
      || !isDigest(evidence.artifactDigest)
      || !isDigest(evidence.outputDigest)
      || evidence.finishedAtMs < evidence.startedAtMs
      || evidence.finishedAtMs - evidence.startedAtMs > evidence.deadlineMs
      || (binding !== undefined && (
        evidence.providerReceiptHash !== binding.providerReceiptHash
        || !sameOptionalIdentity(binding.process, evidence.process)
      ))
    ) {
      return err(runtimeError('E_CORRUPT_STATE', 'Command evidence is invalid', { commandId: evidence.commandId }));
    }
    const existing = before.value.value.tasks[evidence.taskId].commandEvidence[evidence.commandId];
    if (existing !== undefined) {
      return canonicalJson(existing) === canonicalJson(evidence)
        ? before
        : err(runtimeError('E_REVISION_CONFLICT', 'Command evidence ID conflicts with an existing record'));
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => updateTask(current, evidence.taskId, (entry) => ({
      ...entry,
      revision: entry.revision + 1,
      commandEvidence: { ...entry.commandEvidence, [evidence.commandId]: evidence },
      claim: entry.claim === undefined ? undefined : {
        ...entry.claim,
        leasedUntilMs: evidence.finishedAtMs + leaseMs,
      },
    })));
  }

  async acceptDelivery(
    expectedRevision: number,
    delivery: DeliveryEvidenceV1,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireClaim(delivery.taskId, expectedRevision, delivery.claimToken, delivery.generation);
    if (!before.ok) return before;
    const task = before.value.value.tasks[delivery.taskId];
    const binding = (before.value.value.workerBindings ?? {})[delivery.taskId];
    if (delivery.taskRevision !== task.revision || delivery.manifestRevision !== before.value.value.manifest.revision) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Delivery revision does not match current Team state'));
    }
    if (binding !== undefined
      && (binding.generation !== delivery.generation || binding.state !== 'delivery_ready')) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Delivery does not match the active worker authority state'));
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => updateTask(current, delivery.taskId, (entry) => ({
      ...entry,
      revision: entry.revision + 1,
      status: 'delivered_unintegrated',
      delivery,
    })));
  }

  async markIntegrated(
    taskId: string,
    expectedRevision: number,
    deliveryDigest: string,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireRevision(expectedRevision);
    if (!before.ok) return before;
    const task = before.value.value.tasks[taskId];
    if (task?.status !== 'delivered_unintegrated' || task.delivery === undefined || sha256(canonicalJson(task.delivery)) !== deliveryDigest) {
      return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Task delivery is not ready for completion', { taskId }));
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => updateTask(current, taskId, (entry) => ({
      ...entry,
      revision: entry.revision + 1,
      status: 'completed',
      claim: undefined,
      resultHash: deliveryDigest,
      artifactRoots: [],
    })));
  }

  async setTaskStatus(
    taskId: string,
    expectedRevision: number,
    status: Extract<TeamTaskStatus, 'awaiting_interaction' | 'orphan_identity_unproven' | 'integration_blocked'>,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireRevision(expectedRevision);
    if (!before.ok) return before;
    if (before.value.value.tasks[taskId] === undefined) return err(runtimeError('E_NOT_FOUND', 'Team task does not exist', { taskId }));
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => updateTask(current, taskId, (entry) => ({
      ...entry,
      revision: entry.revision + 1,
      status,
    })));
  }

  /**
   * DeadProof reclaim：清除 claim、標 orphan_identity_unproven，允許後續 re-claim。
   * 必須在 requireDeadProof 通過後由 orchestrator 呼叫。
   */
  async releaseClaimAfterDeadProof(
    taskId: string,
    expectedRevision: number,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireRevision(expectedRevision);
    if (!before.ok) return before;
    const task = before.value.value.tasks[taskId];
    if (task === undefined) return err(runtimeError('E_NOT_FOUND', 'Team task does not exist', { taskId }));
    if (task.status !== 'in_progress' && task.status !== 'awaiting_interaction') {
      return err(runtimeError('E_REVISION_CONFLICT', 'Task is not reclaimable in its current state', {
        taskId,
        status: task.status,
      }));
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => {
      const heartbeats = { ...current.heartbeats };
      delete heartbeats[taskId];
      return {
        ...updateTask(current, taskId, (entry) => ({
          ...entry,
          revision: entry.revision + 1,
          status: 'orphan_identity_unproven',
          claim: undefined,
        })),
        heartbeats,
      };
    });
  }

  async sendMailbox(
    expectedRevision: number,
    message: MailboxMessageV1,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireRevision(expectedRevision);
    if (!before.ok) return before;
    if (message.schemaVersion !== 1 || message.id === '' || message.recipient === '' || !isDigest(message.bodyDigest)) {
      return err(runtimeError('E_CORRUPT_STATE', 'Mailbox message is invalid'));
    }
    const existing = before.value.value.mailbox[message.id];
    if (existing !== undefined) {
      return canonicalJson(existing) === canonicalJson(message)
        ? before
        : err(runtimeError('E_REVISION_CONFLICT', 'Mailbox message ID conflicts with an existing record', { messageId: message.id }));
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => ({
      ...current,
      mailbox: { ...current.mailbox, [message.id]: message },
    }));
  }

  async sendOrderedMailbox(
    expectedRevision: number,
    taskId: string,
    generation: number,
    message: Omit<MailboxMessageV1, 'recipient' | 'sequence' | 'generation' | 'acknowledgedAtMs'>,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireRevision(expectedRevision);
    if (!before.ok) return before;
    const task = before.value.value.tasks[taskId];
    if (task?.claim?.generation !== generation || message.schemaVersion !== 1
      || message.id.trim() === '' || !isDigest(message.bodyDigest)) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Ordered mailbox message targets a stale worker generation'));
    }
    const existing = before.value.value.mailbox[message.id];
    if (existing !== undefined) return err(runtimeError('E_REVISION_CONFLICT', 'Mailbox message ID already exists'));
    const sequence = Object.values(before.value.value.mailbox)
      .filter((item) => item.recipient === taskId && item.generation === generation)
      .reduce((highest, item) => Math.max(highest, item.sequence ?? 0), 0) + 1;
    const ordered: MailboxMessageV1 = {
      ...message,
      recipient: taskId,
      sequence,
      generation,
    };
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => ({
      ...current,
      mailbox: { ...current.mailbox, [ordered.id]: ordered },
    }));
  }

  listOrderedMailbox(input: {
    taskId: string;
    claimToken: string;
    generation: number;
    afterCursor: number;
  }): Result<{ messages: MailboxMessageV1[]; cursor: number }, RuntimeError> {
    const snapshot = this.read();
    if (!snapshot.ok) return snapshot;
    const task = snapshot.value.value.tasks[input.taskId];
    const binding = (snapshot.value.value.workerBindings ?? {})[input.taskId];
    const cursor = (snapshot.value.value.mailboxCursors ?? {})[input.taskId];
    if (task?.claim?.token !== input.claimToken || task.claim.generation !== input.generation
      || binding?.generation !== input.generation || cursor?.generation !== input.generation
      || cursor.cursor !== input.afterCursor) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Mailbox cursor or worker capability is stale'));
    }
    const messages = Object.values(snapshot.value.value.mailbox)
      .filter((message) => message.recipient === input.taskId
        && message.generation === input.generation
        && (message.sequence ?? 0) > input.afterCursor)
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index].sequence !== input.afterCursor + index + 1) {
        return err(runtimeError('E_CORRUPT_STATE', 'Mailbox sequence contains a gap'));
      }
    }
    return ok({ messages, cursor: input.afterCursor });
  }

  async acknowledgeOrderedMailbox(input: {
    expectedRevision: number;
    taskId: string;
    claimToken: string;
    generation: number;
    expectedCursor: number;
    nextCursor: number;
    messageIds: readonly string[];
    acknowledgedAtMs: number;
  }): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireClaim(
      input.taskId,
      input.expectedRevision,
      input.claimToken,
      input.generation,
    );
    if (!before.ok) return before;
    const cursor = (before.value.value.mailboxCursors ?? {})[input.taskId];
    if (cursor?.generation !== input.generation || cursor.cursor !== input.expectedCursor
      || input.nextCursor < input.expectedCursor
      || input.messageIds.length !== input.nextCursor - input.expectedCursor) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Mailbox acknowledgement cursor is stale or non-contiguous'));
    }
    const acknowledged = input.messageIds.map((id, index) => {
      const message = before.value.value.mailbox[id];
      const expectedSequence = input.expectedCursor + index + 1;
      if (message?.recipient !== input.taskId || message.generation !== input.generation
        || message.sequence !== expectedSequence || message.acknowledgedAtMs !== undefined) return null;
      return message;
    });
    if (acknowledged.some((message) => message === null)) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Mailbox acknowledgement does not match ordered unread messages'));
    }
    return this.store.compareAndSwap(this.key, input.expectedRevision, (current) => {
      const mailbox = { ...current.mailbox };
      for (const message of acknowledged as MailboxMessageV1[]) {
        mailbox[message.id] = { ...message, acknowledgedAtMs: input.acknowledgedAtMs };
      }
      const nextCursor: MailboxCursorV1 = {
        schemaVersion: 1,
        taskId: input.taskId,
        generation: input.generation,
        cursor: input.nextCursor,
        acknowledgedAtMs: input.acknowledgedAtMs,
      };
      return {
        ...current,
        mailbox,
        mailboxCursors: { ...(current.mailboxCursors ?? {}), [input.taskId]: nextCursor },
      };
    });
  }

  async terminalizeWorker(input: {
    expectedRevision: number;
    claimToken?: string;
    expectedState: Exclude<WorkerExecutionStateV1, 'terminal'>;
    expectedSequence: number;
    receipt: WorkerTerminalReceiptV1;
  }): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireRevision(input.expectedRevision);
    if (!before.ok) return before;
    const receipt = input.receipt;
    const task = before.value.value.tasks[receipt.taskId];
    const binding = (before.value.value.workerBindings ?? {})[receipt.taskId];
    const receiptKey = terminalReceiptKey(receipt.taskId, receipt.generation);
    const existing = (before.value.value.terminalReceipts ?? {})[receiptKey];
    if (existing !== undefined) {
      return canonicalJson(existing) === canonicalJson(receipt)
        ? before
        : err(runtimeError('E_TERMINAL_STATE', 'Terminal receipt is immutable'));
    }
    const claimMatches = task?.claim?.generation === receipt.generation
      && input.claimToken !== undefined && task.claim.token === input.claimToken;
    const completedMatches = receipt.outcome === 'completed' && task?.status === 'completed';
    if (receipt.schemaVersion !== 1 || receipt.capabilityPlaintextRemoved !== true
      || !isDigest(receipt.providerReceiptHash)
      || !matchesBinding(binding, receipt.generation, receipt.providerReceiptHash)
      || binding!.state !== input.expectedState
      || binding!.transitionSequence !== input.expectedSequence
      || receipt.transitionSequence !== input.expectedSequence + 1
      || (!claimMatches && !completedMatches)) {
      return err(runtimeError('E_TERMINAL_STATE', 'Terminal receipt is stale, foreign, or precedes capability cleanup'));
    }
    return this.store.compareAndSwap(this.key, input.expectedRevision, (current) => {
      const currentTask = current.tasks[receipt.taskId]!;
      const nextStatus = receipt.outcome === 'failed' ? 'failed'
        : receipt.outcome === 'cancelled' ? 'cancelled' : currentTask.status;
      return {
        ...updateTask(current, receipt.taskId, (entry) => ({
          ...entry,
          revision: entry.revision + (entry.status === nextStatus ? 0 : 1),
          status: nextStatus,
          claim: receipt.outcome === 'completed' ? entry.claim : undefined,
        })),
        workerBindings: {
          ...(current.workerBindings ?? {}),
          [receipt.taskId]: {
            ...binding!,
            state: 'terminal',
            transitionSequence: receipt.transitionSequence,
          },
        },
        terminalReceipts: {
          ...(current.terminalReceipts ?? {}),
          [receiptKey]: receipt,
        },
      };
    });
  }

  async acquireSupervisor(
    expectedRevision: number,
    proposed: TeamSupervisorAuthorityV1,
    nowMs: number,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireRevision(expectedRevision);
    if (!before.ok) return before;
    if (!validSupervisor(proposed)) return err(runtimeError('E_CORRUPT_STATE', 'Supervisor authority is invalid'));
    const current = before.value.value.supervisor;
    if (current !== undefined) {
      if (canonicalJson(current) === canonicalJson(proposed)) return before;
      if (current.leasedUntilMs > nowMs || proposed.generation !== current.generation + 1) {
        return err(runtimeError('E_REVISION_CONFLICT', 'Supervisor takeover is premature or generation-fenced'));
      }
    } else if (proposed.generation !== 1) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Initial supervisor generation must be one'));
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (aggregate) => ({
      ...aggregate,
      supervisor: proposed,
    }));
  }

  async recordSupervisorProgress(input: {
    expectedRevision: number;
    ownerTokenDigest: string;
    generation: number;
    recordedAtMs: number;
    leaseMs: number;
  }): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireRevision(input.expectedRevision);
    if (!before.ok) return before;
    const current = before.value.value.supervisor;
    if (current?.ownerTokenDigest !== input.ownerTokenDigest || current.generation !== input.generation
      || input.recordedAtMs < current.lastProgressAtMs || input.leaseMs <= 0) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Supervisor progress is stale or foreign'));
    }
    return this.store.compareAndSwap(this.key, input.expectedRevision, (aggregate) => ({
      ...aggregate,
      supervisor: {
        ...current,
        lastProgressAtMs: input.recordedAtMs,
        leasedUntilMs: input.recordedAtMs + input.leaseMs,
      },
    }));
  }

  mailboxFor(recipient: string): MailboxMessageV1[] {
    const snapshot = this.read();
    if (!snapshot.ok) return [];
    return Object.values(snapshot.value.value.mailbox).filter((message) => message.recipient === recipient);
  }

  /**
   * Mark a mailbox message delivered (OMX-shaped mailbox-mark-delivered).
   * Does not advance ordered ack cursors — use acknowledgeOrderedMailbox for that.
   */
  async markMailboxDelivered(
    expectedRevision: number,
    messageId: string,
    deliveredAtMs: number,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireRevision(expectedRevision);
    if (!before.ok) return before;
    const existing = before.value.value.mailbox[messageId];
    if (existing === undefined) {
      return err(runtimeError('E_NOT_FOUND', 'Mailbox message does not exist', { messageId }));
    }
    if (existing.deliveredAtMs !== undefined) {
      if (existing.deliveredAtMs === deliveredAtMs) return before;
      return before; // idempotent: already delivered
    }
    if (!Number.isSafeInteger(deliveredAtMs) || deliveredAtMs < 0) {
      return err(runtimeError('E_CORRUPT_STATE', 'deliveredAtMs must be a non-negative integer'));
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => ({
      ...current,
      mailbox: {
        ...current.mailbox,
        [messageId]: { ...existing, deliveredAtMs },
      },
    }));
  }

  /**
   * Append a task to the live aggregate + manifest (OMX-shaped create-task).
   * P0: does not re-run full manifest scope/cycle validation beyond local checks.
   */
  async createTask(
    expectedRevision: number,
    task: CanonicalTeamManifestV1['tasks'][number],
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireRevision(expectedRevision);
    if (!before.ok) return before;
    if (before.value.value.tasks[task.id] !== undefined
      || before.value.value.manifest.tasks.some((entry) => entry.id === task.id)) {
      return err(runtimeError('E_ALREADY_EXISTS', 'Team task already exists', { taskId: task.id }));
    }
    for (const dependency of task.dependencies) {
      if (before.value.value.tasks[dependency] === undefined) {
        return err(runtimeError('E_TASK_DEPENDENCY_BLOCKED', 'Task dependency does not exist', {
          taskId: task.id,
          dependency,
        }));
      }
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => ({
      ...current,
      manifest: {
        ...current.manifest,
        revision: current.manifest.revision + 1,
        tasks: [...current.manifest.tasks, task],
      },
      tasks: {
        ...current.tasks,
        [task.id]: {
          id: task.id,
          revision: 0,
          status: 'pending',
          commandEvidence: {},
        },
      },
    }));
  }

  /**
   * Claim-token-gated status transition (OMX-shaped transition-task-status).
   * Clearing transitions (failed/cancelled/pending) drop the claim.
   */
  async transitionTaskStatus(input: {
    taskId: string;
    expectedRevision: number;
    from: TeamTaskStatus;
    to: TeamTaskStatus;
    claimToken: string;
    generation: number;
  }): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireClaim(
      input.taskId,
      input.expectedRevision,
      input.claimToken,
      input.generation,
    );
    if (!before.ok) return before;
    const task = before.value.value.tasks[input.taskId]!;
    if (task.status !== input.from) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Task status does not match from', {
        taskId: input.taskId,
        from: input.from,
        actual: task.status,
      }));
    }
    if (!apiTransitionAllowed(input.from, input.to)) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'Illegal task status transition', {
        from: input.from,
        to: input.to,
      }));
    }
    const clearClaim = input.to === 'failed' || input.to === 'cancelled' || input.to === 'pending';
    return this.store.compareAndSwap(this.key, input.expectedRevision, (current) => updateTask(
      current,
      input.taskId,
      (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        status: input.to,
        claim: clearClaim ? undefined : entry.claim,
      }),
    ));
  }

  /**
   * Voluntary claim release with token proof (OMX-shaped release-task-claim).
   * Returns the task to pending (not orphan_identity_unproven).
   */
  async releaseTaskClaim(input: {
    taskId: string;
    expectedRevision: number;
    claimToken: string;
    generation: number;
  }): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const before = this.requireClaim(
      input.taskId,
      input.expectedRevision,
      input.claimToken,
      input.generation,
    );
    if (!before.ok) return before;
    const task = before.value.value.tasks[input.taskId]!;
    if (task.status !== 'in_progress' && task.status !== 'awaiting_interaction') {
      return err(runtimeError('E_REVISION_CONFLICT', 'Task claim is not releasable in its current state', {
        taskId: input.taskId,
        status: task.status,
      }));
    }
    return this.store.compareAndSwap(this.key, input.expectedRevision, (current) => {
      const heartbeats = { ...current.heartbeats };
      delete heartbeats[input.taskId];
      return {
        ...updateTask(current, input.taskId, (entry) => ({
          ...entry,
          revision: entry.revision + 1,
          status: 'pending',
          claim: undefined,
        })),
        heartbeats,
      };
    });
  }

  /** Absolute directory for this team's durable partition (aggregate sibling). */
  teamDirectory(): string {
    return path.join(this.stateRoot, path.dirname(this.key));
  }

  summary(): { complete: boolean; blockers: readonly string[]; tasks?: Readonly<Record<string, TeamTaskRuntimeV1>>; teamId?: string; revision?: number } {
    const snapshot = this.read();
    if (!snapshot.ok) return { complete: false, blockers: [snapshot.error.code] };
    const blockers = Object.values(snapshot.value.value.tasks)
      .filter((task) => task.status !== 'completed')
      .map((task) => `${task.id}:${task.status}`);
    return {
      complete: blockers.length === 0,
      blockers,
      tasks: snapshot.value.value.tasks,
      teamId: snapshot.value.value.teamId,
      revision: snapshot.value.revision,
    };
  }

  private requireClaim(
    taskId: string,
    expectedRevision: number,
    token: string,
    generation: number,
  ): Result<Snapshot<TeamAggregateV1>, RuntimeError> {
    const before = this.requireRevision(expectedRevision);
    if (!before.ok) return before;
    const task = before.value.value.tasks[taskId];
    if (task === undefined) return err(runtimeError('E_NOT_FOUND', 'Team task does not exist', { taskId }));
    if (task.status === 'fenced_superseded') {
      return err(runtimeError('E_RECOVERY_FORK_FENCED', 'Recovery fork loser is permanently fenced', { taskId }));
    }
    if (task.claim?.token !== token || task.claim.generation !== generation) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Task claim token or generation is stale', { taskId, generation }));
    }
    return before;
  }

  private requireRevision(expectedRevision: number): Result<Snapshot<TeamAggregateV1>, RuntimeError> {
    const current = this.read();
    if (!current.ok) return current;
    if (current.value.revision !== expectedRevision) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Team state revision changed', {
        expectedRevision,
        actualRevision: current.value.revision,
      }));
    }
    return current;
  }

}

function updateTask(
  current: Readonly<TeamAggregateV1>,
  taskId: string,
  mutate: (task: TeamTaskRuntimeV1) => TeamTaskRuntimeV1,
): TeamAggregateV1 {
  const task = current.tasks[taskId];
  if (task === undefined) return current;
  return { ...current, tasks: { ...current.tasks, [taskId]: mutate(task) } };
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function validateWorkerBinding(
  binding: Readonly<WorkerAuthorityBindingV1>,
  _taskRevision: number,
  claimToken: string,
): RuntimeError | null {
  const common = binding.schemaVersion === 1
    && binding.taskId.trim() !== ''
    && binding.claimTokenDigest === sha256(claimToken)
    && binding.generation > 0
    && isDigest(binding.providerReceiptHash)
    && binding.state === 'claimed'
    && binding.transitionSequence === 0
    && binding.boundAtMs >= 0;
  const processValid = binding.process === undefined
    || (Number.isSafeInteger(binding.process.pid) && binding.process.pid > 0
      && binding.process.startMarker.trim() !== '');
  const paneValid = binding.pane === undefined
    || (binding.pane.schemaVersion === 1 && binding.pane.sessionName.trim() !== ''
      && binding.pane.paneId.trim() !== '' && binding.pane.ownerNonce.trim() !== ''
      && binding.pane.workerNonce.trim() !== '');
  const providerValid = binding.provider === 'antigravity_native'
    ? binding.conversation?.generation === binding.generation
      && binding.conversation.provider === 'antigravity_native'
      && binding.process === undefined && binding.pane === undefined
    : binding.provider === 'agy_headless'
      ? binding.conversation === undefined && binding.process !== undefined && binding.pane === undefined
      : binding.provider === 'tmux_agy'
        ? binding.conversation === undefined && binding.process !== undefined && binding.pane !== undefined
        : false;
  const phaseValid = binding.readinessPhase === undefined
    || isWorkerReadinessPhaseV1(binding.readinessPhase);
  return common && processValid && paneValid && providerValid && phaseValid
    ? null
    : runtimeError('E_CORRUPT_STATE', 'Worker authority binding is invalid or provider-inconsistent');
}

function matchesBinding(
  binding: Readonly<WorkerAuthorityBindingV1> | undefined,
  generation: number,
  providerReceiptHash: string,
): boolean {
  return binding !== undefined
    && binding.generation === generation
    && binding.providerReceiptHash === providerReceiptHash;
}

function sameOptionalIdentity(expected: unknown | undefined, actual: unknown | undefined): boolean {
  if (expected === undefined) return true;
  return actual !== undefined && canonicalJson(expected) === canonicalJson(actual);
}

function transitionAllowed(from: WorkerExecutionStateV1, to: WorkerExecutionStateV1): boolean {
  const next: Readonly<Partial<Record<WorkerExecutionStateV1, WorkerExecutionStateV1>>> = {
    claimed: 'launched',
    launched: 'running',
    running: 'verifying',
    verifying: 'delivery_ready',
    delivery_ready: 'integration_requested',
  };
  return next[from] === to;
}

function terminalReceiptKey(taskId: string, generation: number): string {
  return `${taskId}:g${generation}`;
}

function validSupervisor(value: Readonly<TeamSupervisorAuthorityV1>): boolean {
  return value.schemaVersion === 1
    && isDigest(value.ownerTokenDigest)
    && Number.isSafeInteger(value.generation) && value.generation > 0
    && Number.isSafeInteger(value.process.pid) && value.process.pid > 0
    && value.process.startMarker.trim() !== ''
    && value.acquiredAtMs >= 0
    && value.lastProgressAtMs >= value.acquiredAtMs
    && value.leasedUntilMs >= value.lastProgressAtMs;
}

/** P0 API status graph — claim-gated; delivery/integration still use dedicated store methods. */
function apiTransitionAllowed(from: TeamTaskStatus, to: TeamTaskStatus): boolean {
  if (from === to) return false;
  const allowed: Readonly<Partial<Record<TeamTaskStatus, readonly TeamTaskStatus[]>>> = {
    in_progress: ['awaiting_interaction', 'failed', 'cancelled', 'pending'],
    awaiting_interaction: ['in_progress', 'failed', 'cancelled', 'pending'],
  };
  return (allowed[from] ?? []).includes(to);
}
