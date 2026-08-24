import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveStateRoot } from '../runtime/state-root';
import { RuntimeError } from '../runtime/errors';
import { Result, ok } from '../runtime/types';
import {
  HostCapabilityProfileV1,
  validateHostCapabilityProfile,
} from '../native/capability-profile';
import { isHostCapabilityProfileFresh } from '../native/probes/cache';
import {
  PluginCommandAdapter,
  readPackagePluginName,
  resolveHookEntrypoints,
  verifyPluginActive,
} from './plugin';
import { normalizeClaudePluginSkillEntry } from '../modes/skill-catalog';
import { listWorkflowSkillNames } from '../modes/skill-loader';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheckV1 {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  detail?: unknown;
}

export interface DoctorReportV1 {
  schemaVersion: 1;
  ok: boolean;
  exitCode: 0 | 1 | 2;
  packageRoot: string;
  packageVersion: string;
  mode: 'development' | 'strict' | 'release';
  checks: DoctorCheckV1[];
  nativeCapabilities?: DoctorNativeCapabilitiesV1;
}

export interface RedactedNativeDiagnosticV1 {
  code: string;
  message: string;
}

export interface DoctorNativeCapabilitiesV1 {
  schema: 'oma.doctor-native/v1';
  profileDigest: string | null;
  outcome: 'supported' | 'unsupported' | 'unknown' | 'mixed';
  counts: { supported: number; unsupported: number; unknown: number };
  cacheStatus: 'hit' | 'miss' | 'rebuilt' | 'non_cacheable';
  identityStatus: 'matched' | 'absent' | 'drifted';
  diagnostics: RedactedNativeDiagnosticV1[];
}

export type NativeDoctorProbeResultV1 =
  | {
    readonly kind: 'profile';
    readonly profile: HostCapabilityProfileV1;
    readonly cacheStatus: DoctorNativeCapabilitiesV1['cacheStatus'];
    readonly diagnostics?: readonly RedactedNativeDiagnosticV1[];
  }
  | {
    readonly kind: 'host_absent';
    readonly diagnostics: readonly RedactedNativeDiagnosticV1[];
  };

export interface RunDoctorInput {
  packageRoot: string;
  packageVersion?: string;
  agyCommand?: string;
  adapter?: PluginCommandAdapter;
  /** true：plugin 未 active 視為 fail（預設）；false：warn */
  strictPlugin?: boolean;
  mode?: 'development' | 'strict' | 'release';
  antigravityConfigRoot?: string;
  homeDir?: string;
  stateRoot?: string;
  includeNativeCapabilities?: boolean;
  nativeCapabilitiesProbe?: () => Promise<Result<NativeDoctorProbeResultV1, RuntimeError>>;
  nowMs?: () => number;
}

/**
 * 設計概念映射：對齊 OMX/OMG doctor — 形狀檢查，不打真 model。
 * exit 0=全 pass；1=有 fail；2=僅 warn（strict 下不會用）。
 */
export async function runDoctor(
  input: Readonly<RunDoctorInput>,
): Promise<Result<DoctorReportV1, RuntimeError>> {
  const packageRoot = path.resolve(input.packageRoot);
  const packageVersion = input.packageVersion ?? readPackageJsonVersion(packageRoot);
  const agyCommand = input.agyCommand ?? 'agy';
  const mode = input.mode ?? (input.strictPlugin === false ? 'development' : 'strict');
  const homeDir = path.resolve(input.homeDir ?? os.homedir());
  const configRoot = input.antigravityConfigRoot === undefined
    ? input.homeDir === undefined ? undefined : path.join(homeDir, '.gemini', 'config')
    : path.resolve(input.antigravityConfigRoot);
  const checks: DoctorCheckV1[] = [];

  checks.push(checkNodeVersion());
  checks.push(checkPackageRoot(packageRoot, packageVersion));
  checks.push(checkPluginManifestVersion(packageRoot, packageVersion));
  checks.push(checkClaudePluginManifest(packageRoot));
  checks.push(checkSlashSkillSurface(packageRoot));
  checks.push(checkSkillManifestDrift(packageRoot));
  checks.push(checkHooks(packageRoot));
  checks.push(checkAgyOnPath(agyCommand, homeDir, configRoot));
  checks.push(checkStateRoot(input.stateRoot, homeDir, input.homeDir !== undefined));
  checks.push(checkOmcAutopilotCollision(homeDir));

  const adapter = input.adapter ?? defaultAgyListAdapter(agyCommand, {
    ...process.env,
    HOME: homeDir,
    ...(configRoot === undefined ? {} : {
      ANTIGRAVITY_CONFIG_ROOT: configRoot,
      OMA_ANTIGRAVITY_CONFIG_ROOT: configRoot,
    }),
  });
  const pluginCheck = await checkPluginRegistry(packageRoot, adapter, mode, {
    antigravityConfigRoot: configRoot,
    homeDir,
  });
  checks.push(pluginCheck);

  let nativeCapabilities: DoctorNativeCapabilitiesV1 | undefined;
  if (input.includeNativeCapabilities === true) {
    const native = await checkNativeCapabilities(
      input.nativeCapabilitiesProbe,
      input.nowMs ?? Date.now,
    );
    checks.push(native.check);
    nativeCapabilities = native.projection;
  }

  const hasFail = checks.some((c) => c.status === 'fail');
  const hasWarn = checks.some((c) => c.status === 'warn');
  const exitCode: 0 | 1 | 2 = hasFail ? 1 : hasWarn ? 2 : 0;

  return ok({
    schemaVersion: 1,
    ok: !hasFail,
    exitCode,
    packageRoot,
    packageVersion,
    mode,
    checks,
    ...(nativeCapabilities === undefined ? {} : { nativeCapabilities }),
  });
}

async function checkNativeCapabilities(
  probe: RunDoctorInput['nativeCapabilitiesProbe'],
  nowMs: () => number,
): Promise<{ check: DoctorCheckV1; projection: DoctorNativeCapabilitiesV1 }> {
  if (probe === undefined) {
    return nativeDoctorFailure('E_NATIVE_PROFILE_UNAVAILABLE', 'native capability profile provider unavailable');
  }
  let result: Awaited<ReturnType<NonNullable<typeof probe>>>;
  try {
    result = await probe();
  } catch (error) {
    return nativeDoctorFailure(
      'E_NATIVE_PROFILE_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!result.ok) {
    return nativeDoctorFailure(result.error.code, result.error.message);
  }
  if (result.value.kind === 'host_absent') {
    const projection: DoctorNativeCapabilitiesV1 = {
      schema: 'oma.doctor-native/v1',
      profileDigest: null,
      outcome: 'unknown',
      counts: { supported: 0, unsupported: 0, unknown: 0 },
      cacheStatus: 'miss',
      identityStatus: 'absent',
      diagnostics: [...result.value.diagnostics],
    };
    return {
      check: {
        id: 'native_capabilities',
        status: 'warn',
        message: 'native capabilities unavailable (agy host absent)',
        detail: projection,
      },
      projection,
    };
  }
  try {
    const now = new Date(nowMs()).toISOString();
    const profile = validateHostCapabilityProfile(result.value.profile);
    const counts = profile.capabilities.reduce((current, capability) => ({
      ...current,
      [capability.outcome]: current[capability.outcome] + 1,
    }), { supported: 0, unsupported: 0, unknown: 0 });
    const present = (Object.keys(counts) as Array<keyof typeof counts>)
      .filter((key) => counts[key] > 0);
    const outcome = present.length === 1 ? present[0] : 'mixed';
    const projection: DoctorNativeCapabilitiesV1 = {
      schema: 'oma.doctor-native/v1',
      profileDigest: profile.profileDigest,
      outcome,
      counts,
      cacheStatus: profile.cacheable ? result.value.cacheStatus : 'non_cacheable',
      identityStatus: profile.identityStatus,
      diagnostics: [...(result.value.diagnostics ?? [])],
    };
    if (!isHostCapabilityProfileFresh(profile, now)) {
      const staleProjection: DoctorNativeCapabilitiesV1 = {
        ...projection,
        cacheStatus: 'non_cacheable',
        diagnostics: [
          ...projection.diagnostics,
          { code: 'E_CAPABILITY_PROFILE_STALE', message: 'native capability profile evidence is stale' },
        ],
      };
      return {
        check: {
          id: 'native_capabilities',
          status: 'fail',
          message: 'native capability profile evidence is stale',
          detail: staleProjection,
        },
        projection: staleProjection,
      };
    }
    if (profile.identityStatus === 'drifted') {
      return {
        check: {
          id: 'native_capabilities',
          status: 'fail',
          message: 'native capability identity drifted during passive inspection',
          detail: projection,
        },
        projection,
      };
    }
    return {
      check: {
        id: 'native_capabilities',
        status: 'pass',
        message: `native capability profile valid (${outcome})`,
        detail: projection,
      },
      projection,
    };
  } catch (error) {
    return nativeDoctorFailure(
      'E_NATIVE_PROFILE_INVALID',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function nativeDoctorFailure(
  code: string,
  message: string,
): { check: DoctorCheckV1; projection: DoctorNativeCapabilitiesV1 } {
  const projection: DoctorNativeCapabilitiesV1 = {
    schema: 'oma.doctor-native/v1',
    profileDigest: null,
    outcome: 'unknown',
    counts: { supported: 0, unsupported: 0, unknown: 0 },
    cacheStatus: 'non_cacheable',
    identityStatus: 'drifted',
    diagnostics: [{ code, message }],
  };
  return {
    check: {
      id: 'native_capabilities',
      status: 'fail',
      message: `native capability profile invalid (${code})`,
      detail: projection,
    },
    projection,
  };
}

function checkNodeVersion(): DoctorCheckV1 {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major >= 20) {
    return { id: 'node', status: 'pass', message: `Node ${process.versions.node} (>=20)` };
  }
  return {
    id: 'node',
    status: 'fail',
    message: `Node ${process.versions.node} is below required >=20`,
  };
}

function checkPackageRoot(packageRoot: string, version: string): DoctorCheckV1 {
  const pkg = path.join(packageRoot, 'package.json');
  const bin = path.join(packageRoot, 'dist', 'bin', 'oma.js');
  if (!fs.existsSync(pkg)) {
    return { id: 'package_root', status: 'fail', message: 'package.json missing', detail: { packageRoot } };
  }
  if (!fs.existsSync(bin)) {
    return {
      id: 'package_root',
      status: 'fail',
      message: 'dist/bin/oma.js missing — run npm run build',
      detail: { bin },
    };
  }
  return {
    id: 'package_root',
    status: 'pass',
    message: `package root ready (v${version})`,
    detail: { packageRoot },
  };
}

function failVersionSync(message: string, detail?: unknown): DoctorCheckV1 {
  return {
    id: 'version_sync',
    status: 'fail',
    message,
    ...(detail === undefined ? {} : { detail }),
  };
}

function readJsonObject(
  filePath: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; cause: string } {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, cause: 'JSON root is not an object' };
    }
    return { ok: true, value: raw as Record<string, unknown> };
  } catch (error) {
    return { ok: false, cause: error instanceof Error ? error.message : String(error) };
  }
}

function manifestVersion(raw: Record<string, unknown>): string | undefined {
  return typeof raw.version === 'string' ? raw.version : undefined;
}

/**
 * 設計概念映射：OMC `scripts/sync-version.sh` 把 package.json 版本寫進
 * `.claude-plugin/plugin.json` 與 `marketplace.json`（頂層 + plugin 條目）。
 * OMA 以 doctor `version_sync` 四方比對取代 shell 同步，過期 catalog 必須紅燈。
 */
function checkPluginManifestVersion(packageRoot: string, packageVersion: string): DoctorCheckV1 {
  const pluginPath = path.join(packageRoot, 'plugin.json');
  const pluginResult = readJsonObject(pluginPath);
  if (!pluginResult.ok) {
    return failVersionSync('plugin.json unreadable', { cause: pluginResult.cause });
  }
  const pluginVersion = manifestVersion(pluginResult.value);
  if (pluginVersion !== packageVersion) {
    return failVersionSync(
      `plugin.json version ${pluginVersion ?? 'missing'} != package.json ${packageVersion}`,
    );
  }
  const pluginName = typeof pluginResult.value.name === 'string' && pluginResult.value.name.length > 0
    ? pluginResult.value.name
    : 'oh-my-agy';

  const claudePath = path.join(packageRoot, '.claude-plugin', 'plugin.json');
  const claudePresent = fs.existsSync(claudePath);
  if (claudePresent) {
    const claudeResult = readJsonObject(claudePath);
    if (!claudeResult.ok) {
      return failVersionSync('.claude-plugin/plugin.json unreadable', { cause: claudeResult.cause });
    }
    const claudeVersion = manifestVersion(claudeResult.value);
    if (claudeVersion !== packageVersion) {
      return failVersionSync(
        `.claude-plugin/plugin.json version ${claudeVersion ?? 'missing'} != package.json ${packageVersion}`,
      );
    }
  }

  // Claude slash surface 必須連 marketplace catalog 一起對齊，否則會裝到舊版本宣傳
  const marketplacePath = path.join(packageRoot, '.claude-plugin', 'marketplace.json');
  const marketplacePresent = fs.existsSync(marketplacePath);
  if (claudePresent && !marketplacePresent) {
    return failVersionSync(
      `.claude-plugin/marketplace.json missing != package.json ${packageVersion}`,
    );
  }
  if (marketplacePresent) {
    const marketplaceResult = readJsonObject(marketplacePath);
    if (!marketplaceResult.ok) {
      return failVersionSync(
        '.claude-plugin/marketplace.json unreadable',
        { cause: marketplaceResult.cause },
      );
    }
    const marketplaceVersion = manifestVersion(marketplaceResult.value);
    if (marketplaceVersion !== packageVersion) {
      return failVersionSync(
        `.claude-plugin/marketplace.json version ${marketplaceVersion ?? 'missing'} != package.json ${packageVersion}`,
      );
    }
    const plugins = marketplaceResult.value.plugins;
    const entries = Array.isArray(plugins) ? plugins : [];
    const entry = entries.find((item) => (
      typeof item === 'object'
      && item !== null
      && !Array.isArray(item)
      && (item as { name?: unknown }).name === pluginName
    )) as Record<string, unknown> | undefined;
    const entryVersion = entry === undefined ? undefined : manifestVersion(entry);
    if (entryVersion !== packageVersion) {
      return failVersionSync(
        `.claude-plugin/marketplace.json plugin ${pluginName} version ${entryVersion ?? 'missing'} != package.json ${packageVersion}`,
      );
    }
  }

  const claudeSynced = claudePresent;
  const marketplaceSynced = marketplacePresent;
  return {
    id: 'version_sync',
    status: 'pass',
    message: claudeSynced && marketplaceSynced
      ? `package.json, plugin.json, .claude-plugin/plugin.json, and .claude-plugin/marketplace.json all ${packageVersion}`
      : marketplaceSynced
        ? `package.json, plugin.json, and .claude-plugin/marketplace.json all ${packageVersion} (.claude-plugin/plugin.json absent)`
        : `package.json and plugin.json both ${packageVersion} (.claude-plugin absent)`,
    detail: {
      name: pluginResult.value.name,
      claudePluginSynced: claudeSynced,
      marketplaceSynced,
    },
  };
}

function checkHooks(packageRoot: string): DoctorCheckV1 {
  const hooks = resolveHookEntrypoints(packageRoot);
  if (!hooks.ok) {
    return {
      id: 'hooks',
      status: 'fail',
      message: hooks.error.message,
      detail: hooks.error,
    };
  }
  return {
    id: 'hooks',
    status: 'pass',
    message: 'PreInvocation + Stop compiled entrypoints present',
    detail: hooks.value,
  };
}

function checkClaudePluginManifest(packageRoot: string): DoctorCheckV1 {
  const manifest = path.join(packageRoot, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifest)) {
    return {
      id: 'claude_plugin_manifest',
      status: 'fail',
      message: 'Missing .claude-plugin/plugin.json (Claude Code slash skills will not register)',
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
      name?: string;
      skills?: unknown;
    };
    if (raw.name !== 'oh-my-agy') {
      return {
        id: 'claude_plugin_manifest',
        status: 'warn',
        message: `Claude plugin name is ${raw.name ?? 'missing'} (expected oh-my-agy for /oh-my-agy:… slash)`,
      };
    }
    if (!Array.isArray(raw.skills) || raw.skills.length === 0) {
      return {
        id: 'claude_plugin_manifest',
        status: 'fail',
        message: '.claude-plugin/plugin.json has empty skills[]',
      };
    }
    return {
      id: 'claude_plugin_manifest',
      status: 'pass',
      message: `Claude plugin manifest ok (${raw.skills.length} skills) → /oh-my-agy:autopilot`,
      detail: { skills: raw.skills.length },
    };
  } catch (error) {
    return {
      id: 'claude_plugin_manifest',
      status: 'fail',
      message: '.claude-plugin/plugin.json unreadable',
      detail: { cause: error instanceof Error ? error.message : String(error) },
    };
  }
}

function checkSlashSkillSurface(packageRoot: string): DoctorCheckV1 {
  const autopilot = path.join(packageRoot, 'skills', 'autopilot', 'SKILL.md');
  if (!fs.existsSync(autopilot)) {
    return {
      id: 'slash_skills',
      status: 'fail',
      message: 'skills/autopilot/SKILL.md missing',
    };
  }
  const body = fs.readFileSync(autopilot, 'utf8');
  // 硬標記：避免僅提到 “slash” 就假綠（CLI-first 文檔也可能含 slash 字樣）
  const inSessionFirst = /You are already in the agent session/i.test(body)
    || /IN-SESSION PRIMARY/i.test(body);
  return {
    id: 'slash_skills',
    status: inSessionFirst ? 'pass' : 'warn',
    message: inSessionFirst
      ? 'autopilot skill present (in-session primary language detected)'
      : 'autopilot skill present but body may still be CLI-first — prefer slash-first wording',
    detail: { path: autopilot },
  };
}

/**
 * 雙向比對 `.claude-plugin/plugin.json` `skills[]` 與 `skills/<name>/SKILL.md`。
 * 設計概念映射：OMX `sync:plugin:check` / `verify:plugin-bundle`（plugin bundle 必須鏡像
 * top-level skills/）；缺檔或未宣告目錄皆 fail-closed。
 */
function checkSkillManifestDrift(packageRoot: string): DoctorCheckV1 {
  const manifestPath = path.join(packageRoot, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    return {
      id: 'skill_manifest_drift',
      status: 'fail',
      message: '.claude-plugin/plugin.json missing — cannot verify skill manifest',
    };
  }
  let raw: { skills?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { skills?: unknown };
  } catch (error) {
    return {
      id: 'skill_manifest_drift',
      status: 'fail',
      message: '.claude-plugin/plugin.json unreadable',
      detail: { cause: error instanceof Error ? error.message : String(error) },
    };
  }
  if (!Array.isArray(raw.skills)) {
    return {
      id: 'skill_manifest_drift',
      status: 'fail',
      message: '.claude-plugin/plugin.json skills[] is not an array',
    };
  }
  const declared: string[] = [];
  for (const entry of raw.skills) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return {
        id: 'skill_manifest_drift',
        status: 'fail',
        message: '.claude-plugin/plugin.json skills[] contains a non-string entry',
      };
    }
    const name = normalizeClaudePluginSkillEntry(entry);
    if (name === '') {
      return {
        id: 'skill_manifest_drift',
        status: 'fail',
        message: '.claude-plugin/plugin.json skills[] contains an empty skill path',
      };
    }
    declared.push(name);
  }
  const declaredUnique = [...new Set(declared)].sort();
  const onDisk = [...listWorkflowSkillNames(packageRoot)].sort();
  const missingFiles = declaredUnique.filter((name) => !onDisk.includes(name));
  const undeclared = onDisk.filter((name) => !declaredUnique.includes(name));
  if (missingFiles.length > 0 || undeclared.length > 0) {
    const bits = [
      missingFiles.length > 0 ? `missing files for declared skills (${missingFiles.join(', ')})` : '',
      undeclared.length > 0 ? `undeclared skill directories (${undeclared.join(', ')})` : '',
    ].filter((bit) => bit !== '');
    return {
      id: 'skill_manifest_drift',
      status: 'fail',
      message: `skill manifest drifted: ${bits.join('; ')}`,
      detail: { declared: declaredUnique, onDisk, missingFiles, undeclared },
    };
  }
  return {
    id: 'skill_manifest_drift',
    status: 'pass',
    message: `skill manifest matches plugin.json skills[] and skills/*/SKILL.md (${onDisk.length} skills)`,
    detail: { skills: onDisk },
  };
}

function checkOmcAutopilotCollision(homeDir: string): DoctorCheckV1 {
  const omcPaths = [
    path.join(homeDir, '.claude', 'skills', 'autopilot', 'SKILL.md'),
    path.join(homeDir, '.claude', 'plugins', 'cache', 'omc'),
  ];
  const found = omcPaths.filter((p) => fs.existsSync(p));
  if (found.length === 0) {
    return {
      id: 'slash_collision',
      status: 'pass',
      message: 'No obvious OMC bare /autopilot skill at ~/.claude/skills/autopilot',
    };
  }
  return {
    id: 'slash_collision',
    status: 'warn',
    message:
      'OMC/compat autopilot skill may own bare /autopilot — use /oh-my-agy:autopilot for OMA',
    detail: { found },
  };
}

function checkAgyOnPath(
  agyCommand: string,
  homeDir: string,
  configRoot?: string,
): DoctorCheckV1 {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
  if (configRoot !== undefined) {
    env.ANTIGRAVITY_CONFIG_ROOT = configRoot;
    env.OMA_ANTIGRAVITY_CONFIG_ROOT = configRoot;
  }
  const probe = spawnSync(agyCommand, ['plugin', 'help'], {
    encoding: 'utf8',
    timeout: 15_000,
    env,
  });
  if (probe.error) {
    // slash-first：Claude/Grok 主路徑不強制 agy；缺席改 warn（hooks/managed 才真正需要）
    return {
      id: 'agy_path',
      status: 'warn',
      message:
        `agy not runnable (${agyCommand}): ${probe.error.message} `
        + '— optional for /oh-my-agy:autopilot slash; required only for managed hooks',
    };
  }
  // help 可能 exit 0 或 1，重點是能 spawn
  return {
    id: 'agy_path',
    status: 'pass',
    message: `agy command reachable (${agyCommand})`,
    detail: { code: probe.status },
  };
}

function checkStateRoot(
  stateRoot: string | undefined,
  homeDir: string,
  isolateHome: boolean,
): DoctorCheckV1 {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (stateRoot !== undefined) env.OMA_STATE_ROOT = path.resolve(stateRoot);
  else if (isolateHome) delete env.OMA_STATE_ROOT;
  const state = resolveStateRoot({ create: true, env, homeDirectory: homeDir });
  if (!state.ok) {
    return {
      id: 'state_root',
      status: 'fail',
      message: state.error.message,
      detail: state.error,
    };
  }
  return {
    id: 'state_root',
    status: 'pass',
    message: `state root ok (${state.value.source})`,
    detail: { path: state.value.path },
  };
}

async function checkPluginRegistry(
  packageRoot: string,
  adapter: PluginCommandAdapter,
  mode: 'development' | 'strict' | 'release',
  identityRoots: { antigravityConfigRoot?: string; homeDir?: string },
): Promise<DoctorCheckV1> {
  const name = readPackagePluginName(packageRoot);
  if (!name.ok) {
    return { id: 'plugin_registry', status: 'fail', message: name.error.message };
  }
  const active = await verifyPluginActive({
    packageRoot,
    adapter,
    pluginName: name.value,
    antigravityConfigRoot: identityRoots.antigravityConfigRoot,
    homeDir: identityRoots.homeDir,
  });
  if (active.ok) {
    return {
      id: 'plugin_registry',
      status: 'pass',
      message: `plugin ${name.value} exact installed identity verified`,
      detail: {
        version: active.value.version,
        installPath: active.value.installPath,
        installedDigest: active.value.installedDigest,
        sourceDigest: active.value.sourceDigest,
        components: active.value.components,
      },
    };
  }
  const hardMismatch = active.error.details !== undefined
    && (
      typeof active.error.details.expectedVersion === 'string'
        && typeof active.error.details.actualVersion === 'string'
      || typeof active.error.details.registryVersion === 'string'
        && typeof active.error.details.installedVersion === 'string'
    );
  const hard = hardMismatch || mode !== 'development';
  return {
    id: 'plugin_registry',
    status: hard ? 'fail' : 'warn',
    message: active.error.message,
    detail: active.error,
  };
}

function readPackageJsonVersion(packageRoot: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return typeof raw.version === 'string' ? raw.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function defaultAgyListAdapter(
  agyCommand: string,
  env: NodeJS.ProcessEnv = process.env,
): PluginCommandAdapter {
  return {
    async run(argv) {
      const result = spawnSync(agyCommand, [...argv], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...env },
      });
      return {
        argv: [...argv],
        code: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? (result.error?.message ?? ''),
      };
    },
  };
}

export function doctorReportToLines(report: DoctorReportV1): string[] {
  const lines = [
    `oma doctor v${report.packageVersion}`,
    `mode: ${report.mode}`,
    `packageRoot: ${report.packageRoot}`,
    `result: ${report.ok ? 'OK' : 'ISSUES'} (exit ${report.exitCode})`,
    '',
  ];
  for (const check of report.checks) {
    const mark = check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗';
    lines.push(`${mark} [${check.id}] ${check.message}`);
  }
  lines.push('');
  if (!report.ok) {
    lines.push('Fix: npm run build && oma setup && re-run oma doctor');
  }
  return lines;
}
