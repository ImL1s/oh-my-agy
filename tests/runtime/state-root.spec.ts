import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  ensureContainedPath,
  externalStatePathKey,
  platformSessionAggregateRelativePath,
  resolveStateRoot,
  resolveWorkspaceIdentity,
  verifyStateRootIgnoredForWrite,
} from '../../src/runtime/state-root';

describe('external state-root and workspace identity', () => {
  test('resolves platform defaults and creates an owner-only external root', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-root-home-'));
    try {
      const resolved = resolveStateRoot({
        platform: 'linux', homeDirectory: home, env: {},
      });
      expect(resolved).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ source: 'platform-default' }),
      }));
      if (!resolved.ok) return;
      expect(resolved.value.path).toBe(fs.realpathSync(path.join(home, '.local', 'state', 'oh-my-agy')));
      expect(fs.statSync(resolved.value.path).mode & 0o077).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects root and entry symlinks plus traversal', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-root-links-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-root-outside-'));
    try {
      const linkRoot = path.join(fixture, 'link-root');
      fs.symlinkSync(outside, linkRoot);
      expect(resolveStateRoot({ env: { OMA_STATE_ROOT: linkRoot } })).toEqual(expect.objectContaining({
        ok: false, error: expect.objectContaining({ code: 'E_PATH_OUTSIDE_ROOT' }),
      }));
      const safe = path.join(fixture, 'safe');
      fs.mkdirSync(safe, { mode: 0o700 });
      fs.symlinkSync(outside, path.join(safe, 'escape'));
      expect(ensureContainedPath(safe, 'escape/value')).toEqual(expect.objectContaining({ ok: false }));
      expect(ensureContainedPath(safe, '../outside')).toEqual(expect.objectContaining({ ok: false }));
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('separates common repository identity from worktree identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-root-git-'));
    const repo = path.join(root, 'repo');
    const sibling = path.join(root, 'sibling');
    fs.mkdirSync(repo);
    try {
      for (const argv of [
        ['init', '-q'],
        ['config', 'user.email', 'fixture@example.invalid'],
        ['config', 'user.name', 'Fixture'],
      ]) expect(spawnSync('git', argv, { cwd: repo }).status).toBe(0);
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'fixture\n');
      expect(spawnSync('git', ['add', '.'], { cwd: repo }).status).toBe(0);
      expect(spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: repo }).status).toBe(0);
      expect(spawnSync('git', ['worktree', 'add', '-q', '-b', 'sibling', sibling], { cwd: repo }).status).toBe(0);
      const leader = resolveWorkspaceIdentity(repo);
      const worker = resolveWorkspaceIdentity(sibling);
      expect(leader.ok && worker.ok).toBe(true);
      if (!leader.ok || !worker.ok) return;
      expect(leader.value.repoKey).toBe(worker.value.repoKey);
      expect(leader.value.workspaceKey).not.toBe(worker.value.workspaceKey);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires an in-worktree override to already be ignored', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-root-ignore-'));
    try {
      expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
      const state = path.join(repo, '.runtime-state');
      expect(verifyStateRootIgnoredForWrite(state, repo)).toEqual(expect.objectContaining({
        ok: false, error: expect.objectContaining({ code: 'E_STATE_ROOT_TRACKED' }),
      }));
      fs.writeFileSync(path.join(repo, '.gitignore'), '.runtime-state/\n');
      expect(verifyStateRootIgnoredForWrite(state, repo)).toEqual({ ok: true, value: undefined });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('raw external identifiers are hashed before becoming aggregate path components', () => {
    const rawWorkspace = 'workspace/../secret?token=value';
    const rawSession = 'conversation/raw/id';
    const relative = platformSessionAggregateRelativePath(rawWorkspace, rawSession);
    expect(relative).not.toContain(rawWorkspace);
    expect(relative).not.toContain(rawSession);
    expect(relative).toContain(externalStatePathKey(rawWorkspace));
    expect(relative).toContain(externalStatePathKey(rawSession));
    expect(relative).not.toContain('..');
  });
});
