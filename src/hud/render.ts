import { canonicalJsonV1 } from '../contracts/state-schemas';
import { HudSnapshotV1, HudSessionViewV1, HudTeamViewV1 } from './status';

export type HudRenderFormat = 'text' | 'json';

/**
 * 呈現層級。設計概念映射：OMX `omx hud --preset=minimal|focused|full` 的三段分層，
 * 以及 OMC `/oh-my-claudecode:hud minimal|focused|full` 的 statusline preset。
 * `focused` 為預設值，輸出與導入 preset 之前逐字相同（回溯相容）。
 */
export type HudPreset = 'minimal' | 'focused' | 'full';

export const HUD_PRESETS: readonly HudPreset[] = ['minimal', 'focused', 'full'];
export const DEFAULT_HUD_PRESET: HudPreset = 'focused';

export function isHudPreset(value: unknown): value is HudPreset {
  return typeof value === 'string' && (HUD_PRESETS as readonly string[]).includes(value);
}

export function renderHud(
  snapshot: Readonly<HudSnapshotV1>,
  format: HudRenderFormat,
  preset: HudPreset = DEFAULT_HUD_PRESET,
): string {
  // JSON 是機器契約，不受 preset 影響；preset 只調整人類可讀密度。
  return format === 'json' ? canonicalJsonV1(snapshot) : renderHudText(snapshot, preset);
}

export function renderHudText(
  snapshot: Readonly<HudSnapshotV1>,
  preset: HudPreset = DEFAULT_HUD_PRESET,
): string {
  if (preset === 'minimal') {
    return `oma-hud ${minimalSession(snapshot)} ${minimalTeam(snapshot)}`;
  }
  const base = `oma-hud ${sessionSegment(snapshot)} ${teamSegment(snapshot)} ${adapterSegment(snapshot)}`;
  if (preset === 'focused') return base;
  const detail = fullDetailSegments(snapshot);
  return detail.length === 0 ? base : `${base} ${detail.join(' ')}`;
}

/** minimal：只回答「跑到哪、完成幾件」，其餘一律省略。 */
function minimalSession(snapshot: Readonly<HudSnapshotV1>): string {
  if (snapshot.session === null) return 'session=-';
  return snapshot.session.status !== 'available'
    ? `session=${snapshot.session.status}`
    : `session=${snapshot.session.phase}`;
}

function minimalTeam(snapshot: Readonly<HudSnapshotV1>): string {
  if (snapshot.team === null) return 'team=-';
  return snapshot.team.status !== 'available'
    ? `team=${snapshot.team.status}`
    : `team=${snapshot.team.completed_count}/${snapshot.team.task_count}`;
}

function sessionSegment(snapshot: Readonly<HudSnapshotV1>): string {
  if (snapshot.session === null) return 'session=-';
  if (snapshot.session.status !== 'available') {
    return `session=${snapshot.session.status}:${snapshot.session.code}`;
  }
  const view = snapshot.session;
  return `session=${view.phase}@r${view.revision}:g${view.generation}`;
}

function teamSegment(snapshot: Readonly<HudSnapshotV1>): string {
  if (snapshot.team === null) return 'team=-';
  if (snapshot.team.status !== 'available') {
    return `team=${snapshot.team.status}:${snapshot.team.code}`;
  }
  const view = snapshot.team;
  return `team=${view.completed_count}/${view.task_count}:blocked=${view.blocker_count}`;
}

function adapterSegment(snapshot: Readonly<HudSnapshotV1>): string {
  return snapshot.adapters.length === 0
    ? 'adapters=disabled'
    : `adapters=${snapshot.adapters.map((entry) => `${entry.adapter}:${entry.status}`).join(',')}`;
}

/**
 * full：把 snapshot 已收集但 focused 沒顯示的診斷欄位攤開。
 * 這些欄位（iteration / review cycle / no-progress streak / blocker ids / worker bindings）
 * 一直存在於 `collectHudSnapshot`，只是先前沒有任何 text 路徑會顯示它們。
 */
function fullDetailSegments(snapshot: Readonly<HudSnapshotV1>): string[] {
  const segments: string[] = [];
  if (snapshot.session !== null && snapshot.session.status === 'available') {
    const view: HudSessionViewV1 = snapshot.session;
    segments.push(`iter=${view.iteration}`);
    segments.push(`review=${view.review_cycle}`);
    segments.push(`streak=${view.no_progress_streak}`);
    segments.push(`evidence=${view.accepted_evidence_count}/${view.verified_artifact_count}`);
    segments.push(`binding=${view.binding_state}`);
    if (view.terminal_phase !== null) segments.push(`terminal=${view.terminal_phase}`);
    if (view.retryable_blocker_kind !== null) {
      segments.push(`retryable=${view.retryable_blocker_kind}`);
    }
    if (view.interaction_blocked) segments.push('interaction=blocked');
  }
  if (snapshot.team !== null && snapshot.team.status === 'available') {
    const view: HudTeamViewV1 = snapshot.team;
    segments.push(`active=${view.active_count}`);
    segments.push(`terminal_tasks=${view.terminal_count}`);
    segments.push(`mailbox=${view.mailbox_message_count}`);
    segments.push(`workers=${view.worker_binding_count}`);
    segments.push(`supervisor=${view.supervisor_present ? 'present' : 'absent'}`);
    // blocker 只給數量無法行動，full 一律列出實際 task id。
    if (view.blockers.length > 0) segments.push(`blockers=${view.blockers.join(',')}`);
  }
  return segments;
}
