import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ProcessLiveness } from '../runtime/lock';
import { runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { providerCommMatchesAnyBasename } from './provider-readiness';
import { ProcessMarkerV1, TmuxPaneIdentityV1 } from './types';

export interface StartTmuxWorkerInput {
  sessionName: string;
  cwd: string;
  executablePath: string;
  descriptorPath: string;
  bootstrapArgv?: readonly string[];
  ownerNonce: string;
  workerNonce: string;
}

export class TmuxController {
  startWorker(input: Readonly<StartTmuxWorkerInput>): Result<TmuxPaneIdentityV1> {
    if (!validSessionName(input.sessionName) || !validNonce(input.ownerNonce) || !validNonce(input.workerNonce)) {
      return err(runtimeError('E_CORRUPT_STATE', 'Invalid tmux worker identity'));
    }
    const cwd = safeRealpath(input.cwd);
    const executable = safeRealpath(input.executablePath);
    const descriptor = safeRealpath(input.descriptorPath);
    if (cwd === null || executable === null || descriptor === null || !fs.statSync(descriptor).isFile()) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Tmux bootstrap paths must exist and resolve canonically'));
    }
    const bootstrap = input.bootstrapArgv ?? [];
    if (bootstrap.some((entry) => typeof entry !== 'string' || entry.includes('\0') || entry.includes('\n'))) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Tmux bootstrap arguments are invalid'));
    }
    if (this.hasSession(input.sessionName)) {
      return err(runtimeError('E_TMUX_OWNER_MISMATCH', 'Tmux session already exists and is not reusable without owner readback', {
        sessionName: input.sessionName,
      }));
    }
    const shellCommand = [executable, ...bootstrap, descriptor].map(shellQuote).join(' ');
    const created = tmux(['new-session', '-d', '-s', input.sessionName, '-c', cwd, shellCommand]);
    if (!created.ok) return created;
    const pane = tmux(['display-message', '-p', '-t', `${input.sessionName}:0.0`, '#{pane_id}']);
    if (!pane.ok || pane.value.stdout.trim() === '') {
      this.killUnconditionally(input.sessionName);
      return err(runtimeError('E_RETRYABLE_BLOCKER', 'Unable to resolve the tmux worker pane'));
    }
    const paneId = pane.value.stdout.trim();
    const ownerSet = tmux(['set-option', '-t', input.sessionName, '@oma_owner_nonce', input.ownerNonce]);
    const workerSet = tmux(['set-option', '-p', '-t', paneId, '@oma_worker_nonce', input.workerNonce]);
    if (!ownerSet.ok || !workerSet.ok) {
      this.killUnconditionally(input.sessionName);
      return err(runtimeError('E_RETRYABLE_BLOCKER', 'Unable to persist tmux owner options'));
    }
    return ok({
      sessionName: input.sessionName,
      paneId,
      ownerNonce: input.ownerNonce,
      workerNonce: input.workerNonce,
    });
  }

  inspectOwnedPane(sessionName: string): Result<TmuxPaneIdentityV1> {
    if (!validSessionName(sessionName) || !this.hasSession(sessionName)) {
      return err(runtimeError('E_NOT_FOUND', 'Tmux session does not exist', { sessionName }));
    }
    const pane = tmux(['display-message', '-p', '-t', `${sessionName}:0.0`, '#{pane_id}']);
    const owner = tmux(['show-options', '-v', '-t', sessionName, '@oma_owner_nonce']);
    if (!pane.ok || !owner.ok) return err(runtimeError('E_TMUX_OWNER_MISMATCH', 'Tmux owner options cannot be read'));
    const paneId = pane.value.stdout.trim();
    const worker = tmux(['show-options', '-p', '-v', '-t', paneId, '@oma_worker_nonce']);
    if (!worker.ok || owner.value.stdout.trim() === '' || worker.value.stdout.trim() === '') {
      return err(runtimeError('E_TMUX_OWNER_MISMATCH', 'Tmux owner options are missing'));
    }
    return ok({
      sessionName,
      paneId,
      ownerNonce: owner.value.stdout.trim(),
      workerNonce: worker.value.stdout.trim(),
    });
  }

  killOwnedSession(sessionName: string, ownerNonce: string): Result<void> {
    const identity = this.inspectOwnedPane(sessionName);
    if (!identity.ok || identity.value.ownerNonce !== ownerNonce) {
      return err(runtimeError('E_TMUX_OWNER_MISMATCH', 'Refusing to kill a tmux session with a different owner nonce', {
        sessionName,
      }));
    }
    const killed = tmux(['kill-session', '-t', sessionName]);
    return killed.ok ? ok(undefined) : killed;
  }

  hasSession(sessionName: string): boolean {
    return spawnSync('tmux', ['has-session', '-t', sessionName], {
      encoding: 'utf8',
      shell: false,
    }).status === 0;
  }

  private killUnconditionally(sessionName: string): void {
    spawnSync('tmux', ['kill-session', '-t', sessionName], { encoding: 'utf8', shell: false });
  }
}

/** 測試注入點；production 為 `spawnSync(command, argv, { shell: false })`。 */
export interface ArgvSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: { readonly code?: string; readonly message?: string };
}

export type ArgvSpawnFn = (argv: readonly string[]) => ArgvSpawnResult;

export interface ResolveProviderChildOptionsV1 {
  /** 單一期望 comm；與 `expectedBasenames` 聯集。 */
  expectedBasename?: string;
  /**
   * 多個合法 comm（#45 後含 `node`/`oma` worker 與可選路由 `agy`）。
   * 空集合且無 `expectedBasename` 時視為無法證明身分。
   */
  expectedBasenames?: readonly string[];
  tmuxSpawn?: ArgvSpawnFn;
  psSpawn?: ArgvSpawnFn;
}

export interface ProviderProcessIdentityV1 {
  pid: number;
  startMarker: string;
  comm: string;
}

export type ProviderChildResolveStatusV1 = 'matched' | 'orphan' | 'unknown';

export interface ProviderChildResolutionV1 {
  status: ProviderChildResolveStatusV1;
  panePid: number | null;
  pane?: ProviderProcessIdentityV1;
  children: readonly ProviderProcessIdentityV1[];
  matched?: ProviderProcessIdentityV1;
}

/** tmux list-panes 取 #{pane_pid}；永不走 shell 字串。 */
export function tmuxListPanePidArgv(sessionName: string): readonly string[] {
  return ['list-panes', '-t', sessionName, '-F', '#{pane_pid}'];
}

/** ps 行程表：pid/ppid + lstart（PID-reuse-safe）+ comm（basename）。 */
export const PS_PROCESS_TABLE_ARGV: readonly string[] = Object.freeze([
  '-A',
  '-o', 'pid=',
  '-o', 'ppid=',
  '-o', 'lstart=',
  '-o', 'comm=',
]);

const PROVIDER_CHILD_MAX_DEPTH = 8;

/**
 * 以 pane shell 為根，找出相符的 provider 子程序。
 * 設計概念映射：OMG `resolve_provider_child_pid` — pane 活著但沒有
 * basename 相符的子程序不得視為 alive；tmux/ps 失敗回 unknown。
 */
export function resolveProviderChild(
  sessionName: string,
  options: Readonly<ResolveProviderChildOptionsV1> = {},
): ProviderChildResolutionV1 {
  const unknown: ProviderChildResolutionV1 = { status: 'unknown', panePid: null, children: [] };
  if (!validSessionName(sessionName)) return unknown;
  const tmuxSpawn = options.tmuxSpawn ?? defaultTmuxArgvSpawn;
  const psSpawn = options.psSpawn ?? defaultPsArgvSpawn;
  const listed = tmuxSpawn(tmuxListPanePidArgv(sessionName));
  if (isSpawnFailure(listed)) return unknown;
  const panePids = parsePanePids(listed.stdout);
  if (panePids.length === 0) return unknown;
  const table = psSpawn(PS_PROCESS_TABLE_ARGV);
  if (isSpawnFailure(table)) return unknown;
  const rows = parsePsProcessTable(table.stdout);
  if (rows === null) return unknown;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const panePid = panePids[0]!;
  const paneRow = byPid.get(panePid);
  if (paneRow === undefined) {
    return { status: 'unknown', panePid, children: [] };
  }
  const descendants = collectDescendants(rows, panePid, PROVIDER_CHILD_MAX_DEPTH);
  const children: ProviderProcessIdentityV1[] = descendants.map(toIdentity);
  const pane = toIdentity(paneRow);
  const expected = collectExpectedBasenames(options);
  const matched = expected.length === 0
    ? undefined
    : [pane, ...children].find((entry) => providerCommMatchesAnyBasename(entry.comm, expected));
  if (matched !== undefined) {
    return { status: 'matched', panePid, pane, children, matched };
  }
  return { status: 'orphan', panePid, pane, children };
}

function collectExpectedBasenames(options: Readonly<ResolveProviderChildOptionsV1>): string[] {
  const names: string[] = [];
  for (const raw of [...(options.expectedBasenames ?? []), options.expectedBasename ?? '']) {
    const token = raw.trim();
    if (token !== '' && !names.includes(token)) names.push(token);
  }
  return names;
}

/** 只回相符的 provider 子程序；孤兒 pane shell 不得當成 process 身分。 */
export function providerChildProcessMarker(
  resolution: Readonly<ProviderChildResolutionV1>,
): ProcessMarkerV1 | undefined {
  if (resolution.matched === undefined) return undefined;
  return { pid: resolution.matched.pid, startMarker: resolution.matched.startMarker };
}

/**
 * ps 行程表即 liveness 證據（測試注入 fake adapter，禁止對假 PID 做 kill(0)）。
 * 孤兒 pane 或探測失敗皆為 unknown，不得誤判 alive。
 */
export function providerLivenessFromResolution(
  resolution: Readonly<ProviderChildResolutionV1>,
): { readonly providerIdentityMatched: boolean; readonly processLiveness: ProcessLiveness } {
  if (resolution.status === 'matched' && resolution.matched !== undefined) {
    return { providerIdentityMatched: true, processLiveness: 'alive' };
  }
  return { providerIdentityMatched: false, processLiveness: 'unknown' };
}

/**
 * 觀測 pane 內路由執行檔子程序。設計概念映射：OMG `resolve_provider_child_pid`
 * + identity_matched；結果可直接餵 `reconcileWorkerObservation`。
 */
export function observeTmuxWorkerIdentity(
  sessionName: string,
  expectedBasename: string | readonly string[],
  options: Readonly<ResolveProviderChildOptionsV1> = {},
): {
  readonly resolution: ProviderChildResolutionV1;
  readonly providerIdentityMatched: boolean;
  readonly processLiveness: ProcessLiveness;
  readonly process?: ProcessMarkerV1;
} {
  const resolution = resolveProviderChild(sessionName, {
    ...options,
    ...(typeof expectedBasename === 'string'
      ? { expectedBasename }
      : { expectedBasenames: expectedBasename }),
  });
  const liveness = providerLivenessFromResolution(resolution);
  const process = providerChildProcessMarker(resolution);
  return {
    resolution,
    providerIdentityMatched: liveness.providerIdentityMatched,
    processLiveness: liveness.processLiveness,
    ...(process === undefined ? {} : { process }),
  };
}

export function defaultTmuxArgvSpawn(argv: readonly string[]): ArgvSpawnResult {
  return spawnArgv('tmux', argv);
}

export function defaultPsArgvSpawn(argv: readonly string[]): ArgvSpawnResult {
  return spawnArgv('ps', argv);
}

interface TmuxOutput {
  stdout: string;
  stderr: string;
}

function tmux(argv: readonly string[]): Result<TmuxOutput> {
  const result = spawnSync('tmux', [...argv], { encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    return err(runtimeError('E_RETRYABLE_BLOCKER', 'tmux command failed', {
      argv,
      exitCode: result.status,
      stderr: result.stderr,
    }));
  }
  return ok({ stdout: result.stdout, stderr: result.stderr });
}

interface PsProcessRowV1 {
  pid: number;
  ppid: number;
  startMarker: string;
  comm: string;
}

function spawnArgv(command: string, argv: readonly string[]): ArgvSpawnResult {
  try {
    const result = spawnSync(command, [...argv], {
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
    };
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    return {
      status: null,
      stdout: '',
      stderr: error.message ?? String(cause),
      error,
    };
  }
}

function isSpawnFailure(result: ArgvSpawnResult): boolean {
  return result.error?.code === 'ENOENT'
    || result.status === null
    || result.status !== 0;
}

function parsePanePids(stdout: string): number[] {
  const pids: number[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const pid = Number(trimmed);
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * 解析 macOS / Linux `ps -A -o pid=,ppid=,lstart=,comm=`。
 * lstart 含空白（例如 `Mon Aug 24 10:00:00 2026`），comm 取最後欄。
 */
export function parsePsProcessTable(stdout: string): PsProcessRowV1[] | null {
  const rows: PsProcessRowV1[] = [];
  const lines = stdout.split('\n');
  let sawContent = false;
  for (const line of lines) {
    if (line.trim() === '') continue;
    sawContent = true;
    const parsed = parsePsProcessLine(line);
    if (parsed === null) continue;
    rows.push(parsed);
  }
  if (sawContent && rows.length === 0) return null;
  return rows;
}

function parsePsProcessLine(line: string): PsProcessRowV1 | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?\d{4})\s+(\S+)\s*$/.exec(line);
  if (match === null) return null;
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  const startMarker = match[3].trim();
  const comm = match[4];
  if (!Number.isSafeInteger(pid) || pid <= 0
    || !Number.isSafeInteger(ppid) || ppid < 0
    || startMarker === '' || comm === '') {
    return null;
  }
  return { pid, ppid, startMarker, comm };
}

function collectDescendants(
  rows: readonly PsProcessRowV1[],
  rootPid: number,
  maxDepth: number,
): PsProcessRowV1[] {
  const children = new Map<number, PsProcessRowV1[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const found: PsProcessRowV1[] = [];
  const seen = new Set<number>([rootPid]);
  let frontier = [rootPid];
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    const next: number[] = [];
    for (const parent of frontier) {
      for (const child of children.get(parent) ?? []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        found.push(child);
        next.push(child.pid);
      }
    }
    frontier = next;
    depth += 1;
  }
  return found;
}

function toIdentity(row: PsProcessRowV1): ProviderProcessIdentityV1 {
  return { pid: row.pid, startMarker: row.startMarker, comm: row.comm };
}

function validSessionName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

function validNonce(value: string): boolean {
  return value !== '' && !value.includes('\0') && !value.includes('\n');
}

function safeRealpath(target: string): string | null {
  try { return fs.realpathSync(path.resolve(target)); } catch (_) { return null; }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

