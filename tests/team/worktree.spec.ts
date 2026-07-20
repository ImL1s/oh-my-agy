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
});

