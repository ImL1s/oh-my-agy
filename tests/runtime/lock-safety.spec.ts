import * as fs from 'fs';
import {
  acquireOwnerLock,
  releaseOwnerLock,
} from '../../src/runtime/lock';
import { createStateFixture } from '../helpers/state-fixture';

describe('owner-safe lock regression', () => {
  test('a contender or forged handle cannot delete the live owner lock', async () => {
    const fixture = createStateFixture('oma-lock-');
    const lockPath = fixture.path('aggregate.lock');

    try {
      const acquired = await acquireOwnerLock(lockPath, {
        timeoutMs: 100,
        staleAfterMs: 60_000,
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;

      const forged = {
        ...acquired.value,
        ownerToken: 'not-the-owner',
      };
      const forgedRelease = releaseOwnerLock(forged);
      expect(forgedRelease).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'E_LOCK_NOT_OWNER' }),
      }));
      expect(fs.existsSync(lockPath)).toBe(true);

      const contender = await acquireOwnerLock(lockPath, {
        timeoutMs: 25,
        retryDelayMs: 5,
        staleAfterMs: 60_000,
      });
      expect(contender).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'E_LOCK_TIMEOUT' }),
      }));
      expect(fs.existsSync(lockPath)).toBe(true);

      expect(releaseOwnerLock(acquired.value)).toEqual({ ok: true, value: undefined });
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('stale locks are reclaimed only with dead-process proof', async () => {
    const fixture = createStateFixture('oma-lock-reap-');
    const lockPath = fixture.path('aggregate.lock');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(fixture.path('aggregate.lock', 'owner.json'), JSON.stringify({
      schemaVersion: 1,
      ownerToken: 'old-owner',
      pid: 999_999,
      pidStartMarker: 'old-start',
      createdAtMs: 0,
    }));
    let now = 100_000;
    const clock = { now: () => { now += 10; return now; } };

    try {
      const unknown = await acquireOwnerLock(lockPath, {
        timeoutMs: 20,
        retryDelayMs: 0,
        staleAfterMs: 1,
        clock,
        processLiveness: () => 'unknown',
      });
      expect(unknown).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'E_LOCK_TIMEOUT' }),
      }));
      expect(fs.existsSync(lockPath)).toBe(true);

      const reclaimed = await acquireOwnerLock(lockPath, {
        timeoutMs: 100,
        retryDelayMs: 0,
        staleAfterMs: 1,
        clock,
        processLiveness: () => 'dead',
      });
      expect(reclaimed.ok).toBe(true);
      if (reclaimed.ok) expect(releaseOwnerLock(reclaimed.value).ok).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
