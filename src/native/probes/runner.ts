import { spawn } from 'child_process';
import { capturePosixProcessBaselineAsync, countProcessGroupAsync } from '../../runtime/process';
import { BoundedProbeOutcomeV1, BoundedProbeRequestV1 } from './types';

const PROCESS_COUNT_INTERVAL_MS = 100;
const FORCE_SETTLE_AFTER_KILL_MS = 1_000;
const PROCESS_COUNT_SCAN_TIMEOUT_MS = 1_000;

export interface BoundedProbeRunnerDependencies {
  countProcesses?: (rootPid: number, stopAfter: number, timeoutMs: number) => Promise<number | null>;
}

/** 僅接受 argv 的 bounded runner，同時限制輸出、程序數與牆鐘時間。 */
export async function runBoundedProbe(
  request: Readonly<BoundedProbeRequestV1>,
  dependencies: Readonly<BoundedProbeRunnerDependencies> = {},
): Promise<BoundedProbeOutcomeV1> {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0
    || !Number.isSafeInteger(request.maximumOutputBytes) || request.maximumOutputBytes <= 0
    || !Number.isSafeInteger(request.maximumProcesses) || request.maximumProcesses <= 0) {
    return failedLimitsOutcome();
  }
  const deadlineAt = Date.now() + request.timeoutMs;
  const processBaseline = dependencies.countProcesses !== undefined || process.platform === 'win32'
    ? undefined
    : await capturePosixProcessBaselineAsync(Math.min(PROCESS_COUNT_SCAN_TIMEOUT_MS, request.timeoutMs));
  if (dependencies.countProcesses === undefined && process.platform !== 'win32' && processBaseline === null) {
    return failedProcessCountOutcome();
  }
  if (Date.now() >= deadlineAt) {
    return { ...failedProcessCountOutcome(), timedOut: true };
  }
  return new Promise((resolve) => {
    const detached = process.platform !== 'win32';
    const countProcesses = dependencies.countProcesses ?? ((rootPid, stopAfter, timeoutMs) =>
      countProcessGroupAsync(rootPid, stopAfter, timeoutMs, processBaseline ?? undefined));
    const child = spawn(request.command, [...request.argv], {
      cwd: request.cwd,
      env: request.environment ?? process.env,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let total = 0;
    let timedOut = false;
    let outputOverflow = false;
    let processCountOverflow = false;
    let settled = false;
    let terminationRequested = false;
    let processInspectionInFlight = false;
    let pendingSuccessfulClose: { status: number; signal: null } | null = null;
    let error: string | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let processCountTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;

    const settle = (
      status: number | null,
      signal: NodeJS.Signals | null,
      destroyPipes = false,
    ) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (processCountTimer !== undefined) clearInterval(processCountTimer);
      if (forceSettleTimer !== undefined) clearTimeout(forceSettleTimer);
      if (destroyPipes) {
        try { child.stdout.destroy(); } catch (_) { /* bounded cleanup 僅能盡力執行 */ }
        try { child.stderr.destroy(); } catch (_) { /* bounded cleanup 僅能盡力執行 */ }
      }
      resolve({
        status,
        signal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
        outputOverflow,
        processCountOverflow,
        ...(error === undefined ? {} : { error }),
      });
    };

    const terminate = () => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        // Windows 沒有 POSIX process group；taskkill /T 才能界定整棵子程序樹。
        try {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.once('error', () => {
            try { child.kill('SIGKILL'); } catch (_) { /* 程序已結束 */ }
          });
          killer.once('close', (status) => {
            if (status === 0) return;
            try { child.kill('SIGKILL'); } catch (_) { /* 程序已結束 */ }
          });
        } catch (_) {
          try { child.kill('SIGKILL'); } catch (_) { /* 程序已結束 */ }
        }
        return;
      }
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* 程序已結束 */ }
    };

    const terminateAndBoundSettlement = () => {
      if (terminationRequested || settled) return;
      terminationRequested = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (processCountTimer !== undefined) clearInterval(processCountTimer);
      terminate();
      if (pendingSuccessfulClose !== null) {
        settle(null, 'SIGKILL', true);
        return;
      }
      // 子孫可能仍持有 inherited pipes；到達此 backstop 後主動斷開 reader 並回傳。
      forceSettleTimer = setTimeout(
        () => settle(null, 'SIGKILL', true),
        FORCE_SETTLE_AFTER_KILL_MS,
      );
    };

    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (outputOverflow || settled) return;
      const remaining = Math.max(0, request.maximumOutputBytes - total);
      const bounded = chunk.subarray(0, remaining);
      total += bounded.length;
      if (target === 'stdout') stdout = Buffer.concat([stdout, bounded]);
      else stderr = Buffer.concat([stderr, bounded]);
      if (bounded.length < chunk.length) {
        outputOverflow = true;
        terminateAndBoundSettlement();
      }
    };

    const inspectProcessCount = async () => {
      if (settled || terminationRequested || processInspectionInFlight || child.pid === undefined) return;
      processInspectionInFlight = true;
      try {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          timedOut = true;
          terminateAndBoundSettlement();
          return;
        }
        const count = await countProcesses(
          child.pid,
          request.maximumProcesses,
          Math.min(PROCESS_COUNT_SCAN_TIMEOUT_MS, remainingMs),
        );
        if (settled || terminationRequested) return;
        if (count === null) {
          error = 'E_PROBE_PROCESS_COUNT_UNAVAILABLE';
          terminateAndBoundSettlement();
        } else if (count > request.maximumProcesses) {
          processCountOverflow = true;
          terminateAndBoundSettlement();
        }
      } catch (_) {
        if (!settled && !terminationRequested) {
          error = 'E_PROBE_PROCESS_COUNT_UNAVAILABLE';
          terminateAndBoundSettlement();
        }
      } finally {
        processInspectionInFlight = false;
        if (pendingSuccessfulClose !== null && !settled && !terminationRequested) {
          const completed = pendingSuccessfulClose;
          pendingSuccessfulClose = null;
          settle(completed.status, completed.signal);
        }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', (cause) => {
      error = cause.message;
      settle(null, null, true);
    });
    child.once('close', (status, signal) => {
      if (status === 0 && signal === null && !terminationRequested) {
        pendingSuccessfulClose = { status, signal };
        if (processCountTimer !== undefined) clearInterval(processCountTimer);
        if (!processInspectionInFlight) void inspectProcessCount();
        return;
      }
      settle(status, signal);
    });
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateAndBoundSettlement();
    }, Math.max(1, deadlineAt - Date.now()));
    void inspectProcessCount();
    if (!settled) {
      processCountTimer = setInterval(() => { void inspectProcessCount(); }, PROCESS_COUNT_INTERVAL_MS);
    }
  });
}

function failedLimitsOutcome(): BoundedProbeOutcomeV1 {
  return {
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    outputOverflow: false,
    processCountOverflow: false,
    error: 'E_PROBE_INVALID_LIMITS',
  };
}

function failedProcessCountOutcome(): BoundedProbeOutcomeV1 {
  return {
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    outputOverflow: false,
    processCountOverflow: false,
    error: 'E_PROBE_PROCESS_COUNT_UNAVAILABLE',
  };
}
