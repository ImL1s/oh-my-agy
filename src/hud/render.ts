import { canonicalJsonV1 } from '../contracts/state-schemas';
import { HudSnapshotV1 } from './status';

export type HudRenderFormat = 'text' | 'json';

export function renderHud(snapshot: Readonly<HudSnapshotV1>, format: HudRenderFormat): string {
  return format === 'json' ? canonicalJsonV1(snapshot) : renderHudText(snapshot);
}

export function renderHudText(snapshot: Readonly<HudSnapshotV1>): string {
  const session = snapshot.session === null
    ? 'session=-'
    : snapshot.session.status !== 'available'
      ? `session=${snapshot.session.status}:${snapshot.session.code}`
      : `session=${snapshot.session.phase}@r${snapshot.session.revision}:g${snapshot.session.generation}`;
  const team = snapshot.team === null
    ? 'team=-'
    : snapshot.team.status !== 'available'
      ? `team=${snapshot.team.status}:${snapshot.team.code}`
      : `team=${snapshot.team.completed_count}/${snapshot.team.task_count}:blocked=${snapshot.team.blocker_count}`;
  const adapters = snapshot.adapters.length === 0
    ? 'adapters=disabled'
    : `adapters=${snapshot.adapters.map((entry) => `${entry.adapter}:${entry.status}`).join(',')}`;
  return `oma-hud ${session} ${team} ${adapters}`;
}
