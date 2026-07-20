import * as fs from 'fs';
import { StateStore } from '../../src/runtime/state-store';
import { createStateFixture } from '../helpers/state-fixture';

describe('StateStore<T> contract', () => {
  test('create/read/CAS is revisioned and rejects stale writers', async () => {
    const fixture = createStateFixture('oma-store-');
    const store = new StateStore<{ count: number }>(fixture.root);
    try {
      const created = await store.create('counters/main', { count: 0 });
      expect(created).toEqual({
        ok: true,
        value: { schemaVersion: 1, revision: 0, value: { count: 0 } },
      });

      const updated = await store.compareAndSwap('counters/main', 0, (value) => ({
        count: value.count + 1,
      }));
      expect(updated).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ revision: 1, value: { count: 1 } }),
      }));

      const stale = await store.compareAndSwap('counters/main', 0, () => ({ count: 9 }));
      expect(stale).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'E_REVISION_CONFLICT' }),
      }));
      expect(store.read('counters/main')).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ revision: 1, value: { count: 1 } }),
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test('corrupt and future schemas are typed failures and path escapes are rejected', () => {
    const fixture = createStateFixture('oma-store-errors-');
    const store = new StateStore<unknown>(fixture.root);
    try {
      fs.writeFileSync(fixture.path('corrupt.json'), '{');
      fs.writeFileSync(fixture.path('future.json'), JSON.stringify({
        schemaVersion: 2,
        revision: 0,
        value: null,
      }));
      expect(store.read('corrupt')).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'E_CORRUPT_STATE' }),
      }));
      expect(store.read('future')).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'E_FUTURE_SCHEMA' }),
      }));
      expect(store.read('../escape')).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'E_PATH_OUTSIDE_ROOT' }),
      }));
    } finally {
      fixture.cleanup();
    }
  });
});

