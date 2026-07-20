/**
 * 設計概念映射：Looks vs Works AuthorityLease（CAS acquire/renew/release）。
 * overlapping write_scope 並行前必須取得 exclusive lease。
 */
import { RuntimeError, runtimeError } from '../runtime/errors';
import { StateStore } from '../runtime/state-store';
import { Result, Snapshot, err, ok } from '../runtime/types';

export interface AuthorityLeaseV1 {
  schemaVersion: 1;
  pathKey: string;
  ownerTaskId: string;
  ownerClaimTokenDigest: string;
  generation: number;
  leasedUntilMs: number;
}

export interface LeaseAggregateV1 {
  schemaVersion: 1;
  teamId: string;
  leases: Readonly<Record<string, AuthorityLeaseV1>>;
}

export class AuthorityLeaseStore {
  readonly key: string;
  private readonly teamId: string;
  private readonly store: StateStore<LeaseAggregateV1>;

  constructor(stateRoot: string, teamId: string) {
    this.teamId = teamId;
    this.key = `teams/${teamId}/authority-leases`;
    this.store = new StateStore<LeaseAggregateV1>(stateRoot);
  }

  async ensure(): Promise<Result<Snapshot<LeaseAggregateV1>, RuntimeError>> {
    const existing = this.store.read(this.key);
    if (existing.ok) return existing;
    return this.store.create(this.key, {
      schemaVersion: 1,
      teamId: this.teamId,
      leases: {},
    });
  }

  async releaseAllForTask(
    ownerTaskId: string,
    expectedRevision: number,
  ): Promise<Result<Snapshot<LeaseAggregateV1>, RuntimeError>> {
    const before = this.store.read(this.key);
    if (!before.ok) return before;
    if (before.value.revision !== expectedRevision) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Lease aggregate revision changed'));
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (agg) => {
      const leases: Record<string, AuthorityLeaseV1> = {};
      for (const [key, lease] of Object.entries(agg.leases)) {
        if (lease.ownerTaskId !== ownerTaskId) leases[key] = lease;
      }
      return { ...agg, leases };
    });
  }

  async acquire(
    pathKey: string,
    ownerTaskId: string,
    ownerClaimTokenDigest: string,
    nowMs: number,
    leaseMs: number,
    expectedRevision: number,
  ): Promise<Result<Snapshot<LeaseAggregateV1>, RuntimeError>> {
    const before = this.store.read(this.key);
    if (!before.ok) return before;
    if (before.value.revision !== expectedRevision) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Lease aggregate revision changed'));
    }
    const current = before.value.value.leases[pathKey];
    if (
      current !== undefined
      && current.leasedUntilMs > nowMs
      && current.ownerTaskId !== ownerTaskId
    ) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Authority lease is held by another task', {
        pathKey,
        ownerTaskId: current.ownerTaskId,
      }));
    }
    const generation = (current?.generation ?? 0) + 1;
    const lease: AuthorityLeaseV1 = {
      schemaVersion: 1,
      pathKey,
      ownerTaskId,
      ownerClaimTokenDigest,
      generation,
      leasedUntilMs: nowMs + leaseMs,
    };
    return this.store.compareAndSwap(this.key, expectedRevision, (agg) => ({
      ...agg,
      leases: { ...agg.leases, [pathKey]: lease },
    }));
  }

  async renew(
    pathKey: string,
    ownerTaskId: string,
    nowMs: number,
    leaseMs: number,
    expectedRevision: number,
  ): Promise<Result<Snapshot<LeaseAggregateV1>, RuntimeError>> {
    const before = this.store.read(this.key);
    if (!before.ok) return before;
    if (before.value.revision !== expectedRevision) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Lease aggregate revision changed'));
    }
    const current = before.value.value.leases[pathKey];
    if (current === undefined || current.ownerTaskId !== ownerTaskId) {
      return err(runtimeError('E_LOCK_NOT_OWNER', 'Cannot renew authority lease without ownership'));
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (agg) => ({
      ...agg,
      leases: {
        ...agg.leases,
        [pathKey]: { ...current, leasedUntilMs: nowMs + leaseMs },
      },
    }));
  }

  async release(
    pathKey: string,
    ownerTaskId: string,
    expectedRevision: number,
  ): Promise<Result<Snapshot<LeaseAggregateV1>, RuntimeError>> {
    const before = this.store.read(this.key);
    if (!before.ok) return before;
    if (before.value.revision !== expectedRevision) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Lease aggregate revision changed'));
    }
    const current = before.value.value.leases[pathKey];
    if (current === undefined || current.ownerTaskId !== ownerTaskId) {
      return err(runtimeError('E_LOCK_NOT_OWNER', 'Cannot release authority lease without ownership'));
    }
    return this.store.compareAndSwap(this.key, expectedRevision, (agg) => {
      const leases = { ...agg.leases };
      delete leases[pathKey];
      return { ...agg, leases };
    });
  }
}

/** overlapping write_scope path keys for lease acquisition */
export function pathKeysFromWriteScope(
  writeScope: 'none' | readonly { kind: string; path: string }[],
): string[] {
  if (writeScope === 'none') return [];
  return writeScope.map((entry) => `${entry.kind}:${entry.path}`);
}

/** true if two scope keys conflict (exact or dir contains file/dir prefix) */
export function writeScopesConflict(
  left: 'none' | readonly { kind: string; path: string }[],
  right: 'none' | readonly { kind: string; path: string }[],
): boolean {
  if (left === 'none' || right === 'none') return false;
  for (const a of left) {
    for (const b of right) {
      if (a.kind === 'file' && b.kind === 'file' && a.path === b.path) return true;
      if (a.kind === 'dir' && b.kind === 'dir' && (a.path === b.path || a.path.startsWith(`${b.path}/`) || b.path.startsWith(`${a.path}/`))) {
        return true;
      }
      if (a.kind === 'dir' && b.kind === 'file' && (b.path === a.path || b.path.startsWith(`${a.path}/`))) return true;
      if (b.kind === 'dir' && a.kind === 'file' && (a.path === b.path || a.path.startsWith(`${b.path}/`))) return true;
    }
  }
  return false;
}
