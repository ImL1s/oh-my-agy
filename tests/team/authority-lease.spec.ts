import * as crypto from 'crypto';
import {
  AuthorityLeaseStore,
  pathKeysFromWriteScope,
  writeScopesConflict,
} from '../../src/team/authority-lease';
import { GitFixture } from '../helpers/git-fixture';

describe('AuthorityLease', () => {
  test('pathKeysFromWriteScope', () => {
    expect(pathKeysFromWriteScope('none')).toEqual([]);
    expect(pathKeysFromWriteScope([{ kind: 'file', path: 'a.ts' }])).toEqual(['file:a.ts']);
  });

  test('writeScopesConflict detects dir/file overlap', () => {
    expect(writeScopesConflict(
      [{ kind: 'dir', path: 'src' }],
      [{ kind: 'file', path: 'src/a.ts' }],
    )).toBe(true);
    expect(writeScopesConflict(
      [{ kind: 'file', path: 'a.ts' }],
      [{ kind: 'file', path: 'b.ts' }],
    )).toBe(false);
  });

  test('acquire exclusive, second holder fails, renew and release', async () => {
    const fixture = GitFixture.create();
    try {
      const store = new AuthorityLeaseStore(fixture.stateRoot, 'team-lease');
      const created = await store.ensure();
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const digestA = crypto.createHash('sha256').update('a').digest('hex');
      const digestB = crypto.createHash('sha256').update('b').digest('hex');
      const now = 1_000_000;

      const first = await store.acquire('file:src/a.ts', 'task-a', digestA, now, 60_000, created.value.revision);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const conflict = await store.acquire(
        'file:src/a.ts', 'task-b', digestB, now + 1_000, 60_000, first.value.revision,
      );
      expect(conflict.ok).toBe(false);

      const renewed = await store.renew('file:src/a.ts', 'task-a', now + 10_000, 60_000, first.value.revision);
      expect(renewed.ok).toBe(true);
      if (!renewed.ok) return;

      const released = await store.release('file:src/a.ts', 'task-a', renewed.value.revision);
      expect(released.ok).toBe(true);
      if (!released.ok) return;

      const second = await store.acquire(
        'file:src/a.ts', 'task-b', digestB, now + 20_000, 60_000, released.value.revision,
      );
      expect(second.ok).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('expired lease can be reacquired by another task', async () => {
    const fixture = GitFixture.create();
    try {
      const store = new AuthorityLeaseStore(fixture.stateRoot, 'team-lease-2');
      const created = await store.ensure();
      if (!created.ok) throw new Error(created.error.message);
      const dig = crypto.createHash('sha256').update('x').digest('hex');
      const first = await store.acquire('dir:src', 'a', dig, 1000, 100, created.value.revision);
      if (!first.ok) throw new Error(first.error.message);
      const digB = crypto.createHash('sha256').update('y').digest('hex');
      const second = await store.acquire('dir:src', 'b', digB, 10_000, 1000, first.value.revision);
      expect(second.ok).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
