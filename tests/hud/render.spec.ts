/**
 * HUD preset 呈現契約。設計概念映射：OMX `omx hud --preset=minimal|focused|full`、
 * OMC `/oh-my-claudecode:hud minimal|focused|full`。
 * 重點在於 `focused` 必須與導入 preset 之前逐字相同（回溯相容），
 * 且 `--json` 不得受 preset 影響。
 */
import {
  DEFAULT_HUD_PRESET,
  HUD_PRESETS,
  isHudPreset,
  renderHud,
  renderHudText,
} from '../../src/hud/render';
import { HudSnapshotV1 } from '../../src/hud/status';

const EMPTY: HudSnapshotV1 = {
  store_kind: 'oma_hud_snapshot',
  schema_version: 1,
  repository_id: 'OMA',
  collected_at: '2026-08-18T00:00:00.000Z',
  session: null,
  team: null,
  adapters: [],
  core_available: false,
};

const RICH: HudSnapshotV1 = {
  ...EMPTY,
  session: {
    status: 'available',
    session_id_sha256: 'a'.repeat(64),
    aggregate_id: 'agg-1',
    aggregate_sha256: 'b'.repeat(64),
    revision: 7,
    phase: 'ultragoal',
    terminal_phase: null,
    terminal_reason_sha256: null,
    conversation_bound: true,
    binding_state: 'bound',
    generation: 3,
    owner_present: true,
    retryable_blocker_kind: null,
    interaction_blocked: false,
    no_progress_streak: 2,
    iteration: 11,
    review_cycle: 1,
    accepted_evidence_count: 4,
    verified_artifact_count: 2,
  },
  team: {
    status: 'available',
    team_id: 'team-1',
    revision: 5,
    manifest_revision: 2,
    task_count: 4,
    completed_count: 1,
    terminal_count: 2,
    active_count: 1,
    blocker_count: 2,
    blockers: ['task-b', 'task-d'],
    mailbox_message_count: 3,
    worker_binding_count: 2,
    supervisor_present: true,
    tasks: [],
  },
  adapters: [
    {
      adapter: 'antigravity_public',
      status: 'public_cli_observed',
      observed: true,
      enabled: true,
      detail_code: 'ok',
    },
  ],
  core_available: true,
};

describe('HUD preset rendering', () => {
  test('preset metadata is well formed and defaults to focused', () => {
    expect(HUD_PRESETS).toEqual(['minimal', 'focused', 'full']);
    expect(DEFAULT_HUD_PRESET).toBe('focused');
    expect(isHudPreset('full')).toBe(true);
    expect(isHudPreset('bogus')).toBe(false);
    expect(isHudPreset(undefined)).toBe(false);
  });

  // 回溯相容：未指定 preset 時的輸出必須與 focused 逐字相同。
  test('omitting the preset is byte-identical to focused', () => {
    expect(renderHudText(RICH)).toBe(renderHudText(RICH, 'focused'));
    expect(renderHudText(EMPTY)).toBe(renderHudText(EMPTY, 'focused'));
    expect(renderHud(RICH, 'text')).toBe(renderHudText(RICH, 'focused'));
  });

  test('focused keeps the previously shipped single-line shape', () => {
    expect(renderHudText(EMPTY, 'focused')).toBe('oma-hud session=- team=- adapters=disabled');
    expect(renderHudText(RICH, 'focused')).toBe(
      'oma-hud session=ultragoal@r7:g3 team=1/4:blocked=2'
      + ' adapters=antigravity_public:public_cli_observed',
    );
  });

  test('minimal drops revision, generation, blockers, and adapters', () => {
    expect(renderHudText(RICH, 'minimal')).toBe('oma-hud session=ultragoal team=1/4');
    expect(renderHudText(EMPTY, 'minimal')).toBe('oma-hud session=- team=-');
    expect(renderHudText(RICH, 'minimal')).not.toContain('adapters=');
  });

  test('full surfaces diagnostics the snapshot already collected but focused hid', () => {
    const text = renderHudText(RICH, 'full');
    expect(text.startsWith(renderHudText(RICH, 'focused'))).toBe(true);
    expect(text).toContain('iter=11');
    expect(text).toContain('review=1');
    expect(text).toContain('streak=2');
    expect(text).toContain('evidence=4/2');
    expect(text).toContain('binding=bound');
    expect(text).toContain('active=1');
    expect(text).toContain('mailbox=3');
    expect(text).toContain('workers=2');
    expect(text).toContain('supervisor=present');
    // blocker 只給數量無法行動，full 必須列出實際 task id
    expect(text).toContain('blockers=task-b,task-d');
  });

  test('full degrades to focused when nothing is bound', () => {
    expect(renderHudText(EMPTY, 'full')).toBe(renderHudText(EMPTY, 'focused'));
  });

  test('unavailable views are reported, never silently treated as healthy', () => {
    const broken: HudSnapshotV1 = {
      ...EMPTY,
      session: { status: 'corrupt', code: 'E_CORRUPT_STATE', detail: 'bad aggregate' },
      team: { status: 'unavailable', code: 'E_NOT_FOUND', detail: 'missing' },
    };
    expect(renderHudText(broken, 'minimal')).toBe('oma-hud session=corrupt team=unavailable');
    expect(renderHudText(broken, 'focused')).toContain('session=corrupt:E_CORRUPT_STATE');
    expect(renderHudText(broken, 'focused')).toContain('team=unavailable:E_NOT_FOUND');
    // full 不得因為沒有 available view 就吞掉錯誤狀態
    expect(renderHudText(broken, 'full')).toContain('session=corrupt:E_CORRUPT_STATE');
  });

  test('json output is a machine contract and never varies by preset', () => {
    const asJson = renderHud(RICH, 'json');
    for (const preset of HUD_PRESETS) {
      expect(renderHud(RICH, 'json', preset)).toBe(asJson);
    }
    expect(() => JSON.parse(asJson)).not.toThrow();
  });
});
