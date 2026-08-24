/**
 * YAML 子集 frontmatter 與 skill search（#53）。
 * 設計概念映射：OMC keyword-detector 的 skill YAML 欄位；OMX `$skill` search 的
 * name/description 比對與穩定排序。
 */
import * as path from 'path';
import { listCatalogSkillNames } from '../../src/modes/skill-catalog';
import {
  compareSkillNamesV1,
  parseSkillFrontmatter,
  searchSkillDiscoveryRows,
  skillDiscoveryRowFromMarkdown,
  skillMatchesSearchQuery,
  type SkillDiscoveryRowV1,
} from '../../src/modes/skill-frontmatter';
import { loadSkillMarkdown } from '../../src/modes/skill-loader';

const packageRoot = path.resolve(__dirname, '../..');

function row(
  name: string,
  description: string | null,
  argumentHint: string | null = null,
): SkillDiscoveryRowV1 {
  return {
    name,
    path: `skills/${name}/SKILL.md`,
    description,
    argumentHint,
  };
}

describe('parseSkillFrontmatter', () => {
  test('parses key: value and quoted strings including colons', () => {
    const markdown = [
      '---',
      'name: verify',
      'description: "has: colon and slash /oh-my-agy:verify"',
      'argument-hint: "<x>"',
      '---',
      '',
      '# body',
      '',
    ].join('\n');
    expect(parseSkillFrontmatter(markdown)).toEqual({
      name: 'verify',
      description: 'has: colon and slash /oh-my-agy:verify',
      argumentHint: '<x>',
    });
  });

  test('accepts unquoted values, single quotes, escapes, CRLF, and BOM', () => {
    expect(parseSkillFrontmatter('---\nname: plain\ndescription: has: colon\n---\n')).toEqual({
      name: 'plain',
      description: 'has: colon',
      argumentHint: null,
    });
    expect(parseSkillFrontmatter("---\nname: x\ndescription: 'it''s fine'\n---\n")).toEqual({
      name: 'x',
      description: "it's fine",
      argumentHint: null,
    });
    expect(parseSkillFrontmatter('---\nname: x\ndescription: "say \\"hi\\""\n---\n')).toEqual({
      name: 'x',
      description: 'say "hi"',
      argumentHint: null,
    });
    expect(parseSkillFrontmatter('---\r\nname: x\r\ndescription: "y"\r\n---\r\n')).toEqual({
      name: 'x',
      description: 'y',
      argumentHint: null,
    });
    expect(parseSkillFrontmatter('\uFEFF---\nname: x\ndescription: "y"\n---\n')).toEqual({
      name: 'x',
      description: 'y',
      argumentHint: null,
    });
    expect(parseSkillFrontmatter('---\nname: x\nargumentHint: "<cli>"\n---\n')).toEqual({
      name: 'x',
      description: null,
      argumentHint: '<cli>',
    });
  });

  test('returns null for missing or corrupt frontmatter instead of throwing', () => {
    const garbage = [
      'no fence',
      '---\nname: x\n',
      '---\n::: not a key\n---\n',
      '---\nname: a\nname: b\n---\n',
      '---\ndescription: |\n  multi\n---\n',
      '---\ntags: [a, b]\n---\n',
      '---\nmeta: {k: v}\n---\n',
      '---\n# comment only\nname: x\n---\n',
      '---\nname: x\nargument-hint: "<a>"\nargumentHint: "<b>"\n---\n',
      '---\ndescription: "unterminated\n---\n',
      '\0---\n{',
    ];
    for (const markdown of garbage) {
      expect(() => parseSkillFrontmatter(markdown)).not.toThrow();
      expect(parseSkillFrontmatter(markdown)).toBeNull();
    }
  });

  test('treats empty quoted description as null and ignores unknown keys', () => {
    expect(parseSkillFrontmatter('---\nname: x\ndescription: ""\n---\n')).toEqual({
      name: 'x',
      description: null,
      argumentHint: null,
    });
    expect(parseSkillFrontmatter('---\nname: x\ndescription: "keep"\nlicense: MIT\n---\n')).toEqual({
      name: 'x',
      description: 'keep',
      argumentHint: null,
    });
  });

  test('maps a missing markdown body to a fail-open discovery row', () => {
    expect(skillDiscoveryRowFromMarkdown('broken', null)).toEqual({
      name: 'broken',
      path: 'skills/broken/SKILL.md',
      description: null,
      argumentHint: null,
    });
    expect(skillDiscoveryRowFromMarkdown('broken', 'not matter')).toEqual({
      name: 'broken',
      path: 'skills/broken/SKILL.md',
      description: null,
      argumentHint: null,
    });
  });
});

describe('shipped skill catalog frontmatter', () => {
  test('every catalog skill parses a non-empty description', () => {
    const names = listCatalogSkillNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const body = loadSkillMarkdown(packageRoot, name);
      expect(body).not.toBeNull();
      const parsed = parseSkillFrontmatter(body ?? '');
      expect(parsed).not.toBeNull();
      expect(parsed?.description).toEqual(expect.any(String));
      expect((parsed?.description ?? '').length).toBeGreaterThan(0);
      if (parsed?.name !== null && parsed?.name !== undefined) {
        expect(parsed.name).toBe(name);
      }
    }
  });
});

describe('skill search matching', () => {
  const rows: SkillDiscoveryRowV1[] = [
    row('zeta', 'alpha tools'),
    row('alpha', 'zeta tools'),
    row('mid', 'other'),
    row('hint-only', 'nope', 'unique-hint-xyz'),
  ];

  test('empty query and unknown strings miss; argumentHint is not searched', () => {
    expect(searchSkillDiscoveryRows(rows, '')).toEqual([]);
    expect(searchSkillDiscoveryRows(rows, '   ')).toEqual([]);
    expect(searchSkillDiscoveryRows(rows, 'no-such-skill-zzzxxyy-issue-53')).toEqual([]);
    expect(searchSkillDiscoveryRows(rows, 'unique-hint-xyz')).toEqual([]);
    expect(skillMatchesSearchQuery(row('verify', null), 'verify')).toBe(true);
    expect(skillMatchesSearchQuery(row('other', null), 'verify')).toBe(false);
  });

  test('matches name or description case-insensitively and sorts by UTF-8 name', () => {
    const hits = searchSkillDiscoveryRows(rows, 'Tools');
    expect(hits.map((entry) => entry.name)).toEqual(['alpha', 'zeta']);
    const again = searchSkillDiscoveryRows(rows, 'Tools');
    expect(JSON.stringify(hits)).toBe(JSON.stringify(again));
  });

  test('search verify hits verify; empty/unknown queries miss on the shipped catalog', () => {
    const catalogRows = listCatalogSkillNames().map((name) =>
      skillDiscoveryRowFromMarkdown(name, loadSkillMarkdown(packageRoot, name)),
    );
    const hits = searchSkillDiscoveryRows(catalogRows, 'verify');
    expect(hits.some((entry) => entry.name === 'verify')).toBe(true);
    expect(searchSkillDiscoveryRows(catalogRows, '')).toEqual([]);
    expect(searchSkillDiscoveryRows(catalogRows, '   ')).toEqual([]);
    expect(searchSkillDiscoveryRows(catalogRows, 'no-such-skill-zzzxxyy-issue-53')).toEqual([]);

    const sessionHits = searchSkillDiscoveryRows(catalogRows, 'session');
    const sessionAgain = searchSkillDiscoveryRows(catalogRows, 'session');
    expect(JSON.stringify(sessionHits)).toBe(JSON.stringify(sessionAgain));
    const names = sessionHits.map((entry) => entry.name);
    const sorted = [...names].sort(compareSkillNamesV1);
    expect(names).toEqual(sorted);
  });
});
