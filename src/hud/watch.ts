import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { collectHudSnapshot, HudQueryV1, HudSnapshotV1 } from './status';

/** 設計概念映射：OMC/OMG 有界 watch；interval 過短會空轉、過長會卡住 leader。 */
export const HUD_WATCH_INTERVAL_MS_MIN = 50;
export const HUD_WATCH_INTERVAL_MS_MAX = 60_000;
export const HUD_WATCH_INTERVAL_MS_DEFAULT = 1_000;
export const HUD_WATCH_MAX_ITERATIONS = 10_000;

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
  const intervalMs = options.interval_ms ?? HUD_WATCH_INTERVAL_MS_DEFAULT;
  const maximum = options.max_iterations ?? HUD_WATCH_MAX_ITERATIONS;
  if (!Number.isSafeInteger(intervalMs)
    || intervalMs < HUD_WATCH_INTERVAL_MS_MIN
    || intervalMs > HUD_WATCH_INTERVAL_MS_MAX
    || !Number.isSafeInteger(maximum)
    || maximum < 1
    || maximum > HUD_WATCH_MAX_ITERATIONS) {
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

/** AbortSignal 必須清掉 setTimeout，避免 wait/watch 在 SIGINT 後留下背景計時器。 */
export function boundedSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
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
