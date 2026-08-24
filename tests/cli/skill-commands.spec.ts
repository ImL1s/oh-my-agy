import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_SKILL_RENDER_FORMAT,
  parseSkillCommand,
  renderSkillCommandText,
  renderSkillErrorText,
  runSkillCommand,
  type SkillListViewV1,
  type SkillSearchViewV1,
} from '../../src/cli/skill-commands';
import { formatCliError } from '../../src/runtime/error-catalog';
import { runtimeError } from '../../src/runtime/errors';
import { createStateFixture } from '../helpers/state-fixture';

const packageRoot = path.resolve(__dirname, '../..');

describe('oma skill commands', () => {
  test('parses list/show/help/search', () => {
    expect(parseSkillCommand(['list'])).toEqual({ ok: true, value: { kind: 'list' } });
    expect(parseSkillCommand(['show', 'autopilot'])).toEqual({
      ok: true,
      value: { kind: 'show', name: 'autopilot' },
    });
    expect(parseSkillCommand([])).toEqual({ ok: true, value: { kind: 'help' } });
    expect(parseSkillCommand(['search', 'verify'])).toStrictEqual({
      ok: true,
      value: { kind: 'search', query: 'verify' },
    });
    expect(parseSkillCommand(['search'])).toStrictEqual({
      ok: true,
      value: { kind: 'search', query: '' },
    });
    expect(parseSkillCommand(['search', 'foo', 'bar', '--json'])).toStrictEqual({
      ok: true,
      value: { kind: 'search', query: 'foo bar', format: 'json' },
    });
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
    expect(names).not.toContain('discovery-proof');
    expect(names).not.toContain('doctor');
  });

  test('list --all includes internal discovery-proof and show doctor is E_NOT_FOUND', () => {
    expect(parseSkillCommand(['list', '--all'])).toStrictEqual({
      ok: true,
      value: { kind: 'list', includeInternal: true },
    });
    expect(parseSkillCommand(['--all', 'list', '--json'])).toStrictEqual({
      ok: true,
      value: { kind: 'list', format: 'json', includeInternal: true },
    });
    const all = runSkillCommand({ kind: 'list', includeInternal: true }, packageRoot);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const names = (all.value as { skills: Array<{ name: string }> }).skills.map((s) => s.name);
    expect(names).toContain('discovery-proof');
    const canary = runSkillCommand({ kind: 'show', name: 'discovery-proof' }, packageRoot);
    expect(canary.ok).toBe(true);
    const shown = runSkillCommand({ kind: 'show', name: 'doctor' }, packageRoot);
    expect(shown.ok).toBe(false);
    if (shown.ok) return;
    expect(shown.error.code).toBe('E_NOT_FOUND');
  });

  test('rejects --all outside list and duplicate --all', () => {
    const onShow = parseSkillCommand(['show', 'autopilot', '--all']);
    expect(onShow.ok).toBe(false);
    if (onShow.ok) return;
    expect(onShow.error.code).toBe('E_VALIDATOR_REJECTED');
    const duplicated = parseSkillCommand(['list', '--all', '--all']);
    expect(duplicated.ok).toBe(false);
    if (duplicated.ok) return;
    expect(duplicated.error.message).toMatch(/duplicate option --all/);
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
    expect(text).toMatch(/Search: oma skill search <query>/);
    expect(text).toContain('In-session OMA autonomous delivery');
    expect(text).toContain('argument-hint: <product idea or task>');
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
    expect(text).toMatch(/oma skill search/);
    // help 不得宣稱不存在的能力：格式由旗標決定，CLI 從不檢查 stdout 是否為 TTY。
    expect(text).not.toMatch(/terminal|piped|TTY|isTTY/i);
    expect(text).toMatch(/Default output is human-readable text/);
    expect(text).toMatch(/--all/);
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
    expect(text).not.toMatch(/\n {2}discovery-proof\n/);
    expect(text).toMatch(/Try: oma skill show <name>/);
  });

  test('error rendering degrades gracefully when no available list is attached', () => {
    const text = renderSkillErrorText(runtimeError('E_VALIDATOR_REJECTED', 'bad usage'));
    expect(text).toBe(formatCliError('E_VALIDATOR_REJECTED', 'bad usage'));
  });
});

// 設計概念映射：OMX `$skill` search / `omx list --json` 欄位；OMC skill YAML description。
describe('oma skill list JSON frontmatter and search', () => {
  test('list JSON rows include name, path, description, argumentHint in that order', () => {
    const listed = runSkillCommand({ kind: 'list' }, packageRoot);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const view = listed.value as SkillListViewV1;
    expect(view.skills.length).toBeGreaterThan(0);
    for (const skill of view.skills) {
      expect(Object.keys(skill)).toEqual(['name', 'path', 'description', 'argumentHint']);
      expect(skill.path).toBe(`skills/${skill.name}/SKILL.md`);
      expect(skill.description === null || typeof skill.description === 'string').toBe(true);
      expect(skill.argumentHint === null || typeof skill.argumentHint === 'string').toBe(true);
    }
    const verify = view.skills.find((skill) => skill.name === 'verify');
    expect(verify).toBeDefined();
    expect((verify?.description ?? '').length).toBeGreaterThan(0);
    expect(verify?.argumentHint).toBeNull();
    const autopilot = view.skills.find((skill) => skill.name === 'autopilot');
    expect(autopilot?.argumentHint).toBe('<product idea or task>');
    expect(view.skills.map((skill) => skill.name)).not.toContain('discovery-proof');
  });

  test('corrupt frontmatter fail-opens with null description without failing list', () => {
    const fixture = createStateFixture('oma-skill-frontmatter-');
    try {
      const goodDir = path.join(fixture.root, 'skills', 'good');
      const badDir = path.join(fixture.root, 'skills', 'broken');
      fs.mkdirSync(goodDir, { recursive: true });
      fs.mkdirSync(badDir, { recursive: true });
      fs.writeFileSync(
        path.join(goodDir, 'SKILL.md'),
        '---\nname: good\ndescription: "ok row"\nargument-hint: "<hint>"\n---\n\n# good\n',
        'utf8',
      );
      fs.writeFileSync(path.join(badDir, 'SKILL.md'), 'not valid frontmatter\n', 'utf8');
      const listed = runSkillCommand({ kind: 'list' }, fixture.root);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const view = listed.value as SkillListViewV1;
      expect(view.skills).toEqual([
        {
          name: 'broken',
          path: 'skills/broken/SKILL.md',
          description: null,
          argumentHint: null,
        },
        {
          name: 'good',
          path: 'skills/good/SKILL.md',
          description: 'ok row',
          argumentHint: '<hint>',
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test('search verify hits verify; empty and unknown queries return empty lists', () => {
    const hit = runSkillCommand({ kind: 'search', query: 'verify' }, packageRoot);
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    const view = hit.value as SkillSearchViewV1;
    expect(view.query).toBe('verify');
    expect(view.skills.map((skill) => skill.name)).toContain('verify');
    expect(view.skills.map((skill) => skill.name)).not.toContain('discovery-proof');
    for (const skill of view.skills) {
      expect(Object.keys(skill)).toEqual(['name', 'path', 'description', 'argumentHint']);
    }

    const again = runSkillCommand({ kind: 'search', query: 'verify' }, packageRoot);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(JSON.stringify(again.value)).toBe(JSON.stringify(hit.value));
    expect(renderSkillCommandText({ kind: 'search', query: 'verify' }, again.value))
      .toBe(renderSkillCommandText({ kind: 'search', query: 'verify' }, hit.value));

    for (const query of ['', '   ', 'no-such-skill-zzzxxyy-issue-53']) {
      const miss = runSkillCommand({ kind: 'search', query }, packageRoot);
      expect(miss.ok).toBe(true);
      if (!miss.ok) return;
      expect((miss.value as SkillSearchViewV1).skills).toEqual([]);
      const text = renderSkillCommandText({ kind: 'search', query }, miss.value);
      expect(text).toMatch(/no matching skills/);
    }
  });

  test('show output is unchanged by frontmatter parsing', () => {
    const shown = runSkillCommand({ kind: 'show', name: 'autopilot' }, packageRoot);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(Object.keys(shown.value as object).sort()).toEqual(['markdown', 'name', 'path']);
    const text = renderSkillCommandText({ kind: 'show', name: 'autopilot' }, shown.value);
    expect(text).toMatch(/^# autopilot — skills\/autopilot\/SKILL\.md\n/);
    expect(text).toContain('---\nname: autopilot\n');
  });

  test('--json|--text still apply to search; --all does not', () => {
    expect(parseSkillCommand(['search', 'verify', '--json'])).toStrictEqual({
      ok: true,
      value: { kind: 'search', query: 'verify', format: 'json' },
    });
    expect(parseSkillCommand(['--text', 'search', 'verify'])).toStrictEqual({
      ok: true,
      value: { kind: 'search', query: 'verify', format: 'text' },
    });
    const withAll = parseSkillCommand(['search', 'verify', '--all']);
    expect(withAll.ok).toBe(false);
    if (withAll.ok) return;
    expect(withAll.error.code).toBe('E_VALIDATOR_REJECTED');
  });
});
