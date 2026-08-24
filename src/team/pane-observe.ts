/**
 * 設計概念映射：唯讀 pane 觀測，對齊 OMG `omg team panes|capture|view --print-argv`。
 * 禁止 send-keys / `--raw` / 變更 team state 或 worktree（#28 雙向輸入另案）。
 */
import { spawnSync } from 'child_process';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { redactDiagnostic } from '../runtime/redaction';
import { Result, err, ok } from '../runtime/types';
import { SupervisorHeartbeatV1, TeamAggregateV1 } from './types';

export const DEFAULT_CAPTURE_LINES = 200;
export const MAX_CAPTURE_LINES = 2000;
/** 對齊 OMG `MAX_OPERATOR_CAPTURE_BYTES`；redact 後硬上限。 */
export const MAX_CAPTURE_BYTES = 16_384;

const SESSION_NAME = /^[A-Za-z0-9_.-]+$/;
const PANE_ID = /^%[0-9]{1,16}$/;
const CSI_ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface TmuxSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: { readonly code?: string; readonly message?: string };
}

/** 測試注入點；production 為 `spawnSync('tmux', argv)`，永不走 shell 字串。 */
export type TmuxSpawnFn = (argv: readonly string[]) => TmuxSpawnResult;

export function defaultTmuxSpawn(argv: readonly string[]): TmuxSpawnResult {
  try {
    const result = spawnSync('tmux', [...argv], {
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
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

export function parseCaptureLineCount(raw: string): Result<number, RuntimeError> {
  if (!/^[1-9]\d*$/.test(raw)) {
    return err(runtimeError(
      'E_VALIDATOR_REJECTED',
      'lines must be an integer from 1 to 2000',
    ));
  }
  const lines = Number(raw);
  if (!Number.isSafeInteger(lines) || lines > MAX_CAPTURE_LINES) {
    return err(runtimeError(
      'E_VALIDATOR_REJECTED',
      'lines must be an integer from 1 to 2000',
    ));
  }
  return ok(lines);
}

export function stripAnsi(text: string): string {
  return text.replace(CSI_ANSI, '');
}

export interface CapturePaneInput {
  pane: string;
  sessionName: string;
  expectedOwnerNonce: string;
  lines?: number;
  spawn?: TmuxSpawnFn;
}

export interface CapturePaneView {
  paneId: string;
  sessionName: string;
  lines: number;
  text: string;
}

/**
 * 先回讀 `@oma_owner_nonce`，通過後才 `capture-pane`。
 * argv 固定為 `tmux capture-pane -p -t <pane> -S -<N>`（無 `-J`、無 `--raw`）。
 */
export function capturePane(
  input: Readonly<CapturePaneInput>,
): Result<CapturePaneView, RuntimeError> {
  const lines = input.lines ?? DEFAULT_CAPTURE_LINES;
  const bounded = boundCaptureLines(lines);
  if (!bounded.ok) return bounded;
  const sessionName = requireSessionName(input.sessionName);
  if (!sessionName.ok) return sessionName;
  const pane = requirePaneId(input.pane);
  if (!pane.ok) return pane;
  const spawn = input.spawn ?? defaultTmuxSpawn;
  const proof = proveOwnerNonce(sessionName.value, input.expectedOwnerNonce, spawn);
  if (!proof.ok) return proof;
  if (proof.value === 'absent') {
    return err(runtimeError(
      'E_TMUX_OWNER_MISMATCH',
      'Refusing pane capture without a matching owner nonce',
      { sessionName: sessionName.value },
    ));
  }
  const captured = spawn([
    'capture-pane',
    '-p',
    '-t',
    pane.value,
    '-S',
    `-${bounded.value}`,
  ]);
  if (isTmuxMissing(captured)) return err(tmuxMissingError());
  if (captured.status !== 0) {
    return err(runtimeError('E_RETRYABLE_BLOCKER', 'tmux capture-pane failed', {
      sessionName: sessionName.value,
      paneId: pane.value,
      exitCode: captured.status,
    }));
  }
  const text = redactDiagnostic(stripAnsi(captured.stdout), MAX_CAPTURE_BYTES);
  return ok({
    paneId: pane.value,
    sessionName: sessionName.value,
    lines: bounded.value,
    text,
  });
}

export interface OwnedPaneView {
  taskId: string;
  sessionName: string;
  paneId: string;
}

export interface ListOwnedPanesInput {
  teamId: string;
  aggregate: TeamAggregateV1;
  spawn?: TmuxSpawnFn;
}

/** 盤點本 team 已證明擁有權的 pane；nonce 不符則整次拒絕且不輸出內容。 */
export function listOwnedPanes(
  input: Readonly<ListOwnedPanesInput>,
): Result<readonly OwnedPaneView[], RuntimeError> {
  if (input.aggregate.teamId !== input.teamId) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'Team identifier does not match aggregate'));
  }
  const spawn = input.spawn ?? defaultTmuxSpawn;
  const owned: OwnedPaneView[] = [];
  for (const heartbeat of Object.values(input.aggregate.heartbeats)) {
    const sessionName = sessionNameFromHeartbeat(input.teamId, heartbeat);
    const session = requireSessionName(sessionName);
    if (!session.ok) return session;
    const pane = requirePaneId(heartbeat.paneId);
    if (!pane.ok) continue;
    const proof = proveOwnerNonce(session.value, input.aggregate.ownerNonce, spawn);
    if (!proof.ok) return proof;
    if (proof.value === 'absent') continue;
    const listed = spawn(['list-panes', '-t', session.value, '-F', '#{pane_id}']);
    if (isTmuxMissing(listed)) return err(tmuxMissingError());
    if (listed.status !== 0) continue;
    const live = new Set(
      listed.stdout.split('\n').map((entry) => entry.trim()).filter((entry) => entry !== ''),
    );
    if (!live.has(pane.value)) continue;
    owned.push({
      taskId: heartbeat.workerId,
      sessionName: session.value,
      paneId: pane.value,
    });
  }
  return ok(owned);
}

/**
 * 只組 argv、零 spawn。對齊 OMG `team view --print` / `--print-argv`。
 */
export function printAttachArgv(input: {
  sessionName: string;
  paneId?: string;
}): Result<readonly string[], RuntimeError> {
  const sessionName = requireSessionName(input.sessionName);
  if (!sessionName.ok) return sessionName;
  const argv = ['tmux', 'attach-session', '-t', sessionName.value];
  if (input.paneId !== undefined) {
    const pane = requirePaneId(input.paneId);
    if (!pane.ok) return pane;
    argv.push(';', 'select-pane', '-t', pane.value);
  }
  return ok(argv);
}

export function sessionNameFromHeartbeat(
  teamId: string,
  heartbeat: SupervisorHeartbeatV1,
): string {
  if (heartbeat.process.startMarker.startsWith('tmux:')) {
    return heartbeat.process.startMarker.slice('tmux:'.length);
  }
  return `oma-${teamId}-${heartbeat.workerId}-g1`
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .slice(0, 80);
}

function boundCaptureLines(lines: number): Result<number, RuntimeError> {
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > MAX_CAPTURE_LINES) {
    return err(runtimeError(
      'E_VALIDATOR_REJECTED',
      'lines must be an integer from 1 to 2000',
    ));
  }
  return ok(lines);
}

function requireSessionName(value: string): Result<string, RuntimeError> {
  if (!SESSION_NAME.test(value)) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'Invalid tmux session name', { sessionName: value }));
  }
  return ok(value);
}

function requirePaneId(value: string): Result<string, RuntimeError> {
  if (!PANE_ID.test(value)) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'Invalid tmux pane id', { paneId: value }));
  }
  return ok(value);
}

function validNonce(value: string): boolean {
  return value !== '' && !value.includes('\0') && !value.includes('\n');
}

/**
 * 任何 capture / list-panes 之前的第一個 tmux 呼叫：`show-options @oma_owner_nonce`。
 * 對齊既有 `E_TMUX_OWNER_MISMATCH`（TmuxController.inspectOwnedPane）。
 */
function proveOwnerNonce(
  sessionName: string,
  expectedOwnerNonce: string,
  spawn: TmuxSpawnFn,
): Result<'owned' | 'absent', RuntimeError> {
  if (!validNonce(expectedOwnerNonce)) {
    return err(runtimeError(
      'E_TMUX_OWNER_MISMATCH',
      'Refusing pane observation without a matching owner nonce',
      { sessionName },
    ));
  }
  const readback = spawn(['show-options', '-v', '-t', sessionName, '@oma_owner_nonce']);
  if (isTmuxMissing(readback)) return err(tmuxMissingError());
  if (readback.status !== 0) return ok('absent');
  if (readback.stdout.trim() !== expectedOwnerNonce) {
    return err(runtimeError(
      'E_TMUX_OWNER_MISMATCH',
      'Refusing pane observation for a tmux session with a different owner nonce',
      { sessionName },
    ));
  }
  return ok('owned');
}

function isTmuxMissing(result: TmuxSpawnResult): boolean {
  return result.error?.code === 'ENOENT';
}

function tmuxMissingError(): RuntimeError {
  return runtimeError(
    'E_RETRYABLE_BLOCKER',
    'tmux is not installed or not on PATH; pane observation requires tmux',
  );
}
