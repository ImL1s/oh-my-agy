import { spawn } from 'child_process';
import { BoundedProbeOutcomeV1, BoundedProbeRequestV1 } from './types';

/** Bounded argv-only runner with one combined stdout/stderr byte budget. */
export function runBoundedProbe(request: Readonly<BoundedProbeRequestV1>): Promise<BoundedProbeOutcomeV1> {
  return new Promise((resolve) => {
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
    let settled = false;
    let error: string | undefined;

    const terminate = () => {
      if (child.pid === undefined) return;
      try { detached ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL'); } catch (_) { /* process already exited */ }
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, request.timeoutMs);
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (outputOverflow) return;
      const remaining = Math.max(0, request.maximumOutputBytes - total);
      const bounded = chunk.subarray(0, remaining);
      total += bounded.length;
      if (target === 'stdout') stdout = Buffer.concat([stdout, bounded]);
      else stderr = Buffer.concat([stderr, bounded]);
      if (bounded.length < chunk.length) {
        outputOverflow = true;
        terminate();
      }
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', (cause) => { error = cause.message; });
    child.once('close', (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut, outputOverflow, ...(error === undefined ? {} : { error }) });
    });
  });
}
