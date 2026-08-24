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
    // 與上方計數一致：completed(1) + failed(1) + in_progress(1) + awaiting_interaction(1)
    // → task_count 4、terminal_count 2（completed + failed）、blockers = [task-b, task-d]
    tasks: [
      {
        task_id: 'task-a',
        revision: 1,
        status: 'completed',
        generation: 1,
        lease_expired: null,
        has_progress: true,
        command_evidence_count: 2,
        worker_provider: 'agy',
        worker_state: 'exited',
      },
      {
        task_id: 'task-b',
        revision: 1,
        status: 'failed',
        generation: 1,
        lease_expired: null,
        has_progress: true,
        command_evidence_count: 1,
        worker_provider: 'agy',
        worker_state: 'exited',
      },
      {
        task_id: 'task-c',
        revision: 2,
        status: 'in_progress',
        generation: 2,
        lease_expired: false,
        has_progress: true,
        command_evidence_count: 0,
        worker_provider: 'agy',
        worker_state: 'running',
      },
      {
        task_id: 'task-d',
        revision: 1,
        status: 'awaiting_interaction',
        generation: 1,
        lease_expired: false,
        has_progress: false,
        command_evidence_count: 0,
        worker_provider: null,
        worker_state: null,
      },
    ],
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
    // adapter 的 detail_code 是排查用資訊；status 只說可用與否
    expect(text).toContain('adapter_details=antigravity_public:ok');
  });

  /**
   * 第二個 fixture 專門覆蓋 RICH 沒有觸發的條件分支：terminal_phase / retryable_blocker_kind /
   * interaction_blocked 的 true 路徑，以及 supervisor_present 的 false 路徑。
   * 沒有這個 fixture 時，把 render.ts 的那幾行整段刪掉，測試依然全綠。
   */
  const DEGRADED: HudSnapshotV1 = {
    ...RICH,
    session: {
      ...(RICH.session as Exclude<HudSnapshotV1['session'], null | { status: 'unavailable' | 'corrupt' }>),
      phase: 'ultraqa',
      revision: 9,
      generation: 4,
      terminal_phase: 'cancelled',
      retryable_blocker_kind: 'rate_limit',
      interaction_blocked: true,
      no_progress_streak: 5,
      iteration: 20,
      review_cycle: 3,
      accepted_evidence_count: 1,
      verified_artifact_count: 0,
      binding_state: 'launch_pending',
    },
    team: {
      ...(RICH.team as Exclude<HudSnapshotV1['team'], null | { status: 'unavailable' | 'corrupt' }>),
      supervisor_present: false,
      blockers: [],
      blocker_count: 0,
    },
  };

  test('full renders the terminal, retryable, interaction, and absent-supervisor branches', () => {
    const text = renderHudText(DEGRADED, 'full');
    // 完整逐字斷言：toContain 無法約束區段順序，也擋不住多出來的垃圾區段
    expect(text).toBe(
      'oma-hud session=ultraqa@r9:g4 team=1/4:blocked=0'
      + ' adapters=antigravity_public:public_cli_observed'
      + ' iter=20 review=3 streak=5 evidence=1/0 binding=launch_pending'
      + ' terminal=cancelled retryable=rate_limit interaction=blocked'
      + ' active=1 terminal_tasks=2 mailbox=3 workers=2 supervisor=absent'
      + ' adapter_details=antigravity_public:ok',
    );
    // blockers 為空時不得輸出空的 blockers= 區段
    expect(text).not.toContain('blockers=');
  });

  test('full appends without rewriting, so the focused prefix stays parseable', () => {
    const focused = renderHudText(RICH, 'focused');
    const full = renderHudText(RICH, 'full');
    expect(full.startsWith(`${focused} `)).toBe(true);
    // adapters= 區段本身不得被改寫成別的形狀
    expect(full).toContain('adapters=antigravity_public:public_cli_observed');
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
