import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FencedRuntimeLeaseStore,
  FencedRuntimeLeaseV1,
  runtimeLeasePath,
} from '../../src/runtime/lock';

function lease(kind: FencedRuntimeLeaseV1['lease_kind'], generation = 1): FencedRuntimeLeaseV1 {
  return {
    store_kind: 'runtime_lease', schema_version: 1, repository_id: 'OMA', run_id: 'run',
    lease_kind: kind, pid: process.pid, process_start_identity: 'start',
    owner_token: `owner-${generation}`, generation, last_successful_poll_at: '2026-07-22T00:00:01.000Z',
    cursor: 'cursor', error: null, acquired_at: '2026-07-22T00:00:00.000Z',
    lease_expires_at: '2026-07-22T00:01:00.000Z',
  };
}

describe('distinct fenced runtime leases', () => {
  test('poller/HUD/authority paths are separate and stalled heartbeat permits generation+1 takeover', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-leases-'));
    try {
      expect(runtimeLeasePath(root, 'run', 'primary_poller'))
        .not.toBe(runtimeLeasePath(root, 'run', 'hud'));
      const store = new FencedRuntimeLeaseStore(root, 'run', 'primary_poller');
      expect((await store.acquire(lease('primary_poller'), {
        now: new Date('2026-07-22T00:00:02.000Z'), stalledAfterMs: 10_000,
      })).ok).toBe(true);
      const fresh = await store.acquire(lease('primary_poller', 2), {
        now: new Date('2026-07-22T00:00:03.000Z'), stalledAfterMs: 10_000,
      });
      expect(fresh.ok).toBe(false);
      const takeover = await store.acquire(lease('primary_poller', 2), {
        now: new Date('2026-07-22T00:00:20.000Z'), stalledAfterMs: 10_000,
      });
      expect(takeover.ok).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('successful heartbeat cannot be later than its lease expiry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-lease-window-'));
    try {
      const store = new FencedRuntimeLeaseStore(root, 'run', 'primary_poller');
      const result = await store.acquire({ ...lease('primary_poller'),
        last_successful_poll_at: '2026-07-22T00:00:11.000Z',
        lease_expires_at: '2026-07-22T00:00:10.000Z',
      }, { now: new Date('2026-07-22T00:00:00.000Z'), stalledAfterMs: 5_000 });
      expect(result).toEqual(expect.objectContaining({
        ok: false, error: expect.objectContaining({ code: 'E_CORRUPT_STATE' }),
      }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('payload run/kind cannot be written through a different lease path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-lease-path-bind-'));
    try {
      const store = new FencedRuntimeLeaseStore(root, 'run', 'hud');
      const result = await store.acquire(lease('primary_poller'), {
        now: new Date('2026-07-22T00:00:00.000Z'), stalledAfterMs: 5_000,
      });
      expect(result).toEqual(expect.objectContaining({
        ok: false, error: expect.objectContaining({ code: 'E_CORRUPT_STATE' }),
      }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
