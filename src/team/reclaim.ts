import { runtimeError } from '../runtime/errors';
import { ProcessLiveness } from '../runtime/lock';
import { Result, err, ok } from '../runtime/types';

export type IdentityLiveness = ProcessLiveness;

export interface DeadProof {
  kind: 'DeadProof';
  pane: 'dead';
  process: 'dead';
}

export interface AliveFence {
  kind: 'Alive';
  pane: IdentityLiveness;
  process: IdentityLiveness;
}

export interface UnknownFence {
  kind: 'Unknown';
  pane: IdentityLiveness;
  process: IdentityLiveness;
}

export type ReclaimFenceResult = DeadProof | AliveFence | UnknownFence;

export function inspectReclaimFence(
  pane: IdentityLiveness,
  process: IdentityLiveness,
): ReclaimFenceResult {
  if (pane === 'dead' && process === 'dead') return { kind: 'DeadProof', pane, process };
  if (pane === 'alive' || process === 'alive') return { kind: 'Alive', pane, process };
  return { kind: 'Unknown', pane, process };
}

export function requireDeadProof(
  pane: IdentityLiveness,
  process: IdentityLiveness,
): Result<DeadProof> {
  const inspected = inspectReclaimFence(pane, process);
  if (inspected.kind === 'DeadProof') return ok(inspected);
  return err(runtimeError('E_RECLAIM_IDENTITY_UNPROVEN', 'Worker reclaim requires dead pane and process proof', {
    pane,
    process,
    outcome: inspected.kind,
  }));
}

