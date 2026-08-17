import * as path from 'path';
import {
  DEFAULT_SKILL_RENDER_FORMAT,
  parseSkillCommand,
  renderSkillCommandText,
  renderSkillErrorText,
  runSkillCommand,
} from '../../src/cli/skill-commands';
import { runtimeError } from '../../src/runtime/errors';

const packageRoot = path.resolve(__dirname, '../..');

describe('oma skill commands', () => {
  test('parses list/show/help', () => {
    expect(parseSkillCommand(['list'])).toEqual({ ok: true, value: { kind: 'list' } });
    expect(parseSkillCommand(['show', 'autopilot'])).toEqual({
      ok: true,
      value: { kind: 'show', name: 'autopilot' },
    });
    expect(parseSkillCommand([])).toEqual({ ok: true, value: { kind: 'help' } });
  });

  test('lists workflow skills including OMX five-phase set', () => {
    const listed = runSkillCommand({ kind: 'list' }, packageRoot);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const names = (listed.value as { skills: Array<{ name: string }> }).skills.map((s) => s.name);
    for (const need of [
      'autopilot', 'deep-interview', 'ralplan', 'ultragoal', 'code-review', 'ultraqa', 'ralph',
    ]) {
      expect(names).toContain(need);
    }
  });

  test('shows autopilot skill markdown body', () => {
    const shown = runSkillCommand({ kind: 'show', name: 'autopilot' }, packageRoot);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    const body = (shown.value as { markdown: string }).markdown;
    expect(body).toMatch(/deep-interview/);
    expect(body).toMatch(/ralplan/);
  });
});

// 設計概念映射：`oma doctor` 的 text/json 雙路徑；OMX `omx skill` 的人類可讀清單。
describe('oma skill render format', () => {
  test('defaults to text and parses --json / --text without breaking bare parsing', () => {
    expect(DEFAULT_SKILL_RENDER_FORMAT).toBe('text');
    // 回溯相容：未帶旗標時解析結果不得多出欄位。用 toStrictEqual，因為 toEqual
    // 會把 { kind: 'list', format: undefined } 判為等於 { kind: 'list' }。
    expect(parseSkillCommand(['list'])).toStrictEqual({ ok: true, value: { kind: 'list' } });
    expect(parseSkillCommand([])).toStrictEqual({ ok: true, value: { kind: 'help' } });
    expect(parseSkillCommand(['show', 'autopilot'])).toStrictEqual({
      ok: true,
      value: { kind: 'show', name: 'autopilot' },
    });
    expect(parseSkillCommand(['list', '--json'])).toStrictEqual({
      ok: true,
      value: { kind: 'list', format: 'json' },
    });
    expect(parseSkillCommand(['--text', 'show', 'autopilot'])).toStrictEqual({
      ok: true,
      value: { kind: 'show', name: 'autopilot', format: 'text' },
    });
    expect(parseSkillCommand(['--json'])).toStrictEqual({
      ok: true,
      value: { kind: 'help', format: 'json' },
    });
  });

  test('rejects conflicting format flags instead of silently picking one', () => {
    for (const argv of [['list', '--json', '--text'], ['list', '--text', '--json']]) {
      const conflicted = parseSkillCommand(argv);
      expect(conflicted.ok).toBe(false);
      if (conflicted.ok) return;
      expect(conflicted.error.code).toBe('E_VALIDATOR_REJECTED');
    }
  });

  // 與 `parseDoctorCliOptions` 對齊：doctor 會以「duplicate option」拒絕重複旗標，
  // skill 面若靜默吸收就與它宣稱對齊的慣例不一致。
  test('rejects a repeated format flag, matching the doctor convention', () => {
    const repeated = parseSkillCommand(['list', '--json', '--json']);
    expect(repeated.ok).toBe(false);
    if (repeated.ok) return;
    expect(repeated.error.code).toBe('E_VALIDATOR_REJECTED');
    expect(repeated.error.message).toMatch(/duplicate option --json/);
  });

  // `--` 之後為字面值，讓名稱像旗標的 skill 仍可定址（回復舊版把 --json 當名稱的能力）。
  test('a -- terminator makes flag-like skill names addressable again', () => {
    expect(parseSkillCommand(['show', '--', '--json'])).toStrictEqual({
      ok: true,
      value: { kind: 'show', name: '--json' },
    });
    expect(parseSkillCommand(['--text', 'show', '--', '--json'])).toStrictEqual({
      ok: true,
      value: { kind: 'show', name: '--json', format: 'text' },
    });
  });

  test('text list output is human readable and not JSON', () => {
    const listed = runSkillCommand({ kind: 'list' }, packageRoot);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const text = renderSkillCommandText({ kind: 'list' }, listed.value);
    expect(text.startsWith('{')).toBe(false);
    expect(text).not.toMatch(/"name":/);
    expect(text).toMatch(/^oma skill list \(\d+ skills\)/);
    expect(text).toMatch(/\n {2}autopilot\s+skills\/autopilot\/SKILL\.md\n/);
    expect(text).toMatch(/Show one: oma skill show <name>/);
    expect(text.endsWith('\n')).toBe(true);
  });

  test('text show output emits the markdown body itself, not a JSON envelope', () => {
    const shown = runSkillCommand({ kind: 'show', name: 'autopilot' }, packageRoot);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    const text = renderSkillCommandText({ kind: 'show', name: 'autopilot' }, shown.value);
    expect(text).toMatch(/^# autopilot — skills\/autopilot\/SKILL\.md\n/);
    // 斷言「不是 JSON envelope」本身，而非字面反斜線-n；後者會被 SKILL.md 內
    // 任何 shell 範例誤觸發，與本功能無關。
    expect(() => JSON.parse(text)).toThrow();
    expect(text).toMatch(/ralplan/);
  });

  test('text help output documents both format flags', () => {
    const help = runSkillCommand({ kind: 'help' }, packageRoot);
    expect(help.ok).toBe(true);
    if (!help.ok) return;
    const text = renderSkillCommandText({ kind: 'help' }, help.value);
    expect(text).toMatch(/--json/);
    expect(text).toMatch(/--text/);
    expect(text).toMatch(/oma skill list/);
    // help 不得宣稱不存在的能力：格式由旗標決定，CLI 從不檢查 stdout 是否為 TTY。
    expect(text).not.toMatch(/terminal|piped|TTY|isTTY/i);
    expect(text).toMatch(/Default output is human-readable text/);
  });

  test('text error output lists available skills so the user need not read the tree', () => {
    const missing = runSkillCommand({ kind: 'show', name: 'no-such-skill' }, packageRoot);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('E_NOT_FOUND');
    const text = renderSkillErrorText(missing.error);
    expect(text).toMatch(/^E_NOT_FOUND: Unknown skill: no-such-skill\n/);
    expect(text).toMatch(/Available skills:/);
    expect(text).toMatch(/\n {2}autopilot\n/);
    expect(text).toMatch(/Try: oma skill show <name>/);
  });

  test('error rendering degrades gracefully when no available list is attached', () => {
    const text = renderSkillErrorText(runtimeError('E_VALIDATOR_REJECTED', 'bad usage'));
    expect(text).toBe('E_VALIDATOR_REJECTED: bad usage\n');
  });
});
