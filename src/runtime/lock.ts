import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { RuntimeError, runtimeError } from './errors';
import { Clock, Result, SYSTEM_CLOCK, err, ok } from './types';
import { atomicWriteContractBytes } from './atomic';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import { safePathKey } from '../contracts/path-key';
import { redactDiagnostic } from './redaction';

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

export const RUNTIME_LEASE_KINDS = [
  'tracker_projector', 'primary_poller', 'hud', 'authority', 'worker',
] as const;
export type RuntimeLeaseKind = typeof RUNTIME_LEASE_KINDS[number];

export interface FencedRuntimeLeaseV1 {
  store_kind: 'runtime_lease';
  schema_version: 1;
  repository_id: 'OMA';
  run_id: string;
  lease_kind: RuntimeLeaseKind;
  pid: number;
  process_start_identity: string;
  owner_token: string;
  generation: number;
  last_successful_poll_at: string | null;
  cursor: string;
  error: string | null;
  acquired_at: string;
  lease_expires_at: string;
}

export function runtimeLeasePath(root: string, runId: string, kind: RuntimeLeaseKind): string {
  return path.join(path.resolve(root), 'leases', safePathKey(runId), `${kind}.json`);
}

/** Successful work heartbeat is authoritative: a live but stalled PID may be replaced. */
export function runtimeLeaseTakeoverEligible(
  lease: Readonly<FencedRuntimeLeaseV1>,
  now: Date,
  stalledAfterMs: number,
): boolean {
  const lastProgress = lease.last_successful_poll_at === null
    ? Date.parse(lease.acquired_at) : Date.parse(lease.last_successful_poll_at);
  return now.getTime() > Date.parse(lease.lease_expires_at)
    || now.getTime() - lastProgress > stalledAfterMs;
}

export class FencedRuntimeLeaseStore {
  readonly leasePath: string;
  private readonly lockTimeoutMs: number;
  private readonly runId: string;
  private readonly kind: RuntimeLeaseKind;

  constructor(root: string, runId: string, kind: RuntimeLeaseKind, lockTimeoutMs = 5_000) {
    this.leasePath = runtimeLeasePath(root, runId, kind);
    this.runId = runId;
    this.kind = kind;
    this.lockTimeoutMs = lockTimeoutMs;
  }

  read(): Result<FencedRuntimeLeaseV1, RuntimeError> {
    if (!fs.existsSync(this.leasePath)) return err(runtimeError('E_NOT_FOUND', 'Runtime lease does not exist'));
    try {
      const lease = JSON.parse(fs.readFileSync(this.leasePath, 'utf8')) as FencedRuntimeLeaseV1;
      validateRuntimeLease(lease);
      if (lease.run_id !== this.runId || lease.lease_kind !== this.kind) {
        throw new Error('Runtime lease path identity does not match its payload');
      }
      return ok(lease);
    } catch (error) {
      return err(runtimeError('E_CORRUPT_STATE', 'Runtime lease is corrupt', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async acquire(
    proposed: Readonly<FencedRuntimeLeaseV1>,
    options: { now: Date; stalledAfterMs: number },
  ): Promise<Result<FencedRuntimeLeaseV1, RuntimeError>> {
    try { validateRuntimeLease(proposed); } catch (error) {
      return err(runtimeError('E_CORRUPT_STATE', 'Proposed runtime lease is invalid', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
    if (proposed.run_id !== this.runId || proposed.lease_kind !== this.kind) {
      return err(runtimeError('E_CORRUPT_STATE', 'Proposed runtime lease path identity differs'));
    }
    const guard = await acquireOwnerLock(`${this.leasePath}.lock`, { timeoutMs: this.lockTimeoutMs });
    if (!guard.ok) return guard;
    try {
      const current = this.read();
      if (current.ok) {
        if (!runtimeLeaseTakeoverEligible(current.value, options.now, options.stalledAfterMs)) {
          return err(runtimeError('E_TRACKER_LEASE_STALLED', 'Lease owner still has a fresh successful heartbeat'));
        }
        if (proposed.generation !== current.value.generation + 1) {
          return err(runtimeError('E_TRACKER_GENERATION_FENCED', 'Lease takeover must increment generation exactly'));
        }
      } else if (current.error.code !== 'E_NOT_FOUND') return current;
      atomicWriteContractBytes(this.leasePath, canonicalBytesV1(proposed));
      return ok({ ...proposed });
    } finally {
      releaseOwnerLock(guard.value);
    }
  }

  async refresh(input: {
    ownerToken: string;
    generation: number;
    successfulPollAt: string;
    cursor: string;
    error: string | null;
    expiresAt: string;
  }): Promise<Result<FencedRuntimeLeaseV1, RuntimeError>> {
    const guard = await acquireOwnerLock(`${this.leasePath}.lock`, { timeoutMs: this.lockTimeoutMs });
    if (!guard.ok) return guard;
    try {
      const current = this.read();
      if (!current.ok) return current;
      if (current.value.owner_token !== input.ownerToken || current.value.generation !== input.generation) {
        return err(runtimeError('E_TRACKER_GENERATION_FENCED', 'Lease refresh is not the current owner'));
      }
      const next: FencedRuntimeLeaseV1 = {
        ...current.value,
        last_successful_poll_at: input.successfulPollAt,
        cursor: input.cursor,
        error: input.error === null ? null : redactDiagnostic(input.error),
        lease_expires_at: input.expiresAt,
      };
      try { validateRuntimeLease(next); } catch (error) {
        return err(runtimeError('E_CORRUPT_STATE', 'Refreshed lease is invalid', {
          cause: error instanceof Error ? error.message : String(error),
        }));
      }
      atomicWriteContractBytes(this.leasePath, canonicalBytesV1(next));
      return ok(next);
    } finally {
      releaseOwnerLock(guard.value);
    }
  }
}

function validateRuntimeLease(lease: FencedRuntimeLeaseV1): void {
  if (lease.store_kind !== 'runtime_lease' || lease.schema_version !== 1
    || lease.repository_id !== 'OMA' || lease.run_id.trim() === ''
    || !RUNTIME_LEASE_KINDS.includes(lease.lease_kind)
    || !Number.isSafeInteger(lease.pid) || lease.pid < 1
    || lease.process_start_identity.trim() === '' || lease.owner_token.trim() === ''
    || !Number.isSafeInteger(lease.generation) || lease.generation < 1
    || lease.cursor.trim() === '') throw new Error('Runtime lease identity is invalid');
  const acquired = Date.parse(lease.acquired_at);
  const expires = Date.parse(lease.lease_expires_at);
  const successful = lease.last_successful_poll_at === null
    ? null : Date.parse(lease.last_successful_poll_at);
  if (!Number.isFinite(acquired) || !Number.isFinite(expires) || expires <= acquired
    || (successful !== null && (!Number.isFinite(successful)
      || successful < acquired || successful > expires))) {
    throw new Error('Runtime lease timestamps are invalid');
  }
  if (lease.error !== null && (lease.error.length > 4096
    || redactDiagnostic(lease.error) !== lease.error)) throw new Error('Runtime lease error is not redacted');
}
