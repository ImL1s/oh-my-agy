/**
 * 設計概念映射：持久化 supervisor 對齊 OMC/OMX worker adoption fence。
 * tmux 路徑必須有路由執行檔 basename 相符的 provider 子程序才可 adopt
 * （OMG process_stable / provider identity）；pane 存活不足以為證。
 */
import { canonicalJson, sha256 } from '../runtime/atomic';
import { ProcessLiveness } from '../runtime/lock';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, Snapshot, err, ok } from '../runtime/types';
import { isProvenProcessMarker } from './liveness';
import { TeamStateStore } from './state';
import {
  ProcessMarkerV1,
  TeamAggregateV1,
  TeamSupervisorAuthorityV1,
  WorkerAuthorityBindingV1,
  WorkerPaneReceiptV1,
} from './types';

export interface WorkerRuntimeObservationV1 {
  taskId: string;
  generation: number;
  providerReceiptHash: string;
  process?: ProcessMarkerV1;
  pane?: WorkerPaneReceiptV1;
  processLiveness: ProcessLiveness;
  paneLiveness: ProcessLiveness;
  nativeConversationHealthy?: boolean;
  exitCode?: number;
  /**
   * tmux 路徑：必須比對到路由執行檔 basename 才可 adopt。
   * 省略或 false 時，即使 pane 存活也不得 adopt。
   */
  providerIdentityMatched?: boolean;
}

export type WorkerReconciliationV1 =
  | { action: 'adopt'; taskId: string; generation: number }
  | { action: 'terminal_reconciled'; taskId: string; generation: number; exitCode?: number }
  | { action: 'reclaim_generation_plus_one'; taskId: string; generation: number }
  | { action: 'block_identity_unproven'; taskId: string; generation: number }
  | { action: 'fence_stale_observation'; taskId: string; generation: number };

export function reconcileWorkerObservation(
  aggregate: Readonly<TeamAggregateV1>,
  observation: Readonly<WorkerRuntimeObservationV1>,
): WorkerReconciliationV1 {
  const binding = (aggregate.workerBindings ?? {})[observation.taskId];
  if (!identityMatches(binding, observation)) {
    return {
      action: 'fence_stale_observation',
      taskId: observation.taskId,
      generation: observation.generation,
    };
  }
  const terminal = (aggregate.terminalReceipts ?? {})[`${observation.taskId}:g${observation.generation}`];
  if (binding!.state === 'terminal' && terminal !== undefined
    && terminal.providerReceiptHash === observation.providerReceiptHash) {
    return {
      action: 'terminal_reconciled',
      taskId: observation.taskId,
      generation: observation.generation,
      ...(observation.exitCode === undefined ? {} : { exitCode: observation.exitCode }),
    };
  }
  if (binding!.provider === 'antigravity_native') {
    return observation.nativeConversationHealthy === true
      ? { action: 'adopt', taskId: observation.taskId, generation: observation.generation }
      : { action: 'block_identity_unproven', taskId: observation.taskId, generation: observation.generation };
  }
  if (binding!.provider === 'agy_headless') {
    if (observation.processLiveness === 'alive') {
      return { action: 'adopt', taskId: observation.taskId, generation: observation.generation };
    }
    return observation.processLiveness === 'dead'
      ? { action: 'reclaim_generation_plus_one', taskId: observation.taskId, generation: observation.generation }
      : { action: 'block_identity_unproven', taskId: observation.taskId, generation: observation.generation };
  }
  // tmux_agy：pane 存活不足以 adopt，必須有相符的 provider 子程序。
  if (observation.providerIdentityMatched === true && observation.processLiveness === 'alive') {
    return { action: 'adopt', taskId: observation.taskId, generation: observation.generation };
  }
  if (observation.processLiveness === 'dead' && observation.paneLiveness === 'dead') {
    return { action: 'reclaim_generation_plus_one', taskId: observation.taskId, generation: observation.generation };
  }
  return { action: 'block_identity_unproven', taskId: observation.taskId, generation: observation.generation };
}

/** Restartable, generation-fenced Team supervisor authority. */
export class PersistentTeamSupervisor {
  private readonly store: TeamStateStore;
  private readonly ownerTokenDigest: string;
  private readonly process: ProcessMarkerV1;
  private readonly leaseMs: number;

  constructor(input: {
    store: TeamStateStore;
    ownerToken: string;
    process: ProcessMarkerV1;
    leaseMs: number;
  }) {
    this.store = input.store;
    this.ownerTokenDigest = sha256(input.ownerToken);
    this.process = input.process;
    this.leaseMs = input.leaseMs;
  }

  async acquire(expectedRevision: number, nowMs: number): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    const snapshot = this.store.read();
    if (!snapshot.ok) return snapshot;
    if (snapshot.value.revision !== expectedRevision) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Supervisor acquisition revision changed'));
    }
    const generation = (snapshot.value.value.supervisor?.generation ?? 0) + 1;
    const proposed: TeamSupervisorAuthorityV1 = {
      schemaVersion: 1,
      ownerTokenDigest: this.ownerTokenDigest,
      generation,
      process: this.process,
      acquiredAtMs: nowMs,
      lastProgressAtMs: nowMs,
      leasedUntilMs: nowMs + this.leaseMs,
    };
    return this.store.acquireSupervisor(expectedRevision, proposed, nowMs);
  }

  progress(
    expectedRevision: number,
    generation: number,
    nowMs: number,
  ): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
    return this.store.recordSupervisorProgress({
      expectedRevision,
      ownerTokenDigest: this.ownerTokenDigest,
      generation,
      recordedAtMs: nowMs,
      leaseMs: this.leaseMs,
    });
  }
}

function identityMatches(
  binding: Readonly<WorkerAuthorityBindingV1> | undefined,
  observation: Readonly<WorkerRuntimeObservationV1>,
): boolean {
  if (binding === undefined || binding.generation !== observation.generation
    || binding.providerReceiptHash !== observation.providerReceiptHash) return false;
  if (isProvenProcessMarker(binding.process)
    && canonicalJson(binding.process) !== canonicalJson(observation.process)) return false;
  if (binding.pane !== undefined
    && canonicalJson(binding.pane) !== canonicalJson(observation.pane)) return false;
  return true;
}
