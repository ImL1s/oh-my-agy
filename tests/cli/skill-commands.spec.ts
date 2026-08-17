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
    // 回溯相容：未帶旗標時解析結果不得多出欄位
    expect(parseSkillCommand(['list'])).toEqual({ ok: true, value: { kind: 'list' } });
    expect(parseSkillCommand(['list', '--json'])).toEqual({
      ok: true,
      value: { kind: 'list', format: 'json' },
    });
    expect(parseSkillCommand(['--text', 'show', 'autopilot'])).toEqual({
      ok: true,
      value: { kind: 'show', name: 'autopilot', format: 'text' },
    });
    expect(parseSkillCommand(['--json'])).toEqual({
      ok: true,
      value: { kind: 'help', format: 'json' },
    });
  });

  test('rejects conflicting format flags instead of silently picking one', () => {
    const conflicted = parseSkillCommand(['list', '--json', '--text']);
    expect(conflicted.ok).toBe(false);
    if (conflicted.ok) return;
    expect(conflicted.error.code).toBe('E_VALIDATOR_REJECTED');
  });

  test('repeating the same format flag stays valid', () => {
    expect(parseSkillCommand(['list', '--json', '--json'])).toEqual({
      ok: true,
      value: { kind: 'list', format: 'json' },
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
    expect(text).not.toMatch(/\\n/);
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
