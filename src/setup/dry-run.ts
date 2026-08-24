/**
 * 設計概念映射：OMX `setup --dry-run` 只列計畫不落地；
 * OMG install / `omg workflow plan` 的 plan-before-run；
 * OMA 輸出 redacted canonical JSON，零 filesystem / host-registry 變更。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertRedacted, redactValue } from '../runtime/redaction';
import { resolveStateRoot } from '../runtime/state-root';
import {
  computePackageIdentity,
  defaultAntigravityConfigRoot,
  PackageIdentitySummaryV1,
  readInstalledIdentityIfPresent,
  summarizePackageIdentity,
} from './installed-identity';
import {
  parseSetupHosts,
  plannedClaudeSlashSpawns,
  plannedGrokSlashSpawns,
  SetupHost,
} from './host-install';
import { readPackagePluginName } from './plugin';
import { plannedAgyPluginSpawns } from './transaction';

export const SETUP_DRY_RUN_SCHEMA = 'oma.setup-dry-run/v1' as const;

export type SetupIdentitySummaryV1 = PackageIdentitySummaryV1;

export interface PlannedSpawnV1 {
  host: 'agy' | 'claude' | 'grok';
  args: readonly string[];
}

export interface SetupDryRunPlanV1 {
  schema: typeof SETUP_DRY_RUN_SCHEMA;
  schemaVersion: 1;
  dryRun: true;
  mutates: false;
  hosts: SetupHost[];
  scope: 'global' | 'workspace';
  packageRoot: string;
  targetPaths: Record<string, string>;
  candidateIdentity: SetupIdentitySummaryV1 | null;
  installedIdentity: SetupIdentitySummaryV1 | null;
  plannedSpawns: PlannedSpawnV1[];
  warnings: string[];
}

export interface BuildSetupDryRunPlanInput {
  argv: readonly string[];
  packageRoot: string;
  agyCommand: string;
  stateRoot?: string;
  homeDir?: string;
  antigravityConfigRoot?: string;
  environment?: NodeJS.ProcessEnv;
}

/**
 * 組出 setup --dry-run 計畫。禁止 mkdir / adapter.run / symlink；只讀取 identity。
 */
export function buildSetupDryRunPlan(
  input: Readonly<BuildSetupDryRunPlanInput>,
): SetupDryRunPlanV1 {
  const packageRoot = path.resolve(input.packageRoot);
  const hosts = parseSetupHosts(input.argv);
  const scope: 'global' | 'workspace' = input.argv.includes('--workspace')
    ? 'workspace'
    : 'global';
  const homeDir = input.homeDir ?? os.homedir();
  const warnings: string[] = [];
  const runAgy = hosts.includes('all') || hosts.includes('agy');
  const runClaude = hosts.includes('all') || hosts.includes('claude');
  const runGrok = hosts.includes('all') || hosts.includes('grok');

  const candidate = computePackageIdentity(packageRoot);
  const candidateIdentity = candidate.ok ? summarizePackageIdentity(candidate.value) : null;
  if (!candidate.ok) {
    warnings.push(
      `candidate identity unavailable (${candidate.error.code}: ${candidate.error.message})`,
    );
  }

  const pluginNameResult = readPackagePluginName(packageRoot);
  const pluginName = pluginNameResult.ok
    ? pluginNameResult.value
    : candidateIdentity?.pluginName ?? 'oh-my-agy';
  if (!pluginNameResult.ok) {
    warnings.push(
      `plugin.json name unavailable (${pluginNameResult.error.code}: ${pluginNameResult.error.message})`,
    );
  }

  const configRoot = path.resolve(
    input.antigravityConfigRoot ?? defaultAntigravityConfigRoot(homeDir),
  );
  const installed = readInstalledIdentityIfPresent({
    pluginName,
    antigravityConfigRoot: configRoot,
    homeDir,
  });
  if (installed.warning !== null) warnings.push(installed.warning);

  const stateRoot = resolvePlannedStateRoot(input, homeDir, warnings);
  const plannedStagePath = candidateIdentity === null || stateRoot === null
    ? null
    : path.join(stateRoot, 'install', 'stages', candidateIdentity.digest);

  const targetPaths: Record<string, string> = { packageRoot };
  if (stateRoot !== null) targetPaths.stateRoot = stateRoot;
  if (runAgy) {
    targetPaths.pluginInstallPath = path.join(configRoot, 'plugins', pluginName);
    if (plannedStagePath !== null) targetPaths.stagePath = plannedStagePath;
  }
  if (runClaude) {
    targetPaths.claudePackageSkills = path.join(packageRoot, '.claude', 'skills');
    targetPaths.claudeUserSkills = path.join(
      homeDir, '.claude', 'plugins', 'oh-my-agy-local', 'skills',
    );
  }
  if (runGrok) {
    targetPaths.grokPackageSkills = path.join(packageRoot, '.grok', 'skills');
  }

  const plannedSpawns: PlannedSpawnV1[] = [];
  if (runAgy && plannedStagePath !== null) {
    const removePrevious = installed.identity !== null
      || fs.existsSync(path.join(configRoot, 'plugins', pluginName));
    for (const args of plannedAgyPluginSpawns(
      input.agyCommand,
      pluginName,
      plannedStagePath,
      removePrevious,
    )) {
      plannedSpawns.push({ host: 'agy', args });
    }
  } else if (runAgy) {
    plannedSpawns.push({ host: 'agy', args: [input.agyCommand, 'plugin', 'list'] });
    warnings.push('agy stage path omitted because candidate identity is unavailable');
  }
  if (runClaude) {
    for (const args of plannedClaudeSlashSpawns(packageRoot)) {
      plannedSpawns.push({ host: 'claude', args });
    }
  }
  if (runGrok) {
    for (const args of plannedGrokSlashSpawns(packageRoot)) {
      plannedSpawns.push({ host: 'grok', args });
    }
  }

  return {
    schema: SETUP_DRY_RUN_SCHEMA,
    schemaVersion: 1,
    dryRun: true,
    mutates: false,
    hosts,
    scope,
    packageRoot,
    targetPaths,
    candidateIdentity,
    installedIdentity: installed.identity,
    plannedSpawns,
    warnings,
  };
}

export function renderSetupDryRunPlan(plan: Readonly<SetupDryRunPlanV1>): string {
  const redacted = redactValue(plan);
  assertRedacted(redacted);
  return `${JSON.stringify(redacted, null, 2)}\n`;
}

function resolvePlannedStateRoot(
  input: Readonly<BuildSetupDryRunPlanInput>,
  homeDir: string,
  warnings: string[],
): string | null {
  if (input.stateRoot !== undefined) return path.resolve(input.stateRoot);
  const resolved = resolveStateRoot({
    create: false,
    homeDirectory: homeDir,
    env: input.environment,
  });
  if (resolved.ok) return resolved.value.path;
  warnings.push(`state root unresolved (${resolved.error.code}: ${resolved.error.message})`);
  const details = resolved.error.details;
  if (details !== undefined && typeof details.root === 'string') return details.root;
  return null;
}
