import * as fs from 'fs';
import * as path from 'path';
import { ModeDirectiveRenderer } from '../../src/modes/directives';
import {
  listWorkflowSkillNames,
  loadSkillMarkdown,
  OmaWorkflowSkill,
  skillNameForManagedMode,
} from '../../src/modes/skill-loader';
import { appendSkillProtocol, extractSkillProtocol } from '../../src/modes/skill-protocol';

const packageRoot = path.resolve(__dirname, '../..');

describe('OMA session skill surface', () => {
  test('required workflow skills exist with non-empty SKILL.md', () => {
    const required = [
      'oma-runtime',
      'autopilot',
      'deep-interview',
      'ralplan',
      'ultragoal',
      'code-review',
      'ultraqa',
      'ralph',
      'ultrawork',
      'search',
      'team',
      'cancel',
      'verify',
      'setup',
      'workflow',
      'ask',
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

  // 設計概念映射：OMC/OMX 的 plugin manifest 與 skills 目錄同步；OMA 以回歸測試防止新 skill 漏註冊。
  test('Claude plugin manifest lists exactly the shipped skills directories', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { skills?: string[] };
    const declared = (manifest.skills ?? []).map((entry) =>
      entry.replace(/^\.\/skills\//, '').replace(/\/$/, ''));
    const onDisk = listWorkflowSkillNames(packageRoot);
    expect([...declared].sort()).toEqual([...onDisk].sort());
  });

  // `OmaWorkflowSkill` union 若少了某個出貨中的 skill，這個 typed literal 會在 tsc 階段就失敗；
  // 其他測試都走 `as any`，無法保護 union 本身。設計概念映射：OMC/OMX 的 skill 名稱型別化。
  test('shipped skill names are members of the OmaWorkflowSkill union', () => {
    const typed: OmaWorkflowSkill[] = ['ask', 'workflow', 'oma-runtime', 'verify'];
    for (const name of typed) {
      expect(listWorkflowSkillNames(packageRoot)).toContain(name);
      expect(loadSkillMarkdown(packageRoot, name)).not.toBeNull();
    }
  });

  // 設計概念映射：OMC/OMX 的 skill 解析面；OMA 以此確保每個出貨目錄都讀得出 frontmatter。
  test('every shipped skill directory is loadable through the skill loader', () => {
    for (const name of listWorkflowSkillNames(packageRoot)) {
      const body = loadSkillMarkdown(packageRoot, name as any);
      expect(body).not.toBeNull();
      expect((body ?? '')).toMatch(/^---\n/);
      expect((body ?? '')).toMatch(/\nname:\s*/);
      expect((body ?? '')).toMatch(/\ndescription:\s*/);
    }
  });

  test('npm pack files include skills directory entries', () => {
    const skillsRoot = path.join(packageRoot, 'skills');
    expect(fs.existsSync(skillsRoot)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('skills');
  });
});
