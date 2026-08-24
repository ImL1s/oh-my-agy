/**
 * `oma hooks status|tail|test` 觀測面。
 *
 * 設計概念映射：OMX `omx hooks status|test`（本地 plugin / 合成事件，不是 host 證據）、
 * OMG doctor 對 hook JSON 形狀的誠實檢查。OMA 讀 `#46` 的
 * `<state-root>/logs/hook-debug.jsonl` 與 `<state-root>/lifecycle/*.jsonl`。
 *
 * `oma hooks test` 只證明本機 `dist/src/hooks/*.js` 可 spawn；**不是** host 會呼叫
 * PreInvocation/Stop 的證據。fail-open allow 不得讀成成功。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import { LifecycleEventV1, validateLifecycleEvent } from '../contracts/lifecycle';
import { hookDebugTarget } from '../hooks/debug-log';
import { HOOK_OPERATOR_DISABLED_SOURCE_V1 } from '../hooks/common';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { REDACTED, redactDiagnostic, redactValue } from '../runtime/redaction';
import { resolveStateRoot } from '../runtime/state-root';
import { Result, err, ok } from '../runtime/types';
import { resolveCompiledHookPaths } from '../setup/plugin';

export const HOOKS_TAIL_LIMIT_MIN = 1;
export const HOOKS_TAIL_LIMIT_MAX = 500;
export const HOOKS_TAIL_LIMIT_DEFAULT = 50;
export const HOOKS_NEVER_OBSERVED = '未觀察到';
export const HOOKS_TEST_NOT_HOST_PROOF =
  'NOT proof the host will invoke the hook';
export const HOOKS_USAGE =
  'Usage: oma hooks status [--json] | oma hooks tail [--limit <1..500>] | oma hooks test [--event pre-invocation|stop]';

const HOOKS_TEST_EVENTS = ['pre-invocation', 'stop'] as const;
export type HooksTestEventV1 = typeof HOOKS_TEST_EVENTS[number];

export interface HooksCommandContext {
  readonly cwd: string;
  readonly packageRoot: string;
  readonly stateRoot?: string;
  readonly environment: NodeJS.ProcessEnv;
  stdout(value: string): void;
  stderr(value: string): void;
  spawnSync?: HooksSpawnSyncV1;
}

export interface HooksSpawnResultV1 {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export type HooksSpawnSyncV1 = (
  command: string,
  argv: readonly string[],
  options: {
    input: string;
    encoding: 'utf8';
    timeout: number;
    maxBuffer: number;
    shell: false;
    windowsHide: true;
    env: NodeJS.ProcessEnv;
    cwd?: string;
  },
) => HooksSpawnResultV1;

export type ParsedHooksCommandV1 =
  | { readonly kind: 'status'; readonly asJson: boolean }
  | { readonly kind: 'tail'; readonly limit: number }
  | { readonly kind: 'test'; readonly event: HooksTestEventV1 };

export interface HooksObservationProjectionV1 {
  readonly store_kind: 'oma_hooks_observation';
  readonly schema_version: 1;
  readonly observed: boolean;
  readonly observation: 'never_observed' | 'observed';
  readonly last_seen_at: string | null;
  readonly binding_route: string | null;
  readonly managed_count: number;
  readonly fail_open_count: number;
  readonly operator_disabled_count: number;
  readonly lifecycle_event_count: number;
  readonly debug_event_count: number;
  readonly corrupt_lifecycle_lines: number;
  readonly corrupt_debug_lines: number;
  readonly missing_lifecycle_dir: boolean;
  readonly missing_debug_log: boolean;
  readonly lifecycle_files: readonly string[];
  readonly message: string;
}

export interface HooksTailEventV1 {
  readonly at: string;
  readonly channel: 'lifecycle' | 'hook_debug';
  readonly event: string;
  readonly source: string;
  readonly binding_route: string | null;
  readonly decision: string | null;
  readonly file: string;
}

interface ParsedJsonlLineV1 {
  readonly file: string;
  readonly line: number;
  readonly value: unknown;
}

interface HookObservationScanV1 {
  readonly lifecycleEvents: readonly LifecycleEventV1[];
  readonly debugEvents: readonly HookDebugRecordV1[];
  readonly tailEvents: readonly HooksTailEventV1[];
  readonly corrupt_lifecycle_lines: number;
  readonly corrupt_debug_lines: number;
  readonly missing_lifecycle_dir: boolean;
  readonly missing_debug_log: boolean;
  readonly lifecycle_files: readonly string[];
}

interface HookDebugRecordV1 {
  readonly ts: string;
  readonly event: string;
  readonly bindingRoute: string | null;
  readonly decision: string | null;
  readonly file: string;
}

function isHooksTestEvent(value: string): value is HooksTestEventV1 {
  return (HOOKS_TEST_EVENTS as readonly string[]).includes(value);
}

function validatorRejected(message: string): Result<never, RuntimeError> {
  return err(runtimeError('E_VALIDATOR_REJECTED', message));
}

export function parseHooksArgv(
  argv: readonly string[],
): Result<ParsedHooksCommandV1, RuntimeError> {
  const tokens = [...argv];
  let kind: ParsedHooksCommandV1['kind'] | undefined;
  if (tokens[0] === 'status' || tokens[0] === 'tail' || tokens[0] === 'test') {
    kind = tokens[0];
    tokens.shift();
  }
  let asJson = false;
  let limit: number | undefined;
  let event: HooksTestEventV1 | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--json') {
      if (asJson) return validatorRejected('duplicate option --json');
      asJson = true;
      continue;
    }
    if (token === '--limit') {
      if (limit !== undefined) return validatorRejected('--limit may appear only once');
      const parsed = parseHooksTailLimit(tokens[index + 1]);
      if (!parsed.ok) return parsed;
      limit = parsed.value;
      index += 1;
      continue;
    }
    if (token === '--event') {
      if (event !== undefined) return validatorRejected('--event may appear only once');
      const raw = tokens[index + 1];
      if (raw === undefined || raw.startsWith('--') || raw.includes('\0')) {
        return validatorRejected('--event must be pre-invocation|stop');
      }
      if (!isHooksTestEvent(raw)) {
        return validatorRejected('--event must be pre-invocation|stop');
      }
      event = raw;
      index += 1;
      continue;
    }
    return validatorRejected(HOOKS_USAGE);
  }
  const resolvedKind = kind ?? 'status';
  if (resolvedKind === 'status') {
    if (limit !== undefined || event !== undefined) return validatorRejected(HOOKS_USAGE);
    return ok({ kind: 'status', asJson });
  }
  if (resolvedKind === 'tail') {
    if (asJson || event !== undefined) return validatorRejected(HOOKS_USAGE);
    return ok({ kind: 'tail', limit: limit ?? HOOKS_TAIL_LIMIT_DEFAULT });
  }
  if (asJson || limit !== undefined) return validatorRejected(HOOKS_USAGE);
  return ok({ kind: 'test', event: event ?? 'pre-invocation' });
}

export function parseHooksTailLimit(raw: string | undefined): Result<number, RuntimeError> {
  if (raw === undefined || raw.startsWith('--') || raw.includes('\0')) {
    return validatorRejected('--limit must be an integer in 1..500');
  }
  if (!/^-?\d+$/u.test(raw)) {
    return validatorRejected('--limit must be an integer in 1..500');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || String(value) !== raw
    || value < HOOKS_TAIL_LIMIT_MIN || value > HOOKS_TAIL_LIMIT_MAX) {
    return validatorRejected('--limit must be an integer in 1..500');
  }
  return ok(value);
}

export function projectHooksObservation(stateRoot: string): HooksObservationProjectionV1 {
  try {
    return projectHooksObservationUnsafe(stateRoot);
  } catch (error) {
    return {
      store_kind: 'oma_hooks_observation',
      schema_version: 1,
      observed: false,
      observation: 'never_observed',
      last_seen_at: null,
      binding_route: null,
      managed_count: 0,
      fail_open_count: 0,
      operator_disabled_count: 0,
      lifecycle_event_count: 0,
      debug_event_count: 0,
      corrupt_lifecycle_lines: 0,
      corrupt_debug_lines: 0,
      missing_lifecycle_dir: true,
      missing_debug_log: true,
      lifecycle_files: [],
      message: `${HOOKS_NEVER_OBSERVED} — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function projectHooksObservationUnsafe(stateRoot: string): HooksObservationProjectionV1 {
  const scan = scanHookObservation(stateRoot);
  const managedCount = scan.lifecycleEvents.filter((event) => event.source === 'antigravity_hook').length;
  const operatorDisabledCount = scan.lifecycleEvents
    .filter((event) => event.source === HOOK_OPERATOR_DISABLED_SOURCE_V1).length;
  const failOpenCount = scan.debugEvents.filter((event) => isFailOpenDebugEvent(event.event)).length;
  const lastSeen = latestTimestamp([
    ...scan.lifecycleEvents.map((event) => event.observed_at),
    ...scan.debugEvents.map((event) => event.ts),
  ]);
  const bindingRoute = latestBindingRoute(scan.debugEvents);
  const observed = scan.lifecycleEvents.length > 0 || scan.debugEvents.length > 0;
  const message = observed
    ? `hooks observed last at ${lastSeen ?? 'unknown'}`
    : `${HOOKS_NEVER_OBSERVED} — compiled PreInvocation/Stop exist on disk but this state root has no hook evidence (fail-open allow is not success)`;
  return {
    store_kind: 'oma_hooks_observation',
    schema_version: 1,
    observed,
    observation: observed ? 'observed' : 'never_observed',
    last_seen_at: lastSeen,
    binding_route: bindingRoute,
    managed_count: managedCount,
    fail_open_count: failOpenCount,
    operator_disabled_count: operatorDisabledCount,
    lifecycle_event_count: scan.lifecycleEvents.length,
    debug_event_count: scan.debugEvents.length,
    corrupt_lifecycle_lines: scan.corrupt_lifecycle_lines,
    corrupt_debug_lines: scan.corrupt_debug_lines,
    missing_lifecycle_dir: scan.missing_lifecycle_dir,
    missing_debug_log: scan.missing_debug_log,
    lifecycle_files: scan.lifecycle_files,
    message,
  };
}

export function listRecentHookEvents(
  stateRoot: string,
  limit: number,
): readonly HooksTailEventV1[] {
  try {
    const bounded = Number.isSafeInteger(limit) ? limit : HOOKS_TAIL_LIMIT_DEFAULT;
    const scan = scanHookObservation(stateRoot);
    if (bounded <= 0) return [];
    return scan.tailEvents.slice(-bounded);
  } catch {
    return [];
  }
}

export function renderHooksStatus(
  projection: Readonly<HooksObservationProjectionV1>,
  format: 'json' | 'text',
): string {
  const redacted = redactHookTree(projection, collectKnownNonces()) as HooksObservationProjectionV1;
  if (format === 'json') return canonicalBytesV1(redacted).toString('utf8');
  const lines = [
    'oma hooks status',
    `observation: ${redacted.observation}`,
    redacted.message,
    `last_seen_at: ${redacted.last_seen_at ?? '-'}`,
    `binding_route: ${redacted.binding_route ?? '-'}`,
    `managed_count: ${redacted.managed_count}`,
    `fail_open_count: ${redacted.fail_open_count}`,
    `lifecycle_event_count: ${redacted.lifecycle_event_count}`,
    `debug_event_count: ${redacted.debug_event_count}`,
  ];
  if (redacted.corrupt_lifecycle_lines > 0 || redacted.corrupt_debug_lines > 0) {
    lines.push(
      `corrupt_lines: lifecycle=${redacted.corrupt_lifecycle_lines} debug=${redacted.corrupt_debug_lines} (skipped)`,
    );
  }
  if (!redacted.observed) {
    lines.push('fail-open allow must not be read as success');
  }
  return lines.join('\n');
}

export function renderHooksTail(events: readonly HooksTailEventV1[]): string {
  const redacted = events.map((event) => redactHookTree(event, collectKnownNonces()) as HooksTailEventV1);
  if (redacted.length === 0) {
    return `${HOOKS_NEVER_OBSERVED} — no hook events in range`;
  }
  return redacted.map((event) => [
    event.at,
    event.channel,
    event.event,
    `source=${event.source}`,
    `binding_route=${event.binding_route ?? '-'}`,
    `decision=${event.decision ?? '-'}`,
    `file=${event.file}`,
  ].join('  ')).join('\n');
}

export function runHooksCommand(
  argv: readonly string[],
  context: Readonly<HooksCommandContext>,
): number {
  const parsed = parseHooksArgv(argv);
  if (!parsed.ok) {
    context.stderr(`${parsed.error.code}: ${parsed.error.message}\n`);
    return 2;
  }
  if (parsed.value.kind === 'test') {
    return runHooksTest(parsed.value.event, context);
  }
  const stateRoot = resolveHooksStateRoot(context);
  if (!stateRoot.ok) {
    context.stderr(`${stateRoot.error.code}: ${stateRoot.error.message}\n`);
    return 1;
  }
  if (parsed.value.kind === 'status') {
    const projection = projectHooksObservation(stateRoot.value);
    const rendered = renderHooksStatus(projection, parsed.value.asJson ? 'json' : 'text');
    context.stdout(`${ensureNotHostNonce(rendered, context.environment)}\n`);
    return 0;
  }
  const events = listRecentHookEvents(stateRoot.value, parsed.value.limit);
  context.stdout(`${ensureNotHostNonce(renderHooksTail(events), context.environment)}\n`);
  return 0;
}

export function defaultHooksSpawnSync(
  command: string,
  argv: readonly string[],
  options: {
    input: string;
    encoding: 'utf8';
    timeout: number;
    maxBuffer: number;
    shell: false;
    windowsHide: true;
    env: NodeJS.ProcessEnv;
    cwd?: string;
  },
): HooksSpawnResultV1 {
  const result = spawnSync(command, [...argv], {
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    shell: false,
    windowsHide: true,
    env: options.env,
    cwd: options.cwd,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function runHooksTest(
  event: HooksTestEventV1,
  context: Readonly<HooksCommandContext>,
): number {
  const disclaimer = hooksTestDisclaimer();
  const hookFile = event === 'pre-invocation' ? 'pre-invocation.js' : 'stop.js';
  const hookPath = path.join(context.packageRoot, 'dist', 'src', 'hooks', hookFile);
  const compiled = resolveCompiledHookPaths(context.packageRoot);
  if (context.spawnSync === undefined && !compiled.ok) {
    context.stderr(`${compiled.error.code}: ${compiled.error.message}\n`);
    context.stdout(`${disclaimer}\n`);
    return 1;
  }
  const stdin = syntheticHookStdin(event);
  const env = isolateHookTestEnv(context.environment);
  const spawn = context.spawnSync ?? defaultHooksSpawnSync;
  const result = spawn(process.execPath, [hookPath], {
    input: stdin,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1_048_576,
    shell: false,
    windowsHide: true,
    env,
    cwd: context.cwd,
  });
  const parsed = parseHookProcessDecision(result.stdout);
  const lines = [
    'oma hooks test',
    `event: ${event}`,
    `entrypoint: ${path.relative(context.packageRoot, hookPath).split(path.sep).join('/')}`,
    `exit: ${result.status ?? 'null'}`,
    `decision: ${parsed.decision}`,
    `injectSteps: ${parsed.injectSteps}`,
    disclaimer,
  ];
  const output = ensureNotHostNonce(lines.join('\n'), context.environment);
  context.stdout(`${output}\n`);
  if (result.error !== undefined || result.status !== 0 || !parsed.ok) {
    if (result.stderr.trim() !== '') {
      context.stderr(`${ensureNotHostNonce(redactDiagnostic(result.stderr), context.environment)}\n`);
    }
    return 1;
  }
  return 0;
}

function hooksTestDisclaimer(): string {
  return [
    HOOKS_TEST_NOT_HOST_PROOF,
    '此結果不是 host 會呼叫 hook 的證據（只驗證本機編譯進入點可執行）。',
  ].join('\n');
}

function syntheticHookStdin(event: HooksTestEventV1): string {
  if (event === 'pre-invocation') {
    return `${JSON.stringify({
      conversationId: 'oma-hooks-test',
      workspacePaths: [],
      invocationNum: 1,
    })}\n`;
  }
  return `${JSON.stringify({
    conversationId: 'oma-hooks-test',
    invocationGeneration: 1,
    executionNum: 1,
    fullyIdle: true,
    terminationReason: 'model_stop',
    workspacePaths: [],
  })}\n`;
}

/** 合成測試不得帶入 binding / debug / kill switch，否則會寫 lifecycle 或洩漏 nonce。 */
function isolateHookTestEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key === 'DISABLE_OMA' || key.startsWith('OMA_')) continue;
    env[key] = value;
  }
  return env;
}

function parseHookProcessDecision(stdout: string): {
  ok: boolean;
  decision: string;
  injectSteps: number;
} {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  const last = lines[lines.length - 1];
  if (last === undefined) return { ok: false, decision: 'unknown', injectSteps: 0 };
  try {
    const parsed = JSON.parse(last) as { decision?: unknown; injectSteps?: unknown };
    const decision = typeof parsed.decision === 'string' && parsed.decision.trim() !== ''
      ? parsed.decision
      : 'unknown';
    const injectSteps = Array.isArray(parsed.injectSteps) ? parsed.injectSteps.length : 0;
    return { ok: decision !== 'unknown', decision, injectSteps };
  } catch {
    return { ok: false, decision: 'unknown', injectSteps: 0 };
  }
}

function resolveHooksStateRoot(
  context: Readonly<HooksCommandContext>,
): Result<string, RuntimeError> {
  if (context.stateRoot !== undefined && context.stateRoot.trim() !== '') {
    return ok(path.resolve(context.stateRoot));
  }
  const resolved = resolveStateRoot({
    env: context.environment,
    homeDirectory: context.environment.HOME ?? os.homedir(),
    create: false,
  });
  if (!resolved.ok) return resolved;
  return ok(resolved.value.path);
}

/** 合併 lifecycle JSONL 與 #46 hook-debug.jsonl；單行損毀跳過，不讓整個 verb crash。 */
function scanHookObservation(stateRoot: string): HookObservationScanV1 {
  const lifecycleDir = path.join(stateRoot, 'lifecycle');
  const debugPath = hookDebugTarget({ OMA_STATE_ROOT: stateRoot } as NodeJS.ProcessEnv)
    ?? path.join(stateRoot, 'logs', 'hook-debug.jsonl');
  const lifecycle = readLifecycleJsonl(lifecycleDir);
  const debug = readDebugJsonl(debugPath);
  const tailEvents = [
    ...lifecycle.events.map((event, index) => lifecycleTailEvent(event, lifecycle.files[index] ?? 'hooks.jsonl')),
    ...debug.events.map((event) => debugTailEvent(event)),
  ].sort(compareTailEvents);
  return {
    lifecycleEvents: lifecycle.events,
    debugEvents: debug.events,
    tailEvents,
    corrupt_lifecycle_lines: lifecycle.corrupt,
    corrupt_debug_lines: debug.corrupt,
    missing_lifecycle_dir: lifecycle.missing,
    missing_debug_log: debug.missing,
    lifecycle_files: lifecycle.names,
  };
}

function readLifecycleJsonl(directory: string): {
  events: LifecycleEventV1[];
  files: string[];
  names: string[];
  corrupt: number;
  missing: boolean;
} {
  const listed = listJsonlFiles(directory);
  if (listed.missing) {
    return { events: [], files: [], names: [], corrupt: 0, missing: true };
  }
  const events: LifecycleEventV1[] = [];
  const files: string[] = [];
  let corrupt = 0;
  for (const file of listed.files) {
    const parsed = readJsonlFile(file);
    corrupt += parsed.corrupt;
    for (const line of parsed.lines) {
      try {
        events.push(validateLifecycleEvent(line.value));
        files.push(path.basename(file));
      } catch {
        corrupt += 1;
      }
    }
  }
  return {
    events,
    files,
    names: listed.files.map((file) => path.basename(file)).sort(compareUtf8),
    corrupt,
    missing: false,
  };
}

function readDebugJsonl(target: string): {
  events: HookDebugRecordV1[];
  corrupt: number;
  missing: boolean;
} {
  if (!fs.existsSync(target)) {
    return { events: [], corrupt: 0, missing: true };
  }
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { events: [], corrupt: 0, missing: true };
    }
  } catch {
    return { events: [], corrupt: 0, missing: true };
  }
  const parsed = readJsonlFile(target);
  const events: HookDebugRecordV1[] = [];
  let corrupt = parsed.corrupt;
  for (const line of parsed.lines) {
    const record = parseDebugRecord(line, path.basename(target));
    if (record === undefined) {
      corrupt += 1;
      continue;
    }
    events.push(record);
  }
  return { events, corrupt, missing: false };
}

function parseDebugRecord(line: ParsedJsonlLineV1, file: string): HookDebugRecordV1 | undefined {
  if (typeof line.value !== 'object' || line.value === null || Array.isArray(line.value)) {
    return undefined;
  }
  const raw = line.value as Record<string, unknown>;
  if (raw.store_kind !== 'hook_debug_event' || raw.schema_version !== 1) return undefined;
  const ts = typeof raw.ts === 'string' ? raw.ts : '';
  const event = typeof raw.event === 'string' ? raw.event : '';
  if (ts === '' || event === '') return undefined;
  const payload = typeof raw.payload === 'object' && raw.payload !== null && !Array.isArray(raw.payload)
    ? raw.payload as Record<string, unknown>
    : {};
  const bindingRoute = readOptionalString(payload.bindingRoute ?? payload.binding_route);
  const decision = readOptionalString(payload.decision);
  return { ts, event, bindingRoute, decision, file };
}

function lifecycleTailEvent(event: LifecycleEventV1, file: string): HooksTailEventV1 {
  return {
    at: event.observed_at,
    channel: 'lifecycle',
    event: event.event_type,
    source: event.source,
    binding_route: null,
    decision: null,
    file,
  };
}

function debugTailEvent(event: HookDebugRecordV1): HooksTailEventV1 {
  return {
    at: event.ts,
    channel: 'hook_debug',
    event: event.event,
    source: 'hook_debug',
    binding_route: event.bindingRoute,
    decision: event.decision,
    file: event.file,
  };
}

function listJsonlFiles(directory: string): { files: string[]; missing: boolean } {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { files: [], missing: true };
    }
  } catch {
    return { files: [], missing: true };
  }
  try {
    const files = fs.readdirSync(directory)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(directory, name))
      .filter((full) => {
        try {
          const stat = fs.lstatSync(full);
          return !stat.isSymbolicLink() && stat.isFile();
        } catch {
          return false;
        }
      })
      .sort(compareUtf8);
    return { files, missing: false };
  } catch {
    return { files: [], missing: true };
  }
}

function readJsonlFile(target: string): { lines: ParsedJsonlLineV1[]; corrupt: number } {
  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return { lines: [], corrupt: 1 };
  }
  const lines: ParsedJsonlLineV1[] = [];
  let corrupt = 0;
  const parts = raw.split(/\r?\n/);
  for (let index = 0; index < parts.length; index += 1) {
    const line = parts[index];
    if (line.trim() === '') continue;
    try {
      lines.push({ file: target, line: index + 1, value: JSON.parse(line) as unknown });
    } catch {
      corrupt += 1;
    }
  }
  return { lines, corrupt };
}

function isFailOpenDebugEvent(event: string): boolean {
  return /fail_open|allow_diagnostic/i.test(event);
}

function latestBindingRoute(events: readonly HookDebugRecordV1[]): string | null {
  const ordered = [...events].sort((left, right) => compareUtf8(left.ts, right.ts));
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const route = ordered[index]?.bindingRoute;
    if (route !== null && route !== undefined && route.trim() !== '') return route;
  }
  return null;
}

function latestTimestamp(values: readonly string[]): string | null {
  const usable = values.filter((value) => value.trim() !== '');
  if (usable.length === 0) return null;
  return usable.reduce((latest, candidate) => (compareUtf8(candidate, latest) > 0 ? candidate : latest));
}

function compareTailEvents(left: HooksTailEventV1, right: HooksTailEventV1): number {
  const time = compareUtf8(left.at, right.at);
  if (time !== 0) return time;
  const file = compareUtf8(left.file, right.file);
  if (file !== 0) return file;
  return compareUtf8(left.event, right.event);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function collectKnownNonces(environment: NodeJS.ProcessEnv = process.env): string[] {
  const values = [environment.OMA_LAUNCH_NONCE, process.env.OMA_LAUNCH_NONCE];
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value !== ''))];
}

function ensureNotHostNonce(text: string, environment: NodeJS.ProcessEnv): string {
  return redactNonceString(text, collectKnownNonces(environment));
}

function redactNonceString(text: string, nonces: readonly string[]): string {
  let output = text;
  for (const nonce of nonces) {
    if (nonce !== '') output = output.split(nonce).join(REDACTED);
  }
  output = output.replace(
    /OMA_LAUNCH_NONCE(?!_FP)\s*[=:]\s*(?!<redacted>)\S+/gi,
    `OMA_LAUNCH_NONCE=${REDACTED}`,
  );
  output = output.replace(
    /"OMA_LAUNCH_NONCE"(?!_FP)(\s*:\s*)"(?:\\.|[^"])*"/g,
    `"OMA_LAUNCH_NONCE"$1"${REDACTED}"`,
  );
  return redactDiagnostic(output);
}

function redactHookTree(value: unknown, nonces: readonly string[]): unknown {
  const redacted = redactValue(redactNonceKeys(value, nonces));
  try {
    return JSON.parse(redactNonceString(JSON.stringify(redacted), nonces)) as unknown;
  } catch {
    return redacted;
  }
}

function redactNonceKeys(value: unknown, nonces: readonly string[]): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? redactNonceString(value, nonces) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactNonceKeys(entry, nonces));
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/OMA_LAUNCH_NONCE(?!_FP)/i.test(key) || /launch_nonce(?!_fp)/i.test(key)) {
      output[key] = REDACTED;
    } else {
      output[key] = redactNonceKeys(child, nonces);
    }
  }
  return output;
}
