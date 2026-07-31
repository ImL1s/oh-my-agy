import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import {
  AntigravityNativeReceiptV1,
  validateAntigravityNativeReceipt,
} from '../contracts/carrier';
import { assertSafeArgvVector, canonicalBytesV1 } from '../contracts/state-schemas';
import { RuntimeError, runtimeError } from './errors';
import { redactDiagnostic } from './redaction';
import { OperationIdentity, ProcessIdentity, Result, err, ok } from './types';

export interface ProcessOutcome {
  code: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** true when maxOutputBytes 被超過並觸發 kill */
  outputOverflow?: boolean;
  /** true when maxProcessCount 被超過並觸發 kill */
  processCountOverflow?: boolean;
  stdout: string;
  stderr: string;
  processIdentity: ProcessIdentity | null;
  launchReceipt?: PinnedProcessLaunchReceiptV1;
}

export interface PinnedProcessLaunchPolicyV1 {
  expectedBinarySha256: string;
  expectedArgv: readonly string[];
  nativeReceipt: AntigravityNativeReceiptV1;
  observedAt: string;
}

export interface PinnedProcessLaunchReceiptV1 {
  store_kind: 'pinned_process_launch_receipt';
  schema_version: 1;
  repository_id: 'OMA';
  provider: AntigravityNativeReceiptV1['provider'];
  run_id: string;
  task_id: string;
  generation: number;
  native_receipt_hash: string;
  binary_sha256: string;
  argv_sha256: string;
  argv_evidence: string[];
  observed_at: string;
}

export type SpawnLifecycleCallback = (
  identity: Readonly<ProcessIdentity>,
) => void | Result<void, RuntimeError>;

export interface HeadlessPolicy {
  deadlineMs: number;
  terminationGraceMs?: number;
  maxOutputBytes?: number;
  /** 程序組內最大程序數（含 root）；超過則 SIGTERM/SIGKILL。Linux 量測最準。 */
  maxProcessCount?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onSpawn?: SpawnLifecycleCallback;
  onExit?: (outcome: Readonly<ProcessOutcome>) => void;
  pinnedLaunch?: PinnedProcessLaunchPolicyV1;
}

export interface InteractivePolicy {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onSpawn?: SpawnLifecycleCallback;
  onExit?: (outcome: Readonly<ProcessOutcome>) => void;
  pinnedLaunch?: PinnedProcessLaunchPolicyV1;
}

export interface ProcessRunnerOptions {
  readIdentity?: (pid: number, operation: Readonly<OperationIdentity>) => ProcessIdentity | null;
  proveIdentity?: (
    observed: Readonly<ProcessIdentity>,
    operation: Readonly<OperationIdentity>,
  ) => boolean;
}

export class ProcessRunner {
  private readonly readIdentity: NonNullable<ProcessRunnerOptions['readIdentity']>;
  private readonly proveIdentity: NonNullable<ProcessRunnerOptions['proveIdentity']>;

  constructor(options: ProcessRunnerOptions = {}) {
    this.readIdentity = options.readIdentity ?? defaultReadIdentity;
    this.proveIdentity = options.proveIdentity ?? defaultProveIdentity;
  }

  foregroundInteractive(
    command: string,
    argv: readonly string[],
    identity: Readonly<OperationIdentity>,
    policy: InteractivePolicy = {},
  ): Promise<Result<ProcessOutcome, RuntimeError>> {
    const launchReceipt = policy.pinnedLaunch === undefined
      ? ok<PinnedProcessLaunchReceiptV1 | undefined>(undefined)
      : createPinnedProcessLaunchReceipt(command, argv, policy.pinnedLaunch, policy.env);
    if (!launchReceipt.ok) return Promise.resolve(launchReceipt);
    return new Promise((resolve) => {
      const child = spawn(command, [...argv], {
        cwd: policy.cwd,
        env: policy.env ?? process.env,
        detached: false,
        stdio: 'inherit',
      });
      const observed = child.pid === undefined ? null : this.readIdentity(child.pid, identity);
      let lifecycleError: RuntimeError | undefined;
      let settled = false;
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        resolve(err(runtimeError('E_RETRYABLE_BLOCKER', 'Interactive process failed to spawn', {
          command,
          cause: error.message,
        })));
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        const outcome: ProcessOutcome = {
          code: code ?? signalExitCode(signal),
          signal,
          timedOut: false,
          stdout: '',
          stderr: '',
          processIdentity: observed,
          launchReceipt: launchReceipt.value,
        };
        try {
          policy.onExit?.(outcome);
        } catch (error) {
          lifecycleError ??= lifecycleCallbackError('onExit', error);
        }
        resolve(lifecycleError === undefined ? ok(outcome) : err(lifecycleError));
      });
      lifecycleError = invokeSpawnCallback(policy.onSpawn, observed);
      if (lifecycleError !== undefined && observed !== null && this.proveIdentity(observed, identity)) {
        try { child.kill('SIGTERM'); } catch (_) {}
      }
    });
  }

  boundedHeadless(
    command: string,
    argv: readonly string[],
    policy: Readonly<HeadlessPolicy>,
    identity: Readonly<OperationIdentity>,
  ): Promise<Result<ProcessOutcome, RuntimeError>> {
    const launchReceipt = policy.pinnedLaunch === undefined
      ? ok<PinnedProcessLaunchReceiptV1 | undefined>(undefined)
      : createPinnedProcessLaunchReceipt(command, argv, policy.pinnedLaunch, policy.env);
    if (!launchReceipt.ok) return Promise.resolve(launchReceipt);
    return new Promise((resolve) => {
      const detached = process.platform !== 'win32';
      const child = spawn(command, [...argv], {
        cwd: policy.cwd,
        env: policy.env ?? process.env,
        detached,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const maxOutputBytes = policy.maxOutputBytes ?? 1024 * 1024;
      const maxProcessCount = policy.maxProcessCount;
      const observed = child.pid === undefined ? null : this.readIdentity(child.pid, identity);
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let timedOut = false;
      let outputOverflow = false;
      let processCountOverflow = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let deadlineTimer: NodeJS.Timeout | undefined;
      let processCountTimer: NodeJS.Timeout | undefined;
      let forceSettleTimer: NodeJS.Timeout | undefined;
      let lifecycleError: RuntimeError | undefined;

      const killOwned = (signal: NodeJS.Signals) => {
        if (child.pid === undefined || observed === null || !this.proveIdentity(observed, identity)) return;
        try {
          if (detached) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (_) { /* best-effort */ }
      };

      const forceSettle = () => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (forceSettleTimer !== undefined) clearTimeout(forceSettleTimer);
        if (processCountTimer !== undefined) clearInterval(processCountTimer);
        // A surviving grandchild (agy spawns its own workers) can hold the
        // inherited stdout/stderr pipe open, so the child's 'close' never fires
        // even after SIGKILL. Detach our readers so the bounded outcome is
        // returned instead of hanging past the deadline; the process group has
        // already been signalled.
        try { child.stdout?.destroy(); } catch (_) { /* best-effort */ }
        try { child.stderr?.destroy(); } catch (_) { /* best-effort */ }
        const outcome: ProcessOutcome = {
          code: signalExitCode('SIGKILL'),
          signal: 'SIGKILL',
          timedOut,
          outputOverflow,
          processCountOverflow,
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          processIdentity: observed,
          launchReceipt: launchReceipt.value,
        };
        try {
          policy.onExit?.(outcome);
        } catch (error) {
          lifecycleError ??= lifecycleCallbackError('onExit', error);
        }
        resolve(lifecycleError === undefined ? ok(outcome) : err(lifecycleError));
      };

      const triggerKill = (reason: 'output' | 'processCount' | 'deadline') => {
        if (reason === 'output') outputOverflow = true;
        if (reason === 'processCount') processCountOverflow = true;
        if (reason === 'deadline') timedOut = true;
        killOwned('SIGTERM');
        if (killTimer !== undefined) clearTimeout(killTimer);
        const graceMs = policy.terminationGraceMs ?? 500;
        killTimer = setTimeout(() => {
          killOwned('SIGKILL');
        }, graceMs);
        // Hard backstop: if 'close' has not fired a further grace period after
        // SIGKILL (a grandchild is holding the pipe open), settle anyway.
        if (forceSettleTimer !== undefined) clearTimeout(forceSettleTimer);
        forceSettleTimer = setTimeout(forceSettle, graceMs * 2 + 1_000);
      };

      const append = (current: Buffer, chunk: Buffer): Buffer => {
        if (outputOverflow) return current;
        if (current.length + chunk.length > maxOutputBytes) {
          const remaining = Math.max(0, maxOutputBytes - current.length);
          const next = remaining === 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]);
          triggerKill('output');
          return next;
        }
        return Buffer.concat([current, chunk]);
      };
      child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (forceSettleTimer !== undefined) clearTimeout(forceSettleTimer);
        if (processCountTimer !== undefined) clearInterval(processCountTimer);
        resolve(err(runtimeError('E_RETRYABLE_BLOCKER', 'Headless process failed to spawn', {
          command,
          cause: error.message,
        })));
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (forceSettleTimer !== undefined) clearTimeout(forceSettleTimer);
        if (processCountTimer !== undefined) clearInterval(processCountTimer);
        const outcome: ProcessOutcome = {
          code: code ?? signalExitCode(signal),
          signal,
          timedOut,
          outputOverflow,
          processCountOverflow,
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          processIdentity: observed,
          launchReceipt: launchReceipt.value,
        };
        try {
          policy.onExit?.(outcome);
        } catch (error) {
          lifecycleError ??= lifecycleCallbackError('onExit', error);
        }
        resolve(lifecycleError === undefined ? ok(outcome) : err(lifecycleError));
      });

      deadlineTimer = setTimeout(() => {
        if (settled) return;
        if (child.pid === undefined || observed === null || !this.proveIdentity(observed, identity)) {
          settled = true;
          resolve(err(runtimeError(
            'E_PROCESS_IDENTITY_UNPROVEN',
            'Deadline elapsed, but process ownership could not be proven; no group kill was attempted',
            { pid: child.pid },
          )));
          return;
        }
        triggerKill('deadline');
      }, policy.deadlineMs);

      if (maxProcessCount !== undefined && maxProcessCount > 0 && child.pid !== undefined) {
        processCountTimer = setInterval(() => {
          if (settled || processCountOverflow) return;
          const count = countProcessGroup(child.pid!, maxProcessCount);
          if (count !== null && count > maxProcessCount) {
            triggerKill('processCount');
          }
        }, 100);
      }

      lifecycleError = invokeSpawnCallback(policy.onSpawn, observed);
      if (lifecycleError !== undefined && child.pid !== undefined
        && observed !== null && this.proveIdentity(observed, identity)) {
        killOwned('SIGTERM');
      }
    });
  }
}

/** Validate exact direct argv and binary bytes before any child is spawned. */
export function createPinnedProcessLaunchReceipt(
  command: string,
  argv: readonly string[],
  policy: Readonly<PinnedProcessLaunchPolicyV1>,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): Result<PinnedProcessLaunchReceiptV1, RuntimeError> {
  try {
    validateAntigravityNativeReceipt(policy.nativeReceipt);
    assertSafeArgvVector([command, ...argv], 'pinned process argv');
    if (!/^[0-9a-f]{64}$/.test(policy.expectedBinarySha256)
      || argv.length !== policy.expectedArgv.length
      || argv.some((value, index) => value !== policy.expectedArgv[index])) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'Pinned process argv or binary digest is not exact'));
    }
    const observed = new Date(policy.observedAt);
    if (!Number.isFinite(observed.getTime()) || observed.toISOString() !== policy.observedAt) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'Pinned process receipt time is not canonical UTC'));
    }
    const executable = resolveExecutable(command, env);
    if (executable === null) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'Pinned process executable is unavailable'));
    }
    const binarySha256 = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
    if (binarySha256 !== policy.expectedBinarySha256) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'Pinned process executable digest changed', {
        expectedBinarySha256: policy.expectedBinarySha256,
        actualBinarySha256: binarySha256,
      }));
    }
    return ok({
      store_kind: 'pinned_process_launch_receipt',
      schema_version: 1,
      repository_id: 'OMA',
      provider: policy.nativeReceipt.provider,
      run_id: policy.nativeReceipt.run_id,
      task_id: policy.nativeReceipt.task_id,
      generation: policy.nativeReceipt.generation,
      native_receipt_hash: policy.nativeReceipt.receipt_hash,
      binary_sha256: binarySha256,
      argv_sha256: crypto.createHash('sha256').update(canonicalBytesV1([command, ...argv])).digest('hex'),
      argv_evidence: [path.basename(command), ...argv.map(redactedArgvEvidence)],
      observed_at: policy.observedAt,
    });
  } catch (error) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'Pinned process launch receipt is invalid', {
      cause: redactDiagnostic(error instanceof Error ? error.message : String(error)),
    }));
  }
}

function resolveExecutable(command: string, env: Readonly<NodeJS.ProcessEnv>): string | null {
  const candidates = command.includes(path.sep)
    ? [path.resolve(command)]
    : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const real = fs.realpathSync(candidate);
      if (fs.statSync(real).isFile()) return real;
    } catch { /* inspect the next PATH entry */ }
  }
  return null;
}

function redactedArgvEvidence(value: string): string {
  if (/^--?[A-Za-z0-9][A-Za-z0-9_-]*(?:=[A-Za-z0-9_.-]+)?$/.test(value)) {
    return value.includes('=') ? `${value.slice(0, value.indexOf('=') + 1)}<redacted>` : value;
  }
  const digest = crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex').slice(0, 12);
  return `<arg:${digest}>`;
}

/** 計算 pid 及其子孫數量；超過 policy 上限後立即停止列舉。失敗回 null。 */
export function countProcessGroup(rootPid: number, stopAfter = Number.MAX_SAFE_INTEGER): number | null {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0
    || !Number.isSafeInteger(stopAfter) || stopAfter <= 0) return null;
  if (process.platform === 'win32') return countWindowsProcessTree(rootPid, stopAfter);
  try {
    const seen = new Set<number>();
    const queue = [rootPid];
    while (queue.length > 0) {
      const pid = queue.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (seen.size > stopAfter) return seen.size;
      const listed = spawnSync('pgrep', ['-P', String(pid)], {
        encoding: 'utf8',
        timeout: 1_000,
        maxBuffer: 64 * 1024,
      });
      if (listed.error !== undefined) return null;
      if (listed.status !== 0 && listed.status !== 1) return null;
      const children = listed.stdout.trim() === ''
        ? []
        : listed.stdout.trim().split('\n').map((line) => Number(line)).filter((n) => Number.isFinite(n));
      for (const child of children) queue.push(child);
    }
    return seen.size;
  } catch (_) {
    return null;
  }
}

function countWindowsProcessTree(rootPid: number, stopAfter: number): number | null {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$rows = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId',
    '$seen = New-Object "System.Collections.Generic.HashSet[int]"',
    '$queue = New-Object "System.Collections.Generic.Queue[int]"',
    `$queue.Enqueue(${rootPid})`,
    `while ($queue.Count -gt 0 -and $seen.Count -le ${stopAfter}) {`,
    '  $pidValue = $queue.Dequeue()',
    '  if (-not $seen.Add($pidValue)) { continue }',
    '  foreach ($row in $rows) { if ($row.ParentProcessId -eq $pidValue) { $queue.Enqueue([int]$row.ProcessId) } }',
    '}',
    '[Console]::Out.Write($seen.Count)',
  ].join('; ');
  for (const command of ['powershell.exe', 'pwsh.exe']) {
    const result = spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0) continue;
    const count = Number(result.stdout.trim());
    if (Number.isSafeInteger(count) && count > 0) return count;
  }
  return null;
}

function invokeSpawnCallback(
  callback: SpawnLifecycleCallback | undefined,
  identity: ProcessIdentity | null,
): RuntimeError | undefined {
  if (callback === undefined || identity === null) return undefined;
  try {
    const result = callback(identity);
    return result !== undefined && !result.ok ? result.error : undefined;
  } catch (error) {
    return lifecycleCallbackError('onSpawn', error);
  }
}

function lifecycleCallbackError(phase: 'onSpawn' | 'onExit', error: unknown): RuntimeError {
  return runtimeError('E_RETRYABLE_BLOCKER', `Process lifecycle ${phase} callback failed`, {
    cause: redactDiagnostic(error instanceof Error ? error.message : String(error)),
  });
}

const CURRENT_PROCESS_FALLBACK_START = `${process.pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`;

/** Returns the strongest locally reproducible identity available for a process. */
export function readProcessIdentity(pid: number, ownerNonce?: string): ProcessIdentity | null {
  const result = spawnSync('ps', ['-o', 'lstart=', '-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0 || result.stdout.trim() === '') {
    if (pid !== process.pid) return null;
    return { pid, startMarker: CURRENT_PROCESS_FALLBACK_START, parentPid: process.ppid, ownerNonce };
  }
  const output = result.stdout.trim();
  const match = output.match(/^(.*\d{4})\s+(\d+)$/);
  return {
    pid,
    startMarker: match?.[1]?.trim() ?? output,
    parentPid: match === null ? undefined : Number(match[2]),
    ownerNonce,
  };
}

export function currentProcessIdentity(ownerNonce?: string): ProcessIdentity {
  return readProcessIdentity(process.pid, ownerNonce) ?? {
    pid: process.pid,
    startMarker: CURRENT_PROCESS_FALLBACK_START,
    parentPid: process.ppid,
    ownerNonce,
  };
}

function defaultReadIdentity(pid: number, operation: Readonly<OperationIdentity>): ProcessIdentity | null {
  return readProcessIdentity(pid, operation.ownerNonce);
}

function defaultProveIdentity(
  observed: Readonly<ProcessIdentity>,
  operation: Readonly<OperationIdentity>,
): boolean {
  if (observed.ownerNonce !== operation.ownerNonce || observed.parentPid !== process.pid) return false;
  const current = defaultReadIdentity(observed.pid, operation);
  return current !== null && current.startMarker === observed.startMarker && current.parentPid === observed.parentPid;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return 128 + (numbers[signal] ?? 1);
}
