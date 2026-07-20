import * as fs from 'fs';
import * as path from 'path';
import { ModeDirectiveRenderer } from '../../src/modes/directives';
import {
  listWorkflowSkillNames,
  loadSkillMarkdown,
  skillNameForManagedMode,
} from '../../src/modes/skill-loader';
import { appendSkillProtocol, extractSkillProtocol } from '../../src/modes/skill-protocol';

const packageRoot = path.resolve(__dirname, '../..');

describe('OMA session skill surface', () => {
  test('required workflow skills exist with non-empty SKILL.md', () => {
    const required = [
      'oma-runtime',
      'autopilot',
      'ralph',
      'ultrawork',
      'search',
      'team',
      'cancel',
      'verify',
      'setup',
    ];
    const present = listWorkflowSkillNames(packageRoot);
    for (const name of required) {
      expect(present).toContain(name);
      const body = loadSkillMarkdown(packageRoot, name as any);
      expect(body).not.toBeNull();
      expect((body ?? '').length).toBeGreaterThan(200);
      expect(body).toMatch(/Purpose|purpose|## /);
    }
  });

  test('managed modes map to skill names and inject protocol outside task delimiters', () => {
    const renderer = new ModeDirectiveRenderer(() => '00112233445566778899aabbccddeeff');
    for (const mode of ['ralph', 'ultrawork', 'search'] as const) {
      expect(skillNameForManagedMode(mode)).toBe(mode);
      const rendered = renderer.render(`oma.${mode}/v1` as any, Buffer.from('do the thing'));
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;
      const withSkill = appendSkillProtocol(rendered.value.directive, mode, packageRoot);
      expect(withSkill).toContain('<<<OMA_SKILL_PROTOCOL');
      expect(withSkill).toContain('<<<OMA_SKILL_PROTOCOL_END>>>');
      expect(withSkill).toContain(`skill=${mode}`);
      // task delimiters still present; protocol is outside task body
      expect(withSkill).toContain('<<<OMA_TASK_END');
      const extracted = extractSkillProtocol(withSkill);
      expect(extracted).not.toBeNull();
      // original task extraction still works (protocol after end marker)
      const task = renderer.extractTask(`oma.${mode}/v1` as any, withSkill);
      expect(task.ok).toBe(true);
      if (task.ok) expect(task.value.toString('utf8')).toBe('do the thing');
    }
  });

  test('npm pack files include skills directory entries', () => {
    const skillsRoot = path.join(packageRoot, 'skills');
    expect(fs.existsSync(skillsRoot)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('skills');
  });
});
