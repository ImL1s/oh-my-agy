/**
 * `oma doctor conflicts`：唯讀共存衝突檢查。
 * 設計概念映射：OMC `doctor-conflicts.ts`（plugin 共存 + 競爭 hook 註冊）；
 * OMG `omg doctor --strict`（warn 預設不 fail，加旗標才升級為 exit 1）。
 * OMA 自身 `hooks.json` 與 `.agents/hooks.json` 雙份註冊僅 warn，
 * 因為 host 是否同時載入尚未 live 驗證（#65）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listWorkflowSkillNames } from '../modes/skill-loader';
import {
  DoctorCheckV1,
  DoctorReportV1,
  checkOmcAutopilotCollision,
  doctorCheck,
} from './doctor';
import { readPackagePluginName } from './plugin';

export const DOCTOR_CONFLICT_CHECK_IDS = [
  'duplicate_hook_registration',
  'mcp_server_name_collision',
  'duplicate_skill_name',
  'competing_plugin_autopilot',
] as const;

const NEXT_NONE = 'No action required.';
const SKIP_DIR_NAMES = new Set([
  'node_modules', 'dist', '.git', '.agy', '.omc', '.omg', '.grok', '.github',
  'coverage', 'tests', 'e2e', 'src', 'bin', 'docs', 'scripts', 'assets', 'rules',
  '.claude-plugin', '.agents', 'skills',
]);
const HOOK_MANIFEST_RELATIVE = [
  'hooks.json',
  '.agents/hooks.json',
  'hooks/hooks.json',
] as const;
const MCP_MANIFEST_RELATIVE = [
  '.mcp.json',
  '.claude-plugin/.mcp.json',
] as const;
const CONTAINER_DIR_NAMES = new Set(['cache', 'plugins']);

export interface RunDoctorConflictsInput {
  readonly packageRoot: string;
  readonly packageVersion?: string;
  readonly pluginDir?: string;
  readonly homeDir?: string;
  readonly cwd?: string;
  readonly strict?: boolean;
  readonly antigravityConfigRoot?: string;
}

interface ScannedPluginRoot {
  readonly root: string;
  readonly label: string;
}

interface HookRegistration {
  readonly plugin: string;
  readonly root: string;
  readonly source: string;
  readonly event: string;
}

interface NamedOwner {
  readonly plugin: string;
  readonly name: string;
}

/**
 * 掃描 plugin 樹並產出四列 DoctorCheckV1。預設 warn 不 fail（exit 0）；
 * `strict` 時任何 warn 升級為 exit 1。全程只讀檔系統。
 */
export function runDoctorConflicts(
  input: Readonly<RunDoctorConflictsInput>,
): DoctorReportV1 {
  const packageRoot = path.resolve(input.packageRoot);
  const packageVersion = input.packageVersion ?? readPackageVersion(packageRoot);
  const homeDir = path.resolve(input.homeDir ?? os.homedir());
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const strict = input.strict === true;
  const scan = inspectPluginScan({
    pluginDir: input.pluginDir,
    cwd,
    packageRoot,
    homeDir,
    antigravityConfigRoot: input.antigravityConfigRoot,
  });
  const plugins = scan.roots.map((root) => ({
    root,
    label: pluginLabel(root),
  }));

  const checks: DoctorCheckV1[] = [
    checkDuplicateHookRegistration(plugins, scan.missingMessage),
    checkMcpServerNameCollision(plugins, scan.missingMessage),
    checkDuplicateSkillName(plugins, scan.missingMessage),
    remapCheckId(checkOmcAutopilotCollision(homeDir), 'competing_plugin_autopilot'),
  ];

  const hasFail = checks.some((item) => item.status === 'fail');
  const hasWarn = checks.some((item) => item.status === 'warn');
  const exitCode: 0 | 1 | 2 = hasFail || (strict && hasWarn) ? 1 : 0;

  return {
    schemaVersion: 1,
    ok: !hasFail,
    exitCode,
    packageRoot,
    packageVersion,
    mode: strict ? 'strict' : 'development',
    checks,
  };
}

function inspectPluginScan(input: {
  readonly pluginDir: string | undefined;
  readonly cwd: string;
  readonly packageRoot: string;
  readonly homeDir: string;
  readonly antigravityConfigRoot: string | undefined;
}): { roots: string[]; missingMessage: string | undefined } {
  if (input.pluginDir !== undefined) {
    const resolved = path.resolve(input.cwd, input.pluginDir);
    try {
      if (!fs.existsSync(resolved)) {
        return { roots: [], missingMessage: `--plugin-dir not found: ${resolved}` };
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return { roots: [], missingMessage: `--plugin-dir is not a directory: ${resolved}` };
      }
      return { roots: collectPluginRoots(resolved), missingMessage: undefined };
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return { roots: [], missingMessage: `--plugin-dir unreadable: ${resolved} (${cause})` };
    }
  }
  const roots: string[] = [];
  roots.push(...collectPluginRoots(input.packageRoot));
  const installed = path.join(input.homeDir, '.claude', 'plugins');
  if (directoryExists(installed)) roots.push(...collectPluginRoots(installed));
  if (input.antigravityConfigRoot !== undefined) {
    const agyPlugins = path.join(path.resolve(input.antigravityConfigRoot), 'plugins');
    if (directoryExists(agyPlugins)) roots.push(...collectPluginRoots(agyPlugins));
  }
  return { roots: uniquePaths(roots), missingMessage: undefined };
}

function collectPluginRoots(scanRoot: string, depth = 0): string[] {
  if (depth > 4) return [];
  const found: string[] = [];
  const selfPlugin = isPluginRoot(scanRoot);
  if (selfPlugin) found.push(path.resolve(scanRoot));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scanRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(scanRoot, entry.name);
    if (!isDirectoryEntry(full, entry)) continue;
    if (selfPlugin && !CONTAINER_DIR_NAMES.has(entry.name)) continue;
    found.push(...collectPluginRoots(full, depth + 1));
  }
  return uniquePaths(found);
}

function isPluginRoot(dir: string): boolean {
  return fileExists(path.join(dir, 'plugin.json'))
    || fileExists(path.join(dir, 'hooks.json'))
    || fileExists(path.join(dir, '.mcp.json'))
    || fileExists(path.join(dir, '.claude-plugin', '.mcp.json'))
    || directoryExists(path.join(dir, 'skills'));
}

function checkDuplicateHookRegistration(
  plugins: readonly ScannedPluginRoot[],
  missingMessage: string | undefined,
): DoctorCheckV1 {
  const id = 'duplicate_hook_registration';
  const nextMissing = 'Pass --plugin-dir to an existing plugin or plugins directory, then re-run oma doctor conflicts.';
  if (missingMessage !== undefined) {
    return doctorCheck(id, 'warn', missingMessage, nextMissing);
  }
  const registrations: HookRegistration[] = [];
  for (const plugin of plugins) {
    for (const relative of HOOK_MANIFEST_RELATIVE) {
      const filePath = path.join(plugin.root, ...relative.split('/'));
      if (!fileExists(filePath)) continue;
      for (const event of eventsFromHookManifest(filePath)) {
        registrations.push({
          plugin: plugin.label,
          root: plugin.root,
          source: relative,
          event,
        });
      }
    }
  }
  const grouped = groupBy(registrations, (item) => item.event);
  const duplicateEvents: string[] = [];
  const sources = new Set<string>();
  for (const [event, rows] of grouped) {
    const uniqueManifests = uniqueKey(rows, (row) => `${row.root}::${row.source}`);
    if (uniqueManifests.length < 2) continue;
    duplicateEvents.push(event);
    for (const row of uniqueManifests) {
      sources.add(`${row.source} (${row.plugin})`);
    }
  }
  duplicateEvents.sort();
  if (duplicateEvents.length === 0) {
    return doctorCheck(
      id,
      'pass',
      'No duplicate hook registration across scanned plugin manifests',
      NEXT_NONE,
      { plugins: plugins.map((item) => item.label) },
    );
  }
  const sourceList = [...sources].sort();
  return doctorCheck(
    id,
    'warn',
    `Duplicate hook registration for ${duplicateEvents.join(', ')} across ${sourceList.join(' vs ')} — if both take effect they would fire twice (not a confirmed host defect)`,
    'Keep a single hook manifest active unless live evidence shows the host loads both; re-run oma doctor conflicts after changing hook registration.',
    { events: duplicateEvents, sources: sourceList },
  );
}

function checkMcpServerNameCollision(
  plugins: readonly ScannedPluginRoot[],
  missingMessage: string | undefined,
): DoctorCheckV1 {
  const id = 'mcp_server_name_collision';
  const nextMissing = 'Pass --plugin-dir to an existing plugin or plugins directory, then re-run oma doctor conflicts.';
  if (missingMessage !== undefined) {
    return doctorCheck(id, 'warn', missingMessage, nextMissing);
  }
  const owners: NamedOwner[] = [];
  for (const plugin of plugins) {
    const names = new Set<string>();
    for (const relative of MCP_MANIFEST_RELATIVE) {
      const filePath = path.join(plugin.root, ...relative.split('/'));
      for (const name of mcpServerNames(filePath)) names.add(name);
    }
    for (const name of names) owners.push({ plugin: plugin.label, name });
  }
  const collisions = nameCollisions(owners);
  if (collisions.length === 0) {
    return doctorCheck(
      id,
      'pass',
      'No MCP server name collisions across scanned plugins',
      NEXT_NONE,
    );
  }
  const summary = collisions
    .map((item) => `${item.name} (${item.plugins.join(', ')})`)
    .join('; ');
  return doctorCheck(
    id,
    'warn',
    `MCP server name collision: ${summary}`,
    'Rename or disable one of the colliding MCP servers, then re-run oma doctor conflicts.',
    { collisions },
  );
}

function checkDuplicateSkillName(
  plugins: readonly ScannedPluginRoot[],
  missingMessage: string | undefined,
): DoctorCheckV1 {
  const id = 'duplicate_skill_name';
  const nextMissing = 'Pass --plugin-dir to an existing plugin or plugins directory, then re-run oma doctor conflicts.';
  if (missingMessage !== undefined) {
    return doctorCheck(id, 'warn', missingMessage, nextMissing);
  }
  const owners: NamedOwner[] = [];
  for (const plugin of plugins) {
    let names: string[] = [];
    try {
      names = listWorkflowSkillNames(plugin.root);
    } catch {
      names = [];
    }
    for (const name of names) owners.push({ plugin: plugin.label, name });
  }
  const collisions = nameCollisions(owners);
  if (collisions.length === 0) {
    return doctorCheck(
      id,
      'pass',
      'No duplicate slash skill names across scanned plugins',
      NEXT_NONE,
    );
  }
  const summary = collisions
    .map((item) => `${item.name} (${item.plugins.join(', ')})`)
    .join('; ');
  return doctorCheck(
    id,
    'warn',
    `Duplicate slash skill name: ${summary}`,
    'Rename or remove the colliding slash skill in one plugin, then re-run oma doctor conflicts.',
    { collisions },
  );
}

function remapCheckId(check: DoctorCheckV1, id: string): DoctorCheckV1 {
  return doctorCheck(id, check.status, check.message, check.nextAction, check.detail);
}

function eventsFromHookManifest(filePath: string): string[] {
  const parsed = readJsonObject(filePath);
  if (!parsed.ok) return [];
  const events = new Set<string>();
  const root = parsed.value;
  const nested = root.hooks;
  if (isPlainObject(nested)) {
    for (const event of eventsFromEventMap(nested)) events.add(event);
  }
  for (const value of Object.values(root)) {
    if (!isPlainObject(value)) continue;
    for (const event of eventsFromEventMap(value)) events.add(event);
  }
  return [...events].sort();
}

function eventsFromEventMap(map: Record<string, unknown>): string[] {
  const events: string[] = [];
  for (const [event, hooks] of Object.entries(map)) {
    if (event === 'hooks') continue;
    if (eventHasCommand(hooks)) events.push(event);
  }
  return events;
}

function eventHasCommand(hooks: unknown): boolean {
  if (!Array.isArray(hooks)) return false;
  for (const item of hooks) {
    if (!isPlainObject(item)) continue;
    if (typeof item.command === 'string' && item.command.trim() !== '') return true;
    if (eventHasCommand(item.hooks)) return true;
  }
  return false;
}

function mcpServerNames(filePath: string): string[] {
  if (!fileExists(filePath)) return [];
  const parsed = readJsonObject(filePath);
  if (!parsed.ok) return [];
  const servers = parsed.value.mcpServers;
  if (!isPlainObject(servers)) return [];
  return Object.keys(servers).filter((name) => name.trim() !== '').sort();
}

function nameCollisions(
  owners: readonly NamedOwner[],
): Array<{ name: string; plugins: string[] }> {
  const grouped = groupBy(owners, (item) => item.name);
  const collisions: Array<{ name: string; plugins: string[] }> = [];
  for (const [name, rows] of grouped) {
    const plugins = [...new Set(rows.map((item) => item.plugin))].sort();
    if (plugins.length < 2) continue;
    collisions.push({ name, plugins });
  }
  collisions.sort((left, right) => left.name.localeCompare(right.name));
  return collisions;
}

function pluginLabel(pluginRoot: string): string {
  const named = readPackagePluginName(pluginRoot);
  if (named.ok) return named.value;
  return path.basename(pluginRoot);
}

function readPackageVersion(packageRoot: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof raw.version === 'string' ? raw.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readJsonObject(
  filePath: string,
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isPlainObject(raw)) return { ok: false };
    return { ok: true, value: raw };
  } catch {
    return { ok: false };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fileExists(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function directoryExists(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isDirectoryEntry(full: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  return directoryExists(full);
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const resolved = path.resolve(item);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result.sort();
}

function uniqueKey<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [row]);
    else list.push(row);
  }
  return grouped;
}
