import { spawn, spawnSync } from 'child_process';
import { countProcessGroup } from '../../runtime/process';
import { BoundedProbeOutcomeV1, BoundedProbeRequestV1 } from './types';

const PROCESS_COUNT_INTERVAL_MS = 100;
const FORCE_SETTLE_AFTER_KILL_MS = 1_000;

/** 僅接受 argv 的 bounded runner，同時限制輸出、程序數與牆鐘時間。 */
export function runBoundedProbe(request: Readonly<BoundedProbeRequestV1>): Promise<BoundedProbeOutcomeV1> {
  return new Promise((resolve) => {
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0
      || !Number.isSafeInteger(request.maximumOutputBytes) || request.maximumOutputBytes <= 0
      || !Number.isSafeInteger(request.maximumProcesses) || request.maximumProcesses <= 0) {
      resolve(failedLimitsOutcome());
      return;
    }
    const detached = process.platform !== 'win32';
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
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 2_000,
            windowsHide: true,
          });
        } catch (_) { /* 失敗時退回下方 direct-child kill */ }
        try { child.kill('SIGKILL'); } catch (_) { /* 程序已結束 */ }
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

    const inspectProcessCount = () => {
      if (settled || processCountOverflow || child.pid === undefined) return;
      const count = countProcessGroup(child.pid, request.maximumProcesses);
      if (count === null) {
        error = 'E_PROBE_PROCESS_COUNT_UNAVAILABLE';
        terminateAndBoundSettlement();
      } else if (count > request.maximumProcesses) {
        processCountOverflow = true;
        terminateAndBoundSettlement();
      }
    };

    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', (cause) => {
      error = cause.message;
      settle(null, null, true);
    });
    child.once('close', (status, signal) => settle(status, signal));
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateAndBoundSettlement();
    }, request.timeoutMs);
    inspectProcessCount();
    if (!settled) {
      processCountTimer = setInterval(inspectProcessCount, PROCESS_COUNT_INTERVAL_MS);
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
