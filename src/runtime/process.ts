import { spawn, spawnSync } from 'child_process';
import { RuntimeError, runtimeError } from './errors';
import { OperationIdentity, ProcessIdentity, Result, err, ok } from './types';

export interface ProcessOutcome {
  code: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  processIdentity: ProcessIdentity | null;
}

export type SpawnLifecycleCallback = (
  identity: Readonly<ProcessIdentity>,
) => void | Result<void, RuntimeError>;

export interface HeadlessPolicy {
  deadlineMs: number;
  terminationGraceMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onSpawn?: SpawnLifecycleCallback;
  onExit?: (outcome: Readonly<ProcessOutcome>) => void;
}

export interface InteractivePolicy {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onSpawn?: SpawnLifecycleCallback;
  onExit?: (outcome: Readonly<ProcessOutcome>) => void;
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
    return new Promise((resolve) => {
      const detached = process.platform !== 'win32';
      const child = spawn(command, [...argv], {
        cwd: policy.cwd,
        env: policy.env ?? process.env,
        detached,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const maxOutputBytes = policy.maxOutputBytes ?? 1024 * 1024;
      const observed = child.pid === undefined ? null : this.readIdentity(child.pid, identity);
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let deadlineTimer: NodeJS.Timeout | undefined;
      let lifecycleError: RuntimeError | undefined;

      const append = (current: Buffer, chunk: Buffer): Buffer => {
        const remaining = Math.max(0, maxOutputBytes - current.length);
        return remaining === 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]);
      };
      child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
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
        const outcome: ProcessOutcome = {
          code: code ?? signalExitCode(signal),
          signal,
          timedOut,
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          processIdentity: observed,
        };
        try {
          policy.onExit?.(outcome);
        } catch (error) {
          lifecycleError ??= lifecycleCallbackError('onExit', error);
        }
        resolve(lifecycleError === undefined ? ok(outcome) : err(lifecycleError));
      });

      deadlineTimer = setTimeout(() => {
        timedOut = true;
        if (child.pid === undefined || observed === null || !this.proveIdentity(observed, identity)) {
          if (!settled) {
            settled = true;
            resolve(err(runtimeError(
              'E_PROCESS_IDENTITY_UNPROVEN',
              'Deadline elapsed, but process ownership could not be proven; no group kill was attempted',
              { pid: child.pid },
            )));
          }
          return;
        }
        try {
          if (detached) process.kill(-child.pid, 'SIGTERM');
          else child.kill('SIGTERM');
        } catch (_) {}
        killTimer = setTimeout(() => {
          if (!this.proveIdentity(observed, identity)) return;
          try {
            if (detached) process.kill(-child.pid!, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch (_) {}
        }, policy.terminationGraceMs ?? 500);
      }, policy.deadlineMs);
      lifecycleError = invokeSpawnCallback(policy.onSpawn, observed);
      if (lifecycleError !== undefined && child.pid !== undefined
        && observed !== null && this.proveIdentity(observed, identity)) {
        try {
          if (detached) process.kill(-child.pid, 'SIGTERM');
          else child.kill('SIGTERM');
        } catch (_) {}
      }
    });
  }
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
    cause: error instanceof Error ? error.message : String(error),
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
