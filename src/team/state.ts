import { canonicalJson, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { StateStore } from '../runtime/state-store';
import { Result, Snapshot, err } from '../runtime/types';
import {
  AgentProgressV1,
  CanonicalTeamManifestV1,
  CommandEvidenceV1,
  DeliveryEvidenceV1,
  MailboxMessageV1,
  SupervisorHeartbeatV1,
  TeamAggregateV1,
  TeamTaskRuntimeV1,
  TeamTaskStatus,
} from './types';

export class TeamStateStore {
  readonly key: string;
  private readonly store: StateStore<TeamAggregateV1>;
  private readonly repoKey: string | null;
  private readonly workspaceKey: string;

  constructor(stateRoot: string, repoKey: string | null, workspaceKey: string, teamId: string) {
    this.repoKey = repoKey;
    this.workspaceKey = workspaceKey;
    const partition = repoKey === null ? `workspaces/${workspaceKey}/teams-readonly` : `repositories/${repoKey}/teams`;
    this.key = `${partition}/${teamId}/aggregate`;
    this.store = new StateStore<TeamAggregateV1>(stateRoot);
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
    if (!['pending', 'awaiting_interaction', 'orphan_identity_unproven'].includes(task.status)) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Task is not claimable in its current state', { taskId, status: task.status }));
    }
    const generation = (task.claim?.generation ?? 0) + 1;
    return this.store.compareAndSwap(this.key, expectedRevision, (current) => updateTask(current, taskId, (entry) => ({
      ...entry,
      revision: entry.revision + 1,
      status: 'in_progress',
      claim: { ownerId, token: claimToken, generation, leasedUntilMs: nowMs + leaseMs },
    })));
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
    if (
      progress.schemaVersion !== 1
      || progress.taskRevision !== task.revision
      || !isDigest(progress.artifactDigest)
      || progress.recordedAtMs < 0
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
    if (
      evidence.schemaVersion !== 1
      || !isDigest(evidence.argvDigest)
      || !isDigest(evidence.artifactDigest)
      || !isDigest(evidence.outputDigest)
      || evidence.finishedAtMs < evidence.startedAtMs
      || evidence.finishedAtMs - evidence.startedAtMs > evidence.deadlineMs
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
    if (delivery.taskRevision !== task.revision || delivery.manifestRevision !== before.value.value.manifest.revision) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Delivery revision does not match current Team state'));
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

  mailboxFor(recipient: string): MailboxMessageV1[] {
    const snapshot = this.read();
    if (!snapshot.ok) return [];
    return Object.values(snapshot.value.value.mailbox).filter((message) => message.recipient === recipient);
  }

  summary(): { complete: boolean; blockers: readonly string[] } {
    const snapshot = this.read();
    if (!snapshot.ok) return { complete: false, blockers: [snapshot.error.code] };
    const blockers = Object.values(snapshot.value.value.tasks)
      .filter((task) => task.status !== 'completed')
      .map((task) => `${task.id}:${task.status}`);
    return { complete: blockers.length === 0, blockers };
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
