import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { RuntimeError, runtimeError } from './errors';
import { Clock, Result, SYSTEM_CLOCK, err, ok } from './types';

export interface LockOwnerRecordV1 {
  schemaVersion: 1;
  ownerToken: string;
  pid: number;
  pidStartMarker: string;
  createdAtMs: number;
}

export interface LockHandle extends LockOwnerRecordV1 {
  lockPath: string;
}

export type ProcessLiveness = 'alive' | 'dead' | 'unknown';

export interface OwnerLockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  staleAfterMs?: number;
  clock?: Clock;
  tokenFactory?: () => string;
  processLiveness?: (owner: Readonly<LockOwnerRecordV1>) => ProcessLiveness;
}

function readStartMarker(pid: number): string {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim() !== '') return result.stdout.trim();
  // A fallback is useful only to create the local record. Other processes that
  // cannot independently reproduce it treat liveness as unknown and never reap.
  return pid === process.pid
    ? `${process.pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`
    : '';
}

export function defaultProcessLiveness(owner: Readonly<LockOwnerRecordV1>): ProcessLiveness {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    return 'unknown';
  }

  const marker = readStartMarker(owner.pid);
  if (marker === '') return 'unknown';
  return marker === owner.pidStartMarker ? 'alive' : 'dead';
}

function readOwner(lockPath: string): Result<LockOwnerRecordV1> {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as Partial<LockOwnerRecordV1>;
    if (
      value.schemaVersion !== 1
      || typeof value.ownerToken !== 'string'
      || !Number.isInteger(value.pid)
      || typeof value.pidStartMarker !== 'string'
      || typeof value.createdAtMs !== 'number'
    ) {
      return err(runtimeError('E_CORRUPT_STATE', 'Lock owner record is invalid', { lockPath }));
    }
    return ok(value as LockOwnerRecordV1);
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'Lock owner record cannot be read', {
      lockPath,
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function tryReapDeadLock(
  lockPath: string,
  owner: LockOwnerRecordV1,
  tokenFactory: () => string,
): boolean {
  const quarantine = `${lockPath}.reap-${tokenFactory()}`;
  try {
    fs.renameSync(lockPath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }

  const quarantinedOwner = readOwner(quarantine);
  if (!quarantinedOwner.ok || quarantinedOwner.value.ownerToken !== owner.ownerToken) {
    try {
      if (!fs.existsSync(lockPath)) fs.renameSync(quarantine, lockPath);
    } catch (_) {}
    return false;
  }
  fs.rmSync(quarantine, { recursive: true, force: true });
  return true;
}

export async function acquireOwnerLock(
  lockPath: string,
  options: OwnerLockOptions = {},
): Promise<Result<LockHandle, RuntimeError>> {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  const tokenFactory = options.tokenFactory ?? (() => crypto.randomBytes(16).toString('hex'));
  const liveness = options.processLiveness ?? defaultProcessLiveness;
  const startedAt = clock.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  while (clock.now() - startedAt <= timeoutMs) {
    const ownerToken = tokenFactory();
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      const owner: LockOwnerRecordV1 = {
        schemaVersion: 1,
        ownerToken,
        pid: process.pid,
        pidStartMarker: readStartMarker(process.pid),
        createdAtMs: clock.now(),
      };
      fs.writeFileSync(
        path.join(lockPath, 'owner.json'),
        `${JSON.stringify(owner)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      return ok({ ...owner, lockPath });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch (_) {}
        return err(runtimeError('E_CORRUPT_STATE', 'Unable to create owner lock', {
          lockPath,
          cause: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    const existing = readOwner(lockPath);
    if (existing.ok) {
      const stale = clock.now() - existing.value.createdAtMs > staleAfterMs;
      if (stale && liveness(existing.value) === 'dead') {
        if (tryReapDeadLock(lockPath, existing.value, tokenFactory)) continue;
      }
    }
    await sleep(retryDelayMs);
  }

  return err(runtimeError('E_LOCK_TIMEOUT', 'Lock acquisition timed out without disturbing its owner', {
    lockPath,
    timeoutMs,
  }));
}

export function releaseOwnerLock(handle: Readonly<LockHandle>): Result<void, RuntimeError> {
  const current = readOwner(handle.lockPath);
  if (!current.ok || current.value.ownerToken !== handle.ownerToken) {
    return err(runtimeError('E_LOCK_NOT_OWNER', 'Lock release rejected because the token does not own the lock', {
      lockPath: handle.lockPath,
    }));
  }

  const quarantine = `${handle.lockPath}.release-${handle.ownerToken}`;
  try {
    fs.renameSync(handle.lockPath, quarantine);
    const moved = readOwner(quarantine);
    if (!moved.ok || moved.value.ownerToken !== handle.ownerToken) {
      if (!fs.existsSync(handle.lockPath)) fs.renameSync(quarantine, handle.lockPath);
      return err(runtimeError('E_LOCK_NOT_OWNER', 'Lock ownership changed during release', {
        lockPath: handle.lockPath,
      }));
    }
    fs.rmSync(quarantine, { recursive: true, force: true });
    return ok(undefined);
  } catch (error) {
    return err(runtimeError('E_LOCK_NOT_OWNER', 'Lock release failed closed', {
      lockPath: handle.lockPath,
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}
