import * as path from 'path';
import { parseSkillCommand, runSkillCommand } from '../../src/cli/skill-commands';

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
