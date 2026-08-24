import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveStateRoot } from '../runtime/state-root';
import { RuntimeError } from '../runtime/errors';
import { Result, ok } from '../runtime/types';
import { projectHooksObservation } from '../cli/hooks-commands';
import {
  HostCapabilityProfileV1,
  validateHostCapabilityProfile,
} from '../native/capability-profile';
import { isHostCapabilityProfileFresh } from '../native/probes/cache';
import {
  hooksDisabled,
  hookSkipped,
  HookNameV1,
} from '../hooks/common';
import {
  PluginCommandAdapter,
  readPackagePluginName,
  resolveHookEntrypoints,
  verifyPluginActive,
} from './plugin';
import { normalizeClaudePluginSkillEntry } from '../modes/skill-catalog';
import { listWorkflowSkillNames } from '../modes/skill-loader';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

/** `--json` 每列固定欄位序；detail 僅在有值時接在最後。 */
export const DOCTOR_CHECK_JSON_KEYS = ['id', 'status', 'message', 'nextAction'] as const;

export interface DoctorCheckV1 {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  nextAction: string;
  detail?: unknown;
}

const NEXT_NONE = 'No action required.';
const HOOK_NAMES_V1: readonly HookNameV1[] = [
  'pre-invocation', 'stop', 'session-start', 'post-invocation',
];

/**
 * 每個 check builder 必須經此函式產出，以保證 nextAction 非空且 JSON 欄位序穩定。
 * 設計概念映射：OMG doctor envelope 的 next_action；OMA 欄位名為 camelCase nextAction。
 */
export function doctorCheck(
  id: string,
  status: DoctorCheckStatus,
  message: string,
  nextAction: string,
  detail?: unknown,
): DoctorCheckV1 {
  const trimmed = nextAction.trim();
  if (trimmed === '') {
    throw new Error(`DoctorCheckV1 ${id} requires a non-empty nextAction`);
  }
  const check: DoctorCheckV1 = {
    id,
    status,
    message,
    nextAction: trimmed,
  };
  if (detail !== undefined) check.detail = detail;
  return check;
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
  /** 測試注入 kill switch；未給則讀 process.env。 */
  environment?: NodeJS.ProcessEnv;
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
  const environment = input.environment ?? process.env;
  const configRoot = input.antigravityConfigRoot === undefined
    ? input.homeDir === undefined ? undefined : path.join(homeDir, '.gemini', 'config')
    : path.resolve(input.antigravityConfigRoot);
  const checks: DoctorCheckV1[] = [];

  checks.push(checkNodeVersion());
  checks.push(checkPackageRoot(packageRoot, packageVersion));
  checks.push(checkPluginManifestVersion(packageRoot, packageVersion));
  checks.push(checkClaudePluginManifest(packageRoot));
  checks.push(checkMcpRegistration(packageRoot));
  checks.push(checkSlashSkillSurface(packageRoot));
  checks.push(checkSkillManifestDrift(packageRoot));
  checks.push(checkHooks(packageRoot));
  checks.push(checkHooksKillSwitch(environment));
  checks.push(checkAgyOnPath(agyCommand, homeDir, configRoot));
  checks.push(checkStateRoot(input.stateRoot, homeDir, input.homeDir !== undefined));
  checks.push(checkHooksObserved(input.stateRoot, homeDir, input.homeDir !== undefined));
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
      check: doctorCheck(
        'native_capabilities',
        'warn',
        'native capabilities unavailable (agy host absent)',
        'Install agy on PATH, then re-run oma doctor --native.',
        projection,
      ),
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
        check: doctorCheck(
          'native_capabilities',
          'fail',
          'native capability profile evidence is stale',
          'Re-run oma doctor --native after a fresh identity-bound capability inspection; stale profiles cannot be auto-fixed.',
          staleProjection,
        ),
        projection: staleProjection,
      };
    }
    if (profile.identityStatus === 'drifted') {
      return {
        check: doctorCheck(
          'native_capabilities',
          'fail',
          'native capability identity drifted during passive inspection',
          'Re-run oma doctor --native after a fresh identity-bound capability inspection; drifted profiles cannot be auto-fixed.',
          projection,
        ),
        projection,
      };
    }
    return {
      check: doctorCheck(
        'native_capabilities',
        'pass',
        `native capability profile valid (${outcome})`,
        NEXT_NONE,
        projection,
      ),
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
    check: doctorCheck(
      'native_capabilities',
      'fail',
      `native capability profile invalid (${code})`,
      'Re-run oma doctor --native after a successful identity-bound probe; invalid profiles cannot be auto-fixed.',
      projection,
    ),
    projection,
  };
}

function checkNodeVersion(): DoctorCheckV1 {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major >= 20) {
    return doctorCheck('node', 'pass', `Node ${process.versions.node} (>=20)`, NEXT_NONE);
  }
  return doctorCheck(
    'node',
    'fail',
    `Node ${process.versions.node} is below required >=20`,
    'Install Node.js 20 or newer, then re-run oma doctor.',
  );
}

function checkPackageRoot(packageRoot: string, version: string): DoctorCheckV1 {
  const pkg = path.join(packageRoot, 'package.json');
  const bin = path.join(packageRoot, 'dist', 'bin', 'oma.js');
  if (!fs.existsSync(pkg)) {
    return doctorCheck(
      'package_root',
      'fail',
      'package.json missing',
      'Run oma doctor from the oh-my-agy package root (the directory that contains package.json).',
      { packageRoot },
    );
  }
  if (!fs.existsSync(bin)) {
    return doctorCheck(
      'package_root',
      'fail',
      'dist/bin/oma.js missing — run npm run build',
      'Run npm run build, then re-run oma doctor.',
      { bin },
    );
  }
  return doctorCheck(
    'package_root',
    'pass',
    `package root ready (v${version})`,
    NEXT_NONE,
    { packageRoot },
  );
}

function failVersionSync(message: string, detail?: unknown): DoctorCheckV1 {
  return doctorCheck(
    'version_sync',
    'fail',
    message,
    'Align plugin.json, .claude-plugin/plugin.json, and .claude-plugin/marketplace.json versions with package.json, then re-run oma doctor.',
    detail,
  );
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
  return doctorCheck(
    'version_sync',
    'pass',
    claudeSynced && marketplaceSynced
      ? `package.json, plugin.json, .claude-plugin/plugin.json, and .claude-plugin/marketplace.json all ${packageVersion}`
      : marketplaceSynced
        ? `package.json, plugin.json, and .claude-plugin/marketplace.json all ${packageVersion} (.claude-plugin/plugin.json absent)`
        : `package.json and plugin.json both ${packageVersion} (.claude-plugin absent)`,
    NEXT_NONE,
    {
      name: pluginResult.value.name,
      claudePluginSynced: claudeSynced,
      marketplaceSynced,
    },
  );
}

function checkHooks(packageRoot: string): DoctorCheckV1 {
  const hooks = resolveHookEntrypoints(packageRoot);
  if (!hooks.ok) {
    return doctorCheck(
      'hooks',
      'fail',
      hooks.error.message,
      'Run npm run build so dist/src/hooks/pre-invocation.js and stop.js exist, then re-run oma doctor.',
      hooks.error,
    );
  }
  return doctorCheck(
    'hooks',
    'pass',
    'PreInvocation + Stop compiled entrypoints present',
    NEXT_NONE,
    hooks.value,
  );
}

const HOOKS_KILL_SWITCH_NEXT =
  'Unset DISABLE_OMA and/or OMA_SKIP_HOOKS in this shell and the host launcher env, then restart the host so hooks can run. oma doctor --fix cannot change environment variables.';

/**
 * informational：回報 DISABLE_OMA / OMA_SKIP_HOOKS 是否把 hook 關掉。
 * 設計概念映射：OMC DISABLE_OMC / OMC_SKIP_HOOKS；kill-switch issue 刻意延後到 #50。
 */
function checkHooksKillSwitch(env: NodeJS.ProcessEnv): DoctorCheckV1 {
  const disableRaw = env.DISABLE_OMA;
  const skipRaw = env.OMA_SKIP_HOOKS;
  const disableSet = typeof disableRaw === 'string' && disableRaw.trim() !== '';
  const skipSet = typeof skipRaw === 'string' && skipRaw.trim() !== '';
  if (!disableSet && !skipSet) {
    return doctorCheck(
      'hooks_kill_switch',
      'pass',
      'hook kill switches unset (DISABLE_OMA / OMA_SKIP_HOOKS)',
      NEXT_NONE,
    );
  }
  const skipped = HOOK_NAMES_V1.filter((name) => hookSkipped(name, env));
  const bits: string[] = [];
  if (hooksDisabled(env)) {
    bits.push(`DISABLE_OMA=${JSON.stringify(disableRaw)} disables all Antigravity hooks`);
  } else if (disableSet) {
    bits.push(`DISABLE_OMA is set to ${JSON.stringify(disableRaw)}`);
  }
  if (skipped.length > 0) {
    bits.push(`OMA_SKIP_HOOKS=${JSON.stringify(skipRaw)} skips ${skipped.join(', ')}`);
  } else if (skipSet) {
    bits.push(`OMA_SKIP_HOOKS is set to ${JSON.stringify(skipRaw)}`);
  }
  return doctorCheck(
    'hooks_kill_switch',
    'warn',
    `hooks are currently off: ${bits.join('; ')}`,
    HOOKS_KILL_SWITCH_NEXT,
    {
      DISABLE_OMA: disableSet ? disableRaw : null,
      OMA_SKIP_HOOKS: skipSet ? skipRaw : null,
      skipped,
      allDisabled: hooksDisabled(env),
    },
  );
}

/** Claude Code plugin.json 的 mcpServers 路徑（相對 plugin root，須以 ./ 開頭）。 */
export const CLAUDE_PLUGIN_MCP_SERVERS_PATH = './.claude-plugin/.mcp.json';

/**
 * 設計概念映射：OMC `.claude-plugin/plugin.json` 的 `mcpServers` 指向
 * `${CLAUDE_PLUGIN_ROOT}` 版 `.mcp.json`；OMG 則另跑 `grok mcp add`。
 * 未註冊只 WARN，避免既有安裝一次打成紅燈（#49）。禁止 fail。
 */
function checkMcpRegistration(packageRoot: string): DoctorCheckV1 {
  const id = 'mcp_registration';
  const next = 'Point .claude-plugin/plugin.json mcpServers at ./.claude-plugin/.mcp.json using ${CLAUDE_PLUGIN_ROOT}, then run oma setup --host claude (and oma setup --host grok for Grok MCP).';
  const warn = (message: string, detail?: unknown): DoctorCheckV1 => doctorCheck(
    id,
    'warn',
    message,
    next,
    detail,
  );
  const manifestPath = path.join(packageRoot, '.claude-plugin', 'plugin.json');
  const mcpPath = path.join(packageRoot, '.claude-plugin', '.mcp.json');
  if (!fs.existsSync(manifestPath)) {
    return warn('Claude plugin manifest missing; MCP server is unregistered');
  }
  const manifest = readJsonObject(manifestPath);
  if (!manifest.ok) {
    return warn('.claude-plugin/plugin.json unreadable for mcpServers', { cause: manifest.cause });
  }
  const mcpServersField = manifest.value.mcpServers;
  const pointed = resolveMcpServersPath(mcpServersField);
  if (pointed !== CLAUDE_PLUGIN_MCP_SERVERS_PATH) {
    return warn(
      'Claude plugin mcpServers is unregistered (expected ./.claude-plugin/.mcp.json)',
      { mcpServers: mcpServersField ?? null },
    );
  }
  if (!fs.existsSync(mcpPath)) {
    return warn('Claude MCP config missing (.claude-plugin/.mcp.json); MCP server is unregistered');
  }
  let raw: string;
  try {
    raw = fs.readFileSync(mcpPath, 'utf8');
  } catch (error) {
    return warn('.claude-plugin/.mcp.json unreadable', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (raw.includes('${extensionPath}')) {
    return warn(
      '.claude-plugin/.mcp.json uses ${extensionPath} (Antigravity-only); expected ${CLAUDE_PLUGIN_ROOT}',
    );
  }
  if (!raw.includes('${CLAUDE_PLUGIN_ROOT}')) {
    return warn('.claude-plugin/.mcp.json is missing ${CLAUDE_PLUGIN_ROOT}');
  }
  const parsed = readJsonObject(mcpPath);
  if (!parsed.ok) {
    return warn('.claude-plugin/.mcp.json is not a JSON object', { cause: parsed.cause });
  }
  const servers = parsed.value.mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return warn('.claude-plugin/.mcp.json is missing mcpServers object');
  }
  const entry = (servers as Record<string, unknown>)['oh-my-agy'];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return warn('.claude-plugin/.mcp.json is missing oh-my-agy server');
  }
  const server = entry as Record<string, unknown>;
  const args = Array.isArray(server.args) ? server.args : [];
  const hasBin = args.some((item) => (
    typeof item === 'string' && item.includes('${CLAUDE_PLUGIN_ROOT}') && item.endsWith('oma.js')
  ));
  const hasVerb = args.some((item) => item === 'mcp-server');
  if (server.command !== 'node' || !hasBin || !hasVerb) {
    return warn(
      '.claude-plugin/.mcp.json oh-my-agy server does not launch node .../oma.js mcp-server',
      { command: server.command, args },
    );
  }
  return doctorCheck(
    id,
    'pass',
    'Claude plugin MCP wiring present (${CLAUDE_PLUGIN_ROOT}); Grok MCP is registered by oma setup --host grok',
    NEXT_NONE,
    {
      mcpServers: pointed,
      config: '.claude-plugin/.mcp.json',
    },
  );
}

function resolveMcpServersPath(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const paths = raw.filter((item): item is string => typeof item === 'string');
    return paths.find((item) => item === CLAUDE_PLUGIN_MCP_SERVERS_PATH) ?? paths[0];
  }
  return undefined;
}

/**
 * 設計概念映射：OMX `omx hooks status` 與 OMG doctor hook 形狀檢查。
 * 只 warn、不 fail — 既有安裝不得因為「host 還沒叫過 hook」被一次打紅。
 * 消費 `oma hooks status` 同一份投影；未觀察到必須寫明，不得全綠。
 */
function checkHooksObserved(
  stateRoot: string | undefined,
  homeDir: string,
  isolateHome: boolean,
): DoctorCheckV1 {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (stateRoot !== undefined) env.OMA_STATE_ROOT = path.resolve(stateRoot);
  else if (isolateHome) delete env.OMA_STATE_ROOT;
  let root: string;
  if (stateRoot !== undefined && stateRoot.trim() !== '') {
    root = path.resolve(stateRoot);
  } else {
    const state = resolveStateRoot({ create: false, env, homeDirectory: homeDir });
    if (!state.ok) {
      return doctorCheck(
        'hooks_observed',
        'warn',
        `未觀察到 — cannot read state root (${state.error.message})`,
        'Set OMA_STATE_ROOT to a writable directory, restart the Antigravity host after oma setup, then re-run oma hooks status.',
        { code: state.error.code },
      );
    }
    root = state.value.path;
  }
  const projection = projectHooksObservation(root);
  if (projection.observed) {
    return doctorCheck(
      'hooks_observed',
      'pass',
      projection.message,
      NEXT_NONE,
      projection,
    );
  }
  return doctorCheck(
    'hooks_observed',
    'warn',
    projection.message,
    'Restart the Antigravity host after oma setup so PreInvocation/Stop actually run, then re-run oma hooks status. oma doctor --fix cannot invent hook evidence.',
    projection,
  );
}

function checkClaudePluginManifest(packageRoot: string): DoctorCheckV1 {
  const manifest = path.join(packageRoot, '.claude-plugin', 'plugin.json');
  const restoreNext = 'Restore .claude-plugin/plugin.json from the oh-my-agy package, then re-run oma doctor.';
  if (!fs.existsSync(manifest)) {
    return doctorCheck(
      'claude_plugin_manifest',
      'fail',
      'Missing .claude-plugin/plugin.json (Claude Code slash skills will not register)',
      restoreNext,
    );
  }
  try {
    const raw = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
      name?: string;
      skills?: unknown;
    };
    if (raw.name !== 'oh-my-agy') {
      return doctorCheck(
        'claude_plugin_manifest',
        'warn',
        `Claude plugin name is ${raw.name ?? 'missing'} (expected oh-my-agy for /oh-my-agy:… slash)`,
        'Set .claude-plugin/plugin.json name to "oh-my-agy" so /oh-my-agy:… slash skills register.',
      );
    }
    if (!Array.isArray(raw.skills) || raw.skills.length === 0) {
      return doctorCheck(
        'claude_plugin_manifest',
        'fail',
        '.claude-plugin/plugin.json has empty skills[]',
        'Add skills[] entries to .claude-plugin/plugin.json matching skills/*/SKILL.md, then re-run oma doctor.',
      );
    }
    return doctorCheck(
      'claude_plugin_manifest',
      'pass',
      `Claude plugin manifest ok (${raw.skills.length} skills) → /oh-my-agy:autopilot`,
      NEXT_NONE,
      { skills: raw.skills.length },
    );
  } catch (error) {
    return doctorCheck(
      'claude_plugin_manifest',
      'fail',
      '.claude-plugin/plugin.json unreadable',
      restoreNext,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function checkSlashSkillSurface(packageRoot: string): DoctorCheckV1 {
  const autopilot = path.join(packageRoot, 'skills', 'autopilot', 'SKILL.md');
  if (!fs.existsSync(autopilot)) {
    return doctorCheck(
      'slash_skills',
      'fail',
      'skills/autopilot/SKILL.md missing',
      'Restore skills/autopilot/SKILL.md from the oh-my-agy package, then re-run oma doctor.',
    );
  }
  const body = fs.readFileSync(autopilot, 'utf8');
  // 硬標記：避免僅提到 “slash” 就假綠（CLI-first 文檔也可能含 slash 字樣）
  const inSessionFirst = /You are already in the agent session/i.test(body)
    || /IN-SESSION PRIMARY/i.test(body);
  return doctorCheck(
    'slash_skills',
    inSessionFirst ? 'pass' : 'warn',
    inSessionFirst
      ? 'autopilot skill present (in-session primary language detected)'
      : 'autopilot skill present but body may still be CLI-first — prefer slash-first wording',
    inSessionFirst
      ? NEXT_NONE
      : 'Rewrite skills/autopilot/SKILL.md to in-session primary (slash-first) wording.',
    { path: autopilot },
  );
}

/**
 * 雙向比對 `.claude-plugin/plugin.json` `skills[]` 與 `skills/<name>/SKILL.md`。
 * 設計概念映射：OMX `sync:plugin:check` / `verify:plugin-bundle`（plugin bundle 必須鏡像
 * top-level skills/）；缺檔或未宣告目錄皆 fail-closed。
 */
function checkSkillManifestDrift(packageRoot: string): DoctorCheckV1 {
  const manifestPath = path.join(packageRoot, '.claude-plugin', 'plugin.json');
  const driftNext = 'Keep .claude-plugin/plugin.json skills[] in sync with skills/*/SKILL.md (add missing files or declare undeclared directories), then re-run oma doctor.';
  if (!fs.existsSync(manifestPath)) {
    return doctorCheck(
      'skill_manifest_drift',
      'fail',
      '.claude-plugin/plugin.json missing — cannot verify skill manifest',
      driftNext,
    );
  }
  let raw: { skills?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { skills?: unknown };
  } catch (error) {
    return doctorCheck(
      'skill_manifest_drift',
      'fail',
      '.claude-plugin/plugin.json unreadable',
      driftNext,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!Array.isArray(raw.skills)) {
    return doctorCheck(
      'skill_manifest_drift',
      'fail',
      '.claude-plugin/plugin.json skills[] is not an array',
      driftNext,
    );
  }
  const declared: string[] = [];
  for (const entry of raw.skills) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return doctorCheck(
        'skill_manifest_drift',
        'fail',
        '.claude-plugin/plugin.json skills[] contains a non-string entry',
        driftNext,
      );
    }
    const name = normalizeClaudePluginSkillEntry(entry);
    if (name === '') {
      return doctorCheck(
        'skill_manifest_drift',
        'fail',
        '.claude-plugin/plugin.json skills[] contains an empty skill path',
        driftNext,
      );
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
    return doctorCheck(
      'skill_manifest_drift',
      'fail',
      `skill manifest drifted: ${bits.join('; ')}`,
      driftNext,
      { declared: declaredUnique, onDisk, missingFiles, undeclared },
    );
  }
  return doctorCheck(
    'skill_manifest_drift',
    'pass',
    `skill manifest matches plugin.json skills[] and skills/*/SKILL.md (${onDisk.length} skills)`,
    NEXT_NONE,
    { skills: onDisk },
  );
}

function checkOmcAutopilotCollision(homeDir: string): DoctorCheckV1 {
  const omcPaths = [
    path.join(homeDir, '.claude', 'skills', 'autopilot', 'SKILL.md'),
    path.join(homeDir, '.claude', 'plugins', 'cache', 'omc'),
  ];
  const found = omcPaths.filter((p) => fs.existsSync(p));
  if (found.length === 0) {
    return doctorCheck(
      'slash_collision',
      'pass',
      'No obvious OMC bare /autopilot skill at ~/.claude/skills/autopilot',
      NEXT_NONE,
    );
  }
  return doctorCheck(
    'slash_collision',
    'warn',
    'OMC/compat autopilot skill may own bare /autopilot — use /oh-my-agy:autopilot for OMA',
    'Use /oh-my-agy:autopilot instead of bare /autopilot, or remove the OMC skill at ~/.claude/skills/autopilot.',
    { found },
  );
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
    return doctorCheck(
      'agy_path',
      'warn',
      `agy not runnable (${agyCommand}): ${probe.error.message} `
        + '— optional for /oh-my-agy:autopilot slash; required only for managed hooks',
      'Install agy on PATH for managed hooks, or use slash-only: oma setup --host claude. oma doctor --fix will not retry agy forever.',
    );
  }
  // help 可能 exit 0 或 1，重點是能 spawn
  return doctorCheck(
    'agy_path',
    'pass',
    `agy command reachable (${agyCommand})`,
    NEXT_NONE,
    { code: probe.status },
  );
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
    return doctorCheck(
      'state_root',
      'fail',
      state.error.message,
      'Set OMA_STATE_ROOT to a writable directory or fix HOME permissions, then re-run oma doctor.',
      state.error,
    );
  }
  return doctorCheck(
    'state_root',
    'pass',
    `state root ok (${state.value.source})`,
    NEXT_NONE,
    { path: state.value.path },
  );
}

async function checkPluginRegistry(
  packageRoot: string,
  adapter: PluginCommandAdapter,
  mode: 'development' | 'strict' | 'release',
  identityRoots: { antigravityConfigRoot?: string; homeDir?: string },
): Promise<DoctorCheckV1> {
  const name = readPackagePluginName(packageRoot);
  const pluginNext = 'Run oma setup or oma doctor --fix (owned plugin install/enable + readback; never git). If agy is missing, install agy or use oma setup --host claude.';
  if (!name.ok) {
    return doctorCheck('plugin_registry', 'fail', name.error.message, pluginNext);
  }
  const active = await verifyPluginActive({
    packageRoot,
    adapter,
    pluginName: name.value,
    antigravityConfigRoot: identityRoots.antigravityConfigRoot,
    homeDir: identityRoots.homeDir,
  });
  if (active.ok) {
    return doctorCheck(
      'plugin_registry',
      'pass',
      `plugin ${name.value} exact installed identity verified`,
      NEXT_NONE,
      {
        version: active.value.version,
        installPath: active.value.installPath,
        installedDigest: active.value.installedDigest,
        sourceDigest: active.value.sourceDigest,
        components: active.value.components,
      },
    );
  }
  const hardMismatch = active.error.details !== undefined
    && (
      typeof active.error.details.expectedVersion === 'string'
        && typeof active.error.details.actualVersion === 'string'
      || typeof active.error.details.registryVersion === 'string'
        && typeof active.error.details.installedVersion === 'string'
    );
  const hard = hardMismatch || mode !== 'development';
  return doctorCheck(
    'plugin_registry',
    hard ? 'fail' : 'warn',
    active.error.message,
    pluginNext,
    active.error,
  );
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
    // 人類模式：pass 不印 next action；warn / fail 才縮排第二行。
    if (check.status !== 'pass') {
      lines.push(`  next: ${check.nextAction}`);
    }
  }
  lines.push('');
  if (!report.ok) {
    lines.push('Fix: npm run build && oma setup && re-run oma doctor');
    lines.push('Safe auto-repair: oma doctor --fix (setup + plugin readback only; never git)');
  }
  return lines;
}

/** 穩定欄位序的 JSON 物件（id, status, message, nextAction, 可選 detail）。 */
export function doctorCheckToJsonValue(check: DoctorCheckV1): DoctorCheckV1 {
  return doctorCheck(check.id, check.status, check.message, check.nextAction, check.detail);
}

export function doctorReportToJsonValue(report: DoctorReportV1): DoctorReportV1 {
  const json: DoctorReportV1 = {
    schemaVersion: 1,
    ok: report.ok,
    exitCode: report.exitCode,
    packageRoot: report.packageRoot,
    packageVersion: report.packageVersion,
    mode: report.mode,
    checks: report.checks.map(doctorCheckToJsonValue),
  };
  if (report.nativeCapabilities !== undefined) {
    json.nativeCapabilities = report.nativeCapabilities;
  }
  return json;
}
