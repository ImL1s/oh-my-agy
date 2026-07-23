import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { collectHudSnapshot, HudQueryV1, HudSnapshotV1 } from './status';

export interface HudWatchOptionsV1 {
  interval_ms?: number;
  max_iterations?: number;
  signal?: AbortSignal;
  now?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  on_snapshot: (snapshot: Readonly<HudSnapshotV1>, iteration: number) => void | Promise<void>;
}

export interface HudWatchResultV1 {
  iterations: number;
  stopped_by: 'max_iterations' | 'aborted';
}

export async function watchHud(
  query: Readonly<HudQueryV1>,
  options: Readonly<HudWatchOptionsV1>,
): Promise<Result<HudWatchResultV1, RuntimeError>> {
  const intervalMs = options.interval_ms ?? 1000;
  const maximum = options.max_iterations ?? 10_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 60_000
    || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10_000) {
    return err(runtimeError('E_CORRUPT_STATE', 'HUD watch bounds are invalid'));
  }
  const sleep = options.sleep ?? boundedSleep;
  let iterations = 0;
  while (iterations < maximum) {
    if (options.signal?.aborted === true) return ok({ iterations, stopped_by: 'aborted' });
    const snapshot = collectHudSnapshot({
      ...query,
      collected_at: options.now?.() ?? new Date().toISOString(),
    });
    if (!snapshot.ok) return snapshot;
    iterations += 1;
    try {
      await options.on_snapshot(snapshot.value, iterations);
    } catch (error) {
      return err(runtimeError('E_RETRYABLE_BLOCKER', 'HUD watch sink failed', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
    if (iterations >= maximum) break;
    try {
      await sleep(intervalMs, options.signal);
    } catch (error) {
      if (isAborted(options.signal)) return ok({ iterations, stopped_by: 'aborted' });
      return err(runtimeError('E_RETRYABLE_BLOCKER', 'HUD watch wait failed', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return ok({ iterations, stopped_by: 'max_iterations' });
}

function boundedSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      if (signal !== undefined) signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    if (signal === undefined) return;
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('aborted'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
