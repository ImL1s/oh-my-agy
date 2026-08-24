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
import {
  AUTHORIZED_CATALOG_FILES,
  applySkillCatalogs,
  checkSkillCatalogs,
  resolveAuthorizedWritePath,
  runCatalogCli,
} from '../../scripts/generate-skill-catalog';
import { createStateFixture } from '../helpers/state-fixture';

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
      'wiki',
      'hud',
      'plan',
      'trace',
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
    const typed: OmaWorkflowSkill[] = ['ask', 'wiki', 'hud', 'plan', 'trace', 'workflow', 'oma-runtime', 'verify'];
    for (const name of typed) {
      expect(listWorkflowSkillNames(packageRoot)).toContain(name);
      expect(loadSkillMarkdown(packageRoot, name)).not.toBeNull();
    }
  });

  // 設計概念映射：OMC/OMX 的 skill 解析面；OMA 以此確保每個出貨目錄都讀得出 frontmatter，
  // 且 frontmatter 的 name 必須等於目錄名 —— 否則 host 註冊出來的 slash 名稱會與目錄不符。
  test('every shipped skill directory is loadable with frontmatter name matching the directory', () => {
    for (const name of listWorkflowSkillNames(packageRoot)) {
      const body = loadSkillMarkdown(packageRoot, name as any);
      expect(body).not.toBeNull();
      const text = body ?? '';
      expect(text).toMatch(/^---\n/);
      expect(text).toMatch(/\ndescription:\s*\S/);
      const declared = /\nname:\s*["']?([A-Za-z0-9._-]+)["']?\s*(\n|$)/.exec(text)?.[1];
      expect(declared).toBe(name);
    }
  });

  test('npm pack files include skills directory entries', () => {
    const skillsRoot = path.join(packageRoot, 'skills');
    expect(fs.existsSync(skillsRoot)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('skills');
  });
  // 設計概念映射：OMX generate-catalog-docs / OMG operation catalog golden tests。
  test('markdown catalogs name every on-disk skill and match the generator', () => {
    const onDisk = listWorkflowSkillNames(packageRoot);
    expect(onDisk).toEqual(expect.arrayContaining(['ask', 'workflow', 'discovery-proof']));
    const agents = fs.readFileSync(path.join(packageRoot, 'skills', 'AGENTS.md'), 'utf8');
    const runtime = fs.readFileSync(path.join(packageRoot, 'skills', 'oma-runtime', 'SKILL.md'), 'utf8');
    for (const name of onDisk) {
      expect(agents).toContain(`\`${name}/SKILL.md\``);
      expect(runtime).toContain(`\`/oh-my-agy:${name}\``);
    }
    const result = checkSkillCatalogs(packageRoot);
    expect(result.message).toBe('skill catalog check ok');
    expect(result.ok).toBe(true);
    expect(result.drifted).toEqual([]);
    // GFM 以未跳脫的 `|` 切欄；CLI helper 裡的 pipe 必須是 `\|`。
    expect(runtime).toMatch(/oma wiki index\\\|list\\\|search/);
    expect(runtime).toMatch(/minimal\\\|focused\\\|full/);
    expect(runtime).toMatch(/start\\\|status\\\|tick/);
    const planBody = loadSkillMarkdown(packageRoot, 'plan');
    expect(planBody).toMatch(/no `oma plan` CLI/i);
    expect(planBody).toMatch(/upgrade to `ralplan`/i);
    expect(planBody).toMatch(/\.agy\/plans\//);
    const traceBody = loadSkillMarkdown(packageRoot, 'trace');
    expect(traceBody).toMatch(/compet/i);
    expect(traceBody).toMatch(/no `oma trace` CLI/i);
    expect(traceBody).toMatch(/\.agy\/trace\//);
  });

  test('catalog generator write targets are only the two authorized catalog files', () => {
    expect([...AUTHORIZED_CATALOG_FILES]).toEqual([
      'skills/AGENTS.md',
      'skills/oma-runtime/SKILL.md',
    ]);
    expect(resolveAuthorizedWritePath(packageRoot, 'skills/AGENTS.md'))
      .toBe(path.resolve(packageRoot, 'skills/AGENTS.md'));
    expect(resolveAuthorizedWritePath(packageRoot, 'skills/oma-runtime/SKILL.md'))
      .toBe(path.resolve(packageRoot, 'skills/oma-runtime/SKILL.md'));
    expect(() => resolveAuthorizedWritePath(packageRoot, 'AGENTS.md'))
      .toThrow('Unauthorized catalog write target');
    expect(() => resolveAuthorizedWritePath(packageRoot, 'skills/ask/SKILL.md'))
      .toThrow('Unauthorized catalog write target');
    expect(() => resolveAuthorizedWritePath(packageRoot, 'skills/../AGENTS.md'))
      .toThrow('Unsafe catalog path');
  });

  test('adding a skill directory without regenerating catalogs fails --check', () => {
    const fixture = createStateFixture('oma-skill-catalog-');
    try {
      fs.writeFileSync(path.join(fixture.root, 'AGENTS.md'), '# root guidance\n', 'utf8');
      writeCatalogFixture(fixture.root, ['oma-runtime', 'autopilot']);
      expect(checkSkillCatalogs(fixture.root).ok).toBe(false);
      expect(applySkillCatalogs(fixture.root).sort()).toEqual([
        'skills/AGENTS.md',
        'skills/oma-runtime/SKILL.md',
      ]);
      expect(checkSkillCatalogs(fixture.root).ok).toBe(true);
      expect(runCatalogCli(['--check'], fixture.root)).toBe(0);

      fs.mkdirSync(path.join(fixture.root, 'skills', 'zzz-extra'));
      fs.writeFileSync(
        path.join(fixture.root, 'skills', 'zzz-extra', 'SKILL.md'),
        '---\nname: zzz-extra\ndescription: "Temporary extra skill"\n---\n\n# zzz-extra\n',
        'utf8',
      );
      const drifted = checkSkillCatalogs(fixture.root);
      expect(drifted.ok).toBe(false);
      expect(runCatalogCli(['--check'], fixture.root)).toBe(1);
      expect(drifted.missingByFile['skills/AGENTS.md']).toContain('zzz-extra');
      expect(drifted.missingByFile['skills/oma-runtime/SKILL.md']).toContain('zzz-extra');
      expect(drifted.message).toMatch(/zzz-extra/);

      const before = listRelativeFiles(fixture.root);
      const written = applySkillCatalogs(fixture.root);
      expect(written.sort()).toEqual(['skills/AGENTS.md', 'skills/oma-runtime/SKILL.md']);
      expect(listRelativeFiles(fixture.root)).toEqual(before);
      expect(fs.readFileSync(path.join(fixture.root, 'AGENTS.md'), 'utf8')).toBe('# root guidance\n');
      expect(checkSkillCatalogs(fixture.root).ok).toBe(true);
      expect(fs.readFileSync(path.join(fixture.root, 'skills', 'AGENTS.md'), 'utf8'))
        .toContain('`zzz-extra/SKILL.md`');
      expect(fs.readFileSync(path.join(fixture.root, 'skills', 'oma-runtime', 'SKILL.md'), 'utf8'))
        .toContain('`/oh-my-agy:zzz-extra`');
    } finally {
      fixture.cleanup();
    }
  });
});

function writeCatalogFixture(root: string, names: readonly string[]): void {
  for (const name of names) {
    fs.mkdirSync(path.join(root, 'skills', name), { recursive: true });
    if (name === 'oma-runtime') {
      fs.writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), [
        '---',
        'name: oma-runtime',
        'description: "index"',
        '---',
        '',
        '# index',
        '',
        '## Slash catalog',
        '',
        '<!-- OMA-SKILL-CATALOG:START -->',
        '| User intent | Canonical slash | Skill body | Optional CLI helper |',
        '|-------------|-----------------|------------|---------------------|',
        '<!-- OMA-SKILL-CATALOG:END -->',
        '',
      ].join('\n'), 'utf8');
      continue;
    }
    fs.writeFileSync(
      path.join(root, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: "${name} body"\n---\n\n# ${name}\n`,
      'utf8',
    );
  }

  fs.writeFileSync(path.join(root, 'skills', 'AGENTS.md'), [
    '# skills',
    '',
    '## Key Files',
    '',
    '<!-- OMA-SKILL-CATALOG:START -->',
    '| Path | Description |',
    '|------|-------------|',
    '<!-- OMA-SKILL-CATALOG:END -->',
    '',
  ].join('\n'), 'utf8');
}

function listRelativeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}
