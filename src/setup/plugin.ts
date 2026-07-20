import * as fs from 'fs';
import * as path from 'path';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';

export interface PluginCommandResult {
  argv: readonly string[];
  code: number;
  stdout: string;
  stderr: string;
}

export interface PluginCommandAdapter {
  run(argv: readonly string[]): Promise<PluginCommandResult>;
}

export interface PluginHookEntrypoints {
  preInvocation: string;
  stop: string;
}

export interface PluginActiveEvidenceV1 {
  schemaVersion: 1;
  pluginName: string;
  installed: true;
  enabled: true;
  version: string;
  installPath: string;
  hookEntrypoints: PluginHookEntrypoints;
  listStdout: string;
}

export interface VerifyPluginActiveInput {
  packageRoot: string;
  adapter: PluginCommandAdapter;
  pluginName?: string;
}

const PRE_INVOCATION_COMMAND =
  'node "${extensionPath}/dist/src/hooks/pre-invocation.js"';
const STOP_COMMAND =
  'node "${extensionPath}/dist/src/hooks/stop.js"';

export function readPackagePluginName(packageRoot: string): Result<string, RuntimeError> {
  try {
    const pluginPath = path.join(packageRoot, 'plugin.json');
    const raw = JSON.parse(fs.readFileSync(pluginPath, 'utf8')) as { name?: unknown };
    if (typeof raw.name !== 'string' || raw.name.trim() === '') {
      return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'plugin.json is missing a usable name'));
    }
    return ok(raw.name);
  } catch (error) {
    return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'plugin.json cannot be read', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function resolveCompiledHookPaths(packageRoot: string): Result<PluginHookEntrypoints, RuntimeError> {
  const preInvocation = path.join(packageRoot, 'dist', 'src', 'hooks', 'pre-invocation.js');
  const stop = path.join(packageRoot, 'dist', 'src', 'hooks', 'stop.js');
  if (!fs.existsSync(preInvocation) || !fs.existsSync(stop)) {
    return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'compiled hook entrypoints are missing'));
  }
  return ok({ preInvocation, stop });
}

export function resolveHookEntrypoints(packageRoot: string): Result<PluginHookEntrypoints, RuntimeError> {
  const compiled = resolveCompiledHookPaths(packageRoot);
  if (!compiled.ok) return compiled;
  const hooksPath = path.join(packageRoot, 'hooks.json');
  try {
    if (!fs.existsSync(hooksPath)) {
      return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'hooks.json is missing'));
    }
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as Record<string, unknown>;
    const registration = hooks['oh-my-agy-runtime'] as
      | { PreInvocation?: Array<{ command?: string }>; Stop?: Array<{ command?: string }> }
      | undefined;
    // setup fixture 可能只有空 hooks.json；有完整 registration 時強制權威 entrypoint。
    if (registration === undefined || Object.keys(hooks).length === 0) {
      return compiled;
    }
    const preCommand = registration.PreInvocation?.[0]?.command;
    const stopCommand = registration.Stop?.[0]?.command;
    if (preCommand !== PRE_INVOCATION_COMMAND || stopCommand !== STOP_COMMAND) {
      return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'hooks.json does not register authoritative entrypoints'));
    }
    return compiled;
  } catch (error) {
    return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'hooks.json cannot be read', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

/**
 * 設計概念映射：對齊 oh-my-codex/oh-my-claudecode 的 plugin preflight，
 * 只接受 list/readback 可核對的 installed+enabled 證據，缺任一項 fail-closed。
 */
export async function verifyPluginActive(
  input: Readonly<VerifyPluginActiveInput>,
): Promise<Result<PluginActiveEvidenceV1, RuntimeError>> {
  const packageRoot = path.resolve(input.packageRoot);
  const nameResult = readPackagePluginName(packageRoot);
  if (!nameResult.ok) return nameResult;
  const pluginName = input.pluginName ?? nameResult.value;
  const entrypoints = resolveHookEntrypoints(packageRoot);
  if (!entrypoints.ok) return entrypoints;

  const listed = await input.adapter.run(['plugin', 'list']);
  if (listed.code !== 0) {
    return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'plugin list failed', {
      code: listed.code,
      stderr: listed.stderr,
    }));
  }

  const parsed = parsePluginListLine(listed.stdout, pluginName);
  if (parsed === undefined) {
    return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'plugin is not present in registry readback', {
      stdout: listed.stdout,
      pluginName,
    }));
  }
  if (!parsed.enabled) {
    return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'plugin is installed but not enabled', {
      stdout: listed.stdout,
      pluginName,
    }));
  }

  return ok({
    schemaVersion: 1,
    pluginName,
    installed: true,
    enabled: true,
    version: parsed.version,
    installPath: parsed.installPath,
    hookEntrypoints: entrypoints.value,
    listStdout: listed.stdout,
  });
}

interface ParsedPluginListLine {
  version: string;
  enabled: boolean;
  installPath: string;
}

function parsePluginListLine(stdout: string, pluginName: string): ParsedPluginListLine | undefined {
  // 真實 agy：JSON imports 清單（install 後預設 enabled；disable 才會標 disabled）。
  const jsonHit = parsePluginListJson(stdout, pluginName);
  if (jsonHit !== undefined) return jsonHit;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.startsWith(pluginName)) continue;
    // 相容舊文字格式：`<name> <version> enabled|disabled <path>`
    const match = trimmed.match(
      new RegExp(`^${escapeRegExp(pluginName)}\\s+(\\S+)\\s+(enabled|disabled)\\s+(.+)$`),
    );
    if (match === null) continue;
    return {
      version: match[1]!,
      enabled: match[2] === 'enabled',
      installPath: match[3]!.trim(),
    };
  }
  return undefined;
}

function parsePluginListJson(stdout: string, pluginName: string): ParsedPluginListLine | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as {
      imports?: Array<{
        name?: string;
        source?: string;
        enabled?: boolean;
        version?: string;
        path?: string;
        installPath?: string;
        components?: string[];
      }>;
    };
    const entries = Array.isArray(parsed.imports) ? parsed.imports : [];
    const hit = entries.find((entry) => entry.name === pluginName);
    if (hit === undefined) return undefined;
    // list 無 enabled 欄位時：出現在 imports 即視為 installed+enabled（agy: already enabled）。
    const enabled = hit.enabled !== false;
    return {
      version: typeof hit.version === 'string' && hit.version !== '' ? hit.version : 'installed',
      enabled,
      installPath: hit.installPath ?? hit.path ?? hit.source ?? 'antigravity-registry',
    };
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
