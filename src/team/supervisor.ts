import { ProcessLiveness } from '../runtime/lock';
import { SupervisorHeartbeatV1, TeamTaskRuntimeV1 } from './types';
import { inspectReclaimFence, ReclaimFenceResult } from './reclaim';

export interface SupervisorAssessment {
  status: 'healthy' | 'awaiting_interaction' | 'orphan_identity_unproven' | 'reclaimable';
  fence?: ReclaimFenceResult;
  attachCommand?: readonly string[];
}

export function assessWorker(
  task: Readonly<TeamTaskRuntimeV1>,
  heartbeat: Readonly<SupervisorHeartbeatV1> | undefined,
  nowMs: number,
  paneLiveness: ProcessLiveness,
  processLiveness: ProcessLiveness,
): SupervisorAssessment {
  if (task.claim !== undefined && task.claim.leasedUntilMs > nowMs) return { status: 'healthy' };
  const fence = inspectReclaimFence(paneLiveness, processLiveness);
  if (fence.kind === 'DeadProof') return { status: 'reclaimable', fence };
  if (fence.kind === 'Unknown') return { status: 'orphan_identity_unproven', fence };
  return {
    status: 'awaiting_interaction',
    fence,
    attachCommand: heartbeat === undefined ? undefined : ['tmux', 'select-pane', '-t', heartbeat.paneId],
  };
}

