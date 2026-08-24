/**
 * 將 `skills/<name>/SKILL.md` 目錄面同步到 markdown catalog。
 * 設計概念映射：OMX `generate-catalog-docs`（目錄生成文件、CI 防漂移）、
 * OMG operation catalog golden tests（同一套 renderer 負責寫入與 `--check`）。
 *
 * 寫入目標鎖定 `AUTHORIZED_CATALOG_FILES`：只改 marked section，
 * 不得改寫根目錄 `AGENTS.md` 或其他 skill 正文。
 */
import * as fs from 'fs';
import * as path from 'path';
import { listWorkflowSkillNames } from '../src/modes/skill-loader';

export const CATALOG_START_MARKER = '<!-- OMA-SKILL-CATALOG:START -->';
export const CATALOG_END_MARKER = '<!-- OMA-SKILL-CATALOG:END -->';

export const AUTHORIZED_CATALOG_FILES = Object.freeze([
  'skills/AGENTS.md',
  'skills/oma-runtime/SKILL.md',
] as const);

export type AuthorizedCatalogFile = (typeof AUTHORIZED_CATALOG_FILES)[number];

interface CatalogCopy {
  readonly agents: string;
  readonly intent: string;
  readonly cli: string;
}

/**
 * Session 路由友善順序（對齊既有 slash catalog，缺項接在 oma-runtime 之前）。
 * 未列名的新 skill 會依字母序附加，避免從索引消失。
 */
export const PREFERRED_SKILL_ORDER: readonly string[] = [
  'autopilot',
  'deep-interview',
  'plan',
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
  'ask',
  'wiki',
  'hud',
  'setup',
  'workflow',
  'discovery-proof',
  'oma-runtime',
];

const CATALOG_COPY: Readonly<Record<string, CatalogCopy>> = Object.freeze({
  autopilot: {
    agents: 'Full OMX five-phase delivery loop',
    intent: 'Full autonomous delivery (OMX five-phase)',
    cli: '`oma autopilot …` (ledger only)',
  },
  'deep-interview': {
    agents: 'Clarify / specs',
    intent: 'Clarify requirements',
    cli: '(phase of autopilot)',
  },
  plan: {
    agents: 'Light planning under ralplan',
    intent: 'Bounded step list with verifiable completion',
    cli: '(none)',
  },
  ralplan: {
    agents: 'Plan + critic APPROVE gate',
    intent: 'Consensus-style plan gate',
    cli: '`oma autopilot consensus` (optional)',
  },
  ultragoal: {
    agents: 'Implement + verify ledger',
    intent: 'Durable implement + verify',
    cli: 'handoff/advance (optional); `oma team` explicit',
  },
  'code-review': {
    agents: 'Merge readiness review',
    intent: 'Merge-readiness review',
    cli: '`oma autopilot review` (optional)',
  },
  ultraqa: {
    agents: 'Adversarial QA',
    intent: 'Adversarial QA gate',
    cli: '`oma autopilot qa` (optional)',
  },
  ralph: {
    agents: 'Single-task persistence loop',
    intent: 'Persist until verified done',
    cli: '`oma ralph -- <task>` (optional)',
  },
  ultrawork: {
    agents: 'Parallel high-throughput',
    intent: 'Parallel independent work',
    cli: '`oma ultrawork -- <task>` (optional)',
  },
  search: {
    agents: 'Read-only / plan-style',
    intent: 'Read-only research',
    cli: '`oma search -- <query>` (optional)',
  },
  team: {
    agents: 'Multi-worker coordination',
    intent: 'Multi-worker tmux team',
    cli: '`oma team start|status|tick|…`',
  },
  cancel: {
    agents: 'Abort modes safely',
    intent: 'Stop active modes',
    cli: 'cancel managed session if bound',
  },
  verify: {
    agents: 'Fresh evidence gates',
    intent: 'Evidence before “done”',
    cli: 'tests/build/doctor evidence',
  },
  ask: {
    agents: 'External advisor second opinion (advisory-only)',
    intent: 'External advisor second opinion',
    cli: 'none — advisory only, never a worker',
  },

  wiki: {
    agents: 'Provenance-tracked knowledge lookup',
    intent: 'Provenance-tracked knowledge lookup',
    cli: '`oma wiki index|list|search <query>`',
  },
  hud: {
    agents: 'Run-state HUD with minimal/focused/full presets',
    intent: 'Where are we / what is stuck',
    cli: '`oma hud [--preset minimal|focused|full] [--watch]`',
  },
  setup: {
    agents: 'Install/doctor checks in-session',
    intent: 'Install/enable plugin',
    cli: '`oma setup` / `oma doctor`',
  },
  workflow: {
    agents: 'Repository DAG runner (permissions, replay, ship gate)',
    intent: 'Deterministic repository workflow runner',
    cli: '`oma workflow run <name> --input <json>`',
  },
  'discovery-proof': {
    agents: 'Production canary for namespaced skill discovery',
    intent: 'Internal discovery canary (do not use as a workflow)',
    cli: 'none — machine-verification token only',
  },
  'oma-runtime': {
    agents: 'Skill index / runtime notes',
    intent: 'This index',
    cli: '`oma skill list` / `oma skill show <name>`',
  },
});

export interface CatalogCheckResult {
  readonly ok: boolean;
  readonly drifted: string[];
  readonly missingByFile: Record<string, string[]>;
  readonly extraByFile: Record<string, string[]>;
  readonly message: string;
}

function posixRelative(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function isAuthorizedCatalogFile(relativePath: string): relativePath is AuthorizedCatalogFile {
  return (AUTHORIZED_CATALOG_FILES as readonly string[]).includes(relativePath);
}

/**
 * 唯一允許的寫入解析入口。相對路徑必須完全等於授權清單之一。
 */
export function resolveAuthorizedWritePath(packageRoot: string, relativePath: string): string {
  const posix = posixRelative(relativePath);
  if (posix !== relativePath.replace(/\\/g, '/')) {
    throw new Error(`Unsafe catalog path: ${relativePath}`);
  }
  if (posix.includes('\0') || posix.includes('..') || path.isAbsolute(posix) || posix.startsWith('/')) {
    throw new Error(`Unsafe catalog path: ${relativePath}`);
  }
  if (!isAuthorizedCatalogFile(posix)) {
    throw new Error(`Unauthorized catalog write target: ${relativePath}`);
  }
  const root = path.resolve(packageRoot);
  const resolved = path.resolve(root, posix);
  const rel = posixRelative(path.relative(root, resolved));
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel !== posix) {
    throw new Error(`Catalog write escaped package root: ${relativePath}`);
  }
  return resolved;
}

export function resolvePackageRootFromScriptDir(scriptDir = __dirname): string {
  const parent = path.basename(scriptDir);
  const grandName = path.basename(path.dirname(scriptDir));
  if (parent === 'scripts' && grandName === 'dist') {
    return path.resolve(scriptDir, '..', '..');
  }
  if (parent === 'scripts') {
    return path.resolve(scriptDir, '..');
  }
  return path.resolve(scriptDir);
}

function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function readSkillDescription(packageRoot: string, name: string): string {
  const skillPath = path.join(packageRoot, 'skills', name, 'SKILL.md');
  try {
    const text = fs.readFileSync(skillPath, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (match === null) return name;
    const desc = /^description:\s*(.*)$/m.exec(match[1]);
    if (desc === null) return name;
    return desc[1].trim().replace(/^["']|["']$/g, '').trim() || name;
  } catch {
    return name;
  }
}

function copyFor(name: string, packageRoot: string): CatalogCopy {
  const known = CATALOG_COPY[name];
  if (known !== undefined) return known;
  const description = readSkillDescription(packageRoot, name);
  const short = description.length > 80 ? `${description.slice(0, 77)}...` : description;
  return { agents: short, intent: short, cli: '(none)' };
}

export function listOrderedSkillNames(packageRoot: string): string[] {
  const names = listWorkflowSkillNames(packageRoot);
  const preferred = PREFERRED_SKILL_ORDER.filter((name) => names.includes(name));
  const rest = names.filter((name) => !PREFERRED_SKILL_ORDER.includes(name)).sort();
  return [...preferred, ...rest];
}

export function renderAgentsCatalog(names: readonly string[], packageRoot: string): string {
  const rows = names.map((name) =>
    `| \`${name}/SKILL.md\` | ${escapeCell(copyFor(name, packageRoot).agents)} |`);
  return ['| Path | Description |', '|------|-------------|', ...rows].join('\n');
}

export function renderSlashCatalog(names: readonly string[], packageRoot: string): string {
  const rows = names.map((name) => {
    const copy = copyFor(name, packageRoot);
    const body = name === 'oma-runtime' ? '(this file)' : `\`skills/${name}/SKILL.md\``;
    return `| ${escapeCell(copy.intent)} | \`/oh-my-agy:${name}\` | ${body} | ${escapeCell(copy.cli)} |`;
  });
  return [
    '| User intent | Canonical slash | Skill body | Optional CLI helper |',
    '|-------------|-----------------|------------|---------------------|',
    ...rows,
  ].join('\n');
}

function renderSectionFor(relativePath: AuthorizedCatalogFile, names: readonly string[], packageRoot: string): string {
  if (relativePath === 'skills/AGENTS.md') return renderAgentsCatalog(names, packageRoot);
  return renderSlashCatalog(names, packageRoot);
}

export function extractMarkedInner(source: string, label: string): string {
  const start = source.indexOf(CATALOG_START_MARKER);
  const end = source.indexOf(CATALOG_END_MARKER);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Missing OMA-SKILL-CATALOG markers in ${label}`);
  }
  const secondStart = source.indexOf(CATALOG_START_MARKER, start + CATALOG_START_MARKER.length);
  if (secondStart >= 0 && secondStart < end) {
    throw new Error(`Duplicate OMA-SKILL-CATALOG start marker in ${label}`);
  }
  return source.slice(start + CATALOG_START_MARKER.length, end).replace(/^\n/, '').replace(/\s+$/, '');
}

export function replaceMarkedSection(source: string, inner: string, label: string): string {
  extractMarkedInner(source, label);
  const start = source.indexOf(CATALOG_START_MARKER);
  const end = source.indexOf(CATALOG_END_MARKER);
  const before = source.slice(0, start);
  const after = source.slice(end + CATALOG_END_MARKER.length);
  const body = inner.endsWith('\n') ? inner : `${inner}\n`;
  return `${before}${CATALOG_START_MARKER}\n${body}${CATALOG_END_MARKER}${after}`;
}

export function extractCatalogSkillNames(inner: string, relativePath: AuthorizedCatalogFile): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const pattern = relativePath === 'skills/AGENTS.md'
    ? /`([A-Za-z0-9._-]+)\/SKILL\.md`/g
    : /`\/oh-my-agy:([A-Za-z0-9._-]+)`/g;
  for (const match of inner.matchAll(pattern)) {
    const name = match[1];
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function formatNameDelta(label: string, values: readonly string[]): string {
  if (values.length === 0) return '';
  return `${label}: ${values.join(', ')}`;
}

export function checkSkillCatalogs(packageRoot: string): CatalogCheckResult {
  const expectedNames = listOrderedSkillNames(packageRoot);
  const expectedSet = new Set(expectedNames);
  const drifted: string[] = [];
  const missingByFile: Record<string, string[]> = {};
  const extraByFile: Record<string, string[]> = {};
  const details: string[] = [];

  for (const relativePath of AUTHORIZED_CATALOG_FILES) {
    const abs = resolveAuthorizedWritePath(packageRoot, relativePath);
    if (!fs.existsSync(abs)) {
      drifted.push(relativePath);
      details.push(`${relativePath}: file missing`);
      continue;
    }
    const source = fs.readFileSync(abs, 'utf8');
    let inner: string;
    try {
      inner = extractMarkedInner(source, relativePath);
    } catch (error) {
      drifted.push(relativePath);
      details.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const listed = extractCatalogSkillNames(inner, relativePath);
    const listedSet = new Set(listed);
    const missing = expectedNames.filter((name) => !listedSet.has(name));
    const extra = listed.filter((name) => !expectedSet.has(name));
    missingByFile[relativePath] = missing;
    extraByFile[relativePath] = extra;
    const expectedInner = renderSectionFor(relativePath, expectedNames, packageRoot);
    const sectionDrifted = inner !== expectedInner;
    if (missing.length > 0 || extra.length > 0 || sectionDrifted) {
      drifted.push(relativePath);
      const bits = [
        formatNameDelta('missing', missing),
        formatNameDelta('extra', extra),
        sectionDrifted ? 'generated section text differs' : '',
      ].filter((bit) => bit !== '');
      details.push(`${relativePath}: ${bits.join('; ')}`);
    }
  }

  const ok = drifted.length === 0;
  const message = ok
    ? 'skill catalog check ok'
    : [
      'Skill catalog drift detected.',
      ...details,
      'Run: npm run catalog:generate',
      `On-disk skills: ${expectedNames.join(', ') || '(none)'}`,
    ].join('\n');

  return { ok, drifted: uniqueSorted(drifted), missingByFile, extraByFile, message };
}

export function applySkillCatalogs(packageRoot: string): string[] {
  const expectedNames = listOrderedSkillNames(packageRoot);
  const written: string[] = [];
  for (const relativePath of AUTHORIZED_CATALOG_FILES) {
    const abs = resolveAuthorizedWritePath(packageRoot, relativePath);
    const source = fs.readFileSync(abs, 'utf8');
    const next = replaceMarkedSection(
      source,
      renderSectionFor(relativePath, expectedNames, packageRoot),
      relativePath,
    );
    if (next !== source) {
      fs.writeFileSync(abs, next, 'utf8');
      written.push(relativePath);
    }
  }
  return written;
}

export function runCatalogCli(argv: readonly string[], packageRoot: string): number {
  const unknown = argv.filter((arg) => arg !== '--check' && arg !== '--help' && arg !== '-h');
  if (unknown.length > 0) {
    process.stderr.write(`Unknown argument: ${unknown[0]}\n`);
    return 1;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: generate-skill-catalog [--check]\n');
    return 0;
  }
  if (argv.includes('--check')) {
    const result = checkSkillCatalogs(packageRoot);
    if (!result.ok) {
      process.stderr.write(`${result.message}\n`);
      return 1;
    }
    process.stdout.write(`${result.message}\n`);
    return 0;
  }
  const written = applySkillCatalogs(packageRoot);
  if (written.length === 0) {
    process.stdout.write('skill catalog already current\n');
  } else {
    process.stdout.write(`updated ${written.join(', ')}\n`);
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = runCatalogCli(process.argv.slice(2), resolvePackageRootFromScriptDir());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
