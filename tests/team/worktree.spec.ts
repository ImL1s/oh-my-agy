import * as fs from 'fs';
import * as path from 'path';
import { GitWorktreeManager, resolveGitWorktreeIdentity } from '../../src/team/worktree';
import { GitFixture } from '../helpers/git-fixture';

describe('safe Git worktree lifecycle', () => {
  let fixture: GitFixture;

  beforeEach(() => { fixture = GitFixture.create(); });
  afterEach(() => fixture.cleanup());

  test('TEAM-01/17 creates only under the managed root and preserves dirty worktrees', () => {
    const manager = new GitWorktreeManager(fixture.repo, fixture.managedWorktreesRoot);
    const created = manager.create({
      teamId: 'alpha', workerId: 'worker-1', generation: 1, branchName: 'oma-team/alpha/worker-1-g1',
      baseSha: fixture.head(), ownerNonce: 'owner-a',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.identity.canonicalRealpath.startsWith(fs.realpathSync(fixture.managedWorktreesRoot))).toBe(true);
    expect(resolveGitWorktreeIdentity(fixture.repo).repoKey).toBe(created.value.identity.repoKey);
    expect(resolveGitWorktreeIdentity(fixture.repo).workspaceKey).not.toBe(created.value.identity.workspaceKey);

    fs.writeFileSync(path.join(created.value.path, 'dirty.txt'), 'preserve me\n');
    const rejected = manager.removeIfSafe(created.value, { ownerNonce: 'owner-a', integrated: true });
    expect(rejected.ok).toBe(false);
    expect(fs.existsSync(path.join(created.value.path, 'dirty.txt'))).toBe(true);
  });

  test('seal is immutable and terminal cleanup removes only owned integrated worktrees', () => {
    const manager = new GitWorktreeManager(fixture.repo, fixture.managedWorktreesRoot);
    const created = manager.create({
      teamId: 'alpha', workerId: 'worker-1', generation: 1, branchName: 'oma-team/alpha/sealed',
      baseSha: fixture.head(), ownerNonce: 'owner-a',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const head = fixture.commitFile('src/result.ts', 'done\n', 'worker result', created.value.path);
    const sealed = manager.seal(created.value, { ownerNonce: 'owner-a', expectedHead: head, sealedAtMs: 100 });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(manager.seal(created.value, { ownerNonce: 'owner-a', expectedHead: head, sealedAtMs: 100 })).toEqual(sealed);
    expect(manager.seal(created.value, { ownerNonce: 'owner-a', expectedHead: head, sealedAtMs: 101 }).ok).toBe(false);
    expect(manager.cleanupTerminal(created.value, { ownerNonce: 'foreign', outcome: 'integrated' }).ok).toBe(false);
    expect(fs.existsSync(created.value.path)).toBe(true);
    expect(manager.cleanupTerminal(created.value, { ownerNonce: 'owner-a', outcome: 'integrated' }).ok).toBe(true);
    expect(fs.existsSync(created.value.path)).toBe(false);
    expect(fs.existsSync(`${created.value.markerPath}.seal.json`)).toBe(false);
  });

  test('cancel preserves an owned worktree with unintegrated commits', () => {
    const manager = new GitWorktreeManager(fixture.repo, fixture.managedWorktreesRoot);
    const created = manager.create({
      teamId: 'alpha', workerId: 'worker-2', generation: 1, branchName: 'oma-team/alpha/cancelled',
      baseSha: fixture.head(), ownerNonce: 'owner-a',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    fixture.commitFile('result.ts', 'unintegrated\n', 'unintegrated', created.value.path);
    expect(manager.cleanupTerminal(created.value, { ownerNonce: 'owner-a', outcome: 'cancelled' }).ok).toBe(false);
    expect(fs.existsSync(created.value.path)).toBe(true);
  });
});
