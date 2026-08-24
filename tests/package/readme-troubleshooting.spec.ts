import * as fs from 'fs';
import * as path from 'path';
import { CLI_HELP } from '../../src/cli/application';

/**
 * README Troubleshooting／環境變數表與原始碼／CLI_HELP 的 fail-closed 契約。
 * 設計概念映射：issue #64 — 文件不得宣稱尚未出貨的能力（例如把 `oma hooks status`
 * 寫進診斷欄）；表中每個環境變數必須能在 `src/` 或 `bin/` grep 到使用點。
 */

const ROOT = path.resolve(__dirname, '../..');

const REQUIRED_ENV_VARS = [
  'DISABLE_OMA',
  'OMA_SKIP_HOOKS',
  'OMA_HOOK_DEBUG',
  'OMA_LEGACY_STDIO',
  'OMA_TIMEOUT_MS',
  'OMA_LAUNCH_POLICY',
  'OMA_STATE_ROOT',
] as const;

const README_SPECS = [
  {
    relative: 'README.md',
    troubleshootingHeading: /^## Troubleshooting\s*$/m,
    envHeading: /^### Environment variables\s*$/m,
  },
  {
    relative: 'docs/readme/README.zh.md',
    troubleshootingHeading: /^## 故障排除\s*$/m,
    envHeading: /^### 环境变量\s*$/m,
  },
  {
    relative: 'docs/readme/README.zh-TW.md',
    troubleshootingHeading: /^## 疑難排解\s*$/m,
    envHeading: /^### 環境變數\s*$/m,
  },
] as const;

interface ParsedReadme {
  relative: string;
  body: string;
  troubleshooting: string;
  envSection: string;
  envVars: string[];
  diagnosticCommands: string[];
}

function readRepoFile(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function sliceFromHeading(markdown: string, heading: RegExp): string {
  const match = heading.exec(markdown);
  if (match === null || match.index === undefined) {
    throw new Error(`missing heading ${heading}`);
  }
  const start = match.index;
  const headingLine = match[0];
  const hashes = headingLine.match(/^#+/);
  const level = hashes === null ? 2 : hashes[0].length;
  const rest = markdown.slice(start + headingLine.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}}[^#\\n]`));
  return markdown.slice(start, next === -1 ? markdown.length : start + headingLine.length + next);
}

function tableRows(section: string): string[][] {
  const rows: string[][] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (/^\|\s*:?-{3,}/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length === 0) continue;
    rows.push(cells);
  }
  return rows;
}

function envVarsFromSection(section: string): string[] {
  const rows = tableRows(section);
  if (rows.length < 2) return [];
  const names: string[] = [];
  for (const row of rows.slice(1)) {
    const match = /`([A-Z][A-Z0-9_]*)`/.exec(row[0] ?? '');
    if (match) names.push(match[1]);
  }
  return names;
}

function diagnosticCommandsFromSection(section: string): string[] {
  const rows = tableRows(section);
  const commands = new Set<string>();
  for (const row of rows.slice(1)) {
    const diagnose = row[1] ?? '';
    const matches = diagnose.matchAll(/`oma ([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]+))?/g);
    for (const match of matches) {
      const verb = match[1];
      const sub = match[2];
      commands.add(sub === undefined ? `oma ${verb}` : `oma ${verb} ${sub}`);
    }
  }
  return [...commands].sort();
}

function parseReadme(spec: (typeof README_SPECS)[number]): ParsedReadme {
  const body = readRepoFile(spec.relative);
  const troubleshooting = sliceFromHeading(body, spec.troubleshootingHeading);
  const envSection = sliceFromHeading(troubleshooting, spec.envHeading);
  const envHeadingMatch = spec.envHeading.exec(troubleshooting);
  const symptoms = troubleshooting.slice(0, envHeadingMatch?.index ?? troubleshooting.length);
  return {
    relative: spec.relative,
    body,
    troubleshooting,
    envSection,
    envVars: envVarsFromSection(envSection),
    diagnosticCommands: diagnosticCommandsFromSection(symptoms),
  };
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
      continue;
    }
    if (entry.isFile() && /\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function sourceMentionsEnvVar(name: string): boolean {
  const needle = new RegExp(`\\b${name}\\b`);
  for (const file of [...walkTsFiles(path.join(ROOT, 'src')), ...walkTsFiles(path.join(ROOT, 'bin'))]) {
    if (needle.test(fs.readFileSync(file, 'utf8'))) return true;
  }
  return false;
}

describe('README troubleshooting / env table stay bound to shipped code', () => {
  const parsed = README_SPECS.map(parseReadme);

  test('three READMEs have matching Troubleshooting + env-var tables', () => {
    for (const readme of parsed) {
      expect(readme.envVars).toEqual([...REQUIRED_ENV_VARS]);
      expect(readme.envVars).not.toContain('OMA_STATE_DIR');
      expect(readme.diagnosticCommands).toEqual(['oma doctor', 'oma skill list']);
    }
    const [english, ...rest] = parsed;
    for (const other of rest) {
      expect(other.envVars).toEqual(english.envVars);
      expect(other.diagnosticCommands).toEqual(english.diagnosticCommands);
    }
  });

  test('every env var in the table is used in src/ or bin/', () => {
    const missing: string[] = [];
    for (const name of parsed[0].envVars) {
      if (!sourceMentionsEnvVar(name)) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  test('every diagnostic command exists in CLI_HELP and hooks status is not claimed', () => {
    for (const readme of parsed) {
      const table = tableRows(readme.troubleshooting)
        .slice(1)
        .map((row) => row.join(' | '))
        .join('\n');
      expect(table).not.toMatch(/oma hooks status/);
      for (const command of readme.diagnosticCommands) {
        expect(CLI_HELP).toContain(command);
      }
    }
  });

  test('setup skill cross-links Troubleshooting and does not prescribe hooks status', () => {
    const skill = readRepoFile('skills/setup/SKILL.md');
    expect(skill).toMatch(/README\.md#troubleshooting/);
    expect(skill).toMatch(/docs\/readme\/README\.zh\.md/);
    expect(skill).toMatch(/docs\/readme\/README\.zh-TW\.md/);
    expect(skill).toMatch(/## Troubleshooting/);
    expect(skill).toMatch(/verb is not shipped/);
  });
});
