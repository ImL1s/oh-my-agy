import * as fs from 'fs';
import * as path from 'path';
import {
  OMA_SKILL_CATALOG_V1,
  isInternalCatalogSkill,
  listCatalogSkillNames,
  listPublicCatalogSkillNames,
  normalizeClaudePluginSkillEntry,
  type OmaWorkflowSkill,
} from '../../src/modes/skill-catalog';
import { listWorkflowSkillNames, loadSkillMarkdown } from '../../src/modes/skill-loader';
import { runSkillCommand } from '../../src/cli/skill-commands';
import { createStateFixture } from '../helpers/state-fixture';

const packageRoot = path.resolve(__dirname, '../..');

type DoctorIsNotASkill = 'doctor' extends OmaWorkflowSkill ? never : true;
const doctorExcludedFromUnion: DoctorIsNotASkill = true;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function readPluginSkillNames(root: string): string[] {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
  ) as { skills?: unknown };
  if (!Array.isArray(manifest.skills)) {
    throw new Error(`${root}: .claude-plugin/plugin.json skills[] is not an array`);
  }
  return uniqueSorted(manifest.skills.map((entry) => {
    if (typeof entry !== 'string') {
      throw new Error(`${root}: non-string plugin skill entry`);
    }
    return normalizeClaudePluginSkillEntry(entry);
  }));
}

function writeCatalogTree(root: string, names: readonly string[]): void {
  for (const name of names) {
    fs.mkdirSync(path.join(root, 'skills', name), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: "${name}"\n---\n\n# ${name}\n`,
      'utf8',
    );
  }
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({
      name: 'oh-my-agy',
      skills: names.map((name) => `./skills/${name}/`),
    }, null, 2)}\n`,
    'utf8',
  );
}

function fourWayEqual(
  catalog: readonly string[],
  disk: readonly string[],
  plugin: readonly string[],
): boolean {
  const catalogKey = uniqueSorted(catalog).join('\n');
  return catalogKey === uniqueSorted(disk).join('\n')
    && catalogKey === uniqueSorted(plugin).join('\n');
}

function extractRuntimeRule6SkillNames(runtimeMd: string): string[] {
  const line = runtimeMd.split(/\r?\n/).find((entry) => /^6\.\s/.test(entry));
  if (line === undefined) {
    throw new Error('rules/runtime.md is missing rule 6');
  }
  const match = /`skills\/` \(([^)]+)\)/.exec(line);
  if (match === null || match[1] === undefined) {
    throw new Error('rules/runtime.md rule 6 is missing a skills/ parenthetical catalog list');
  }
  return match[1].split(',').map((name) => name.trim()).filter((name) => name !== '');
}

describe('OMA_SKILL_CATALOG_V1 SSOT', () => {
  test('catalog is frozen with unique names and hostSlashForm matching /oh-my-agy:<name>', () => {
    expect(Object.isFrozen(OMA_SKILL_CATALOG_V1)).toBe(true);
    expect(doctorExcludedFromUnion).toBe(true);
    const names = listCatalogSkillNames();
    expect(uniqueSorted(names)).toEqual([...names].sort());
    expect(names as readonly string[]).not.toContain('doctor');
    expect(names.filter((name) => isInternalCatalogSkill(name))).toEqual(['discovery-proof']);
    for (const entry of OMA_SKILL_CATALOG_V1) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(entry.hostSlashForm).toBe(`/oh-my-agy:${entry.name}`);
      expect(['public', 'internal']).toContain(entry.visibility);
    }
  });

  test('four-way set equality: catalog names == skills/*/SKILL.md == plugin.json skills[]', () => {
    const catalog = uniqueSorted(listCatalogSkillNames());
    const disk = uniqueSorted(listWorkflowSkillNames(packageRoot));
    const plugin = readPluginSkillNames(packageRoot);
    expect(disk).toEqual(catalog);
    expect(plugin).toEqual(catalog);
    expect(fourWayEqual(catalog, disk, plugin)).toBe(true);
  });

  test('public catalog names appear in the oma-runtime slash table', () => {
    const runtime = fs.readFileSync(
      path.join(packageRoot, 'skills', 'oma-runtime', 'SKILL.md'),
      'utf8',
    );
    for (const name of listPublicCatalogSkillNames()) {
      expect(runtime).toContain(`\`/oh-my-agy:${name}\``);
    }
    for (const name of listCatalogSkillNames().filter((entry) => isInternalCatalogSkill(entry))) {
      expect(runtime).not.toContain(`\`/oh-my-agy:${name}\``);
    }
  });

  test('rules/runtime.md rule 6 names are a subset of the catalog', () => {
    const runtimeMd = fs.readFileSync(path.join(packageRoot, 'rules', 'runtime.md'), 'utf8');
    const named = extractRuntimeRule6SkillNames(runtimeMd);
    expect(named.length).toBeGreaterThan(0);
    expect([...listCatalogSkillNames()] as string[]).toEqual(expect.arrayContaining(named));
  });

  test('OmaWorkflowSkill is catalog-derived: doctor is E_NOT_FOUND and not loadable', () => {
    const typed: OmaWorkflowSkill[] = listCatalogSkillNames();
    expect(typed as readonly string[]).not.toContain('doctor');
    expect(loadSkillMarkdown(packageRoot, 'doctor' as OmaWorkflowSkill)).toBeNull();
    const shown = runSkillCommand({ kind: 'show', name: 'doctor' }, packageRoot);
    expect(shown.ok).toBe(false);
    if (shown.ok) return;
    expect(shown.error.code).toBe('E_NOT_FOUND');
  });

  test('intentionally deleting one plugin.json skill entry fails set equality', () => {
    const fixture = createStateFixture('oma-skill-catalog-plugin-');
    try {
      const catalog = listCatalogSkillNames();
      writeCatalogTree(fixture.root, catalog);
      expect(fourWayEqual(
        catalog,
        listWorkflowSkillNames(fixture.root),
        readPluginSkillNames(fixture.root),
      )).toBe(true);

      const reduced = catalog.filter((name) => name !== 'workflow');
      expect(reduced).not.toEqual(catalog);
      fs.writeFileSync(
        path.join(fixture.root, '.claude-plugin', 'plugin.json'),
        `${JSON.stringify({
          name: 'oh-my-agy',
          skills: reduced.map((name) => `./skills/${name}/`),
        }, null, 2)}\n`,
        'utf8',
      );
      const plugin = readPluginSkillNames(fixture.root);
      const disk = listWorkflowSkillNames(fixture.root);
      expect(plugin).not.toEqual(uniqueSorted(catalog));
      expect(disk).toEqual(uniqueSorted(catalog));
      expect(fourWayEqual(catalog, disk, plugin)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
