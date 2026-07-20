import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson, sha256 } from '../runtime/atomic';
import { runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { LeaderWorktreeIdentityV1 } from './types';

export interface CreateManagedWorktreeInput {
  teamId: string;
  workerId: string;
  generation: number;
  branchName: string;
  baseSha: string;
  ownerNonce: string;
}

export interface ManagedWorktreeV1 {
  schemaVersion: 1;
  path: string;
  branchName: string;
  baseSha: string;
  ownerNonce: string;
  teamId: string;
  workerId: string;
  generation: number;
  markerPath: string;
  identity: LeaderWorktreeIdentityV1;
}

export class GitWorktreeManager {
  readonly leaderRepo: string;
  readonly managedRoot: string;

  constructor(leaderRepo: string, managedRoot: string) {
    this.leaderRepo = fs.realpathSync(leaderRepo);
    fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
    this.managedRoot = fs.realpathSync(managedRoot);
  }

  create(input: Readonly<CreateManagedWorktreeInput>): Result<ManagedWorktreeV1> {
    if (!safeId(input.teamId) || !safeId(input.workerId) || !Number.isInteger(input.generation) || input.generation < 1) {
      return err(runtimeError('E_CORRUPT_STATE', 'Managed worktree identity is invalid'));
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(input.branchName) || input.branchName.includes('..')) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Managed branch name is invalid'));
    }
    if (!/^[a-f0-9]{40,64}$/i.test(input.baseSha)) return err(runtimeError('E_CORRUPT_STATE', 'Worktree base SHA is invalid'));
    const target = path.resolve(this.managedRoot, input.teamId, `${input.workerId}-g${input.generation}`);
    if (!isContained(this.managedRoot, target) || fs.existsSync(target)) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Managed worktree target is unsafe or already exists', { target }));
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const added = git(this.leaderRepo, ['worktree', 'add', '-b', input.branchName, target, input.baseSha]);
    if (!added.ok) return added;
    try {
      const identity = resolveGitWorktreeIdentity(target);
      const markerPath = `${target}.owner.json`;
      const descriptor: ManagedWorktreeV1 = {
        schemaVersion: 1,
        path: identity.canonicalRealpath,
        branchName: input.branchName,
        baseSha: input.baseSha,
        ownerNonce: input.ownerNonce,
        teamId: input.teamId,
        workerId: input.workerId,
        generation: input.generation,
        markerPath,
        identity,
      };
      atomicWriteJson(markerPath, descriptor);
      return ok(descriptor);
    } catch (error) {
      spawnSync('git', ['worktree', 'remove', '--force', target], { cwd: this.leaderRepo, encoding: 'utf8' });
      return err(runtimeError('E_CORRUPT_STATE', 'Unable to describe the managed worktree', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  removeIfSafe(
    descriptor: Readonly<ManagedWorktreeV1>,
    options: Readonly<{ ownerNonce: string; integrated: boolean }>,
  ): Result<void> {
    if (!isContained(this.managedRoot, descriptor.path) || descriptor.ownerNonce !== options.ownerNonce) {
      return err(runtimeError('E_LOCK_NOT_OWNER', 'Managed worktree cleanup owner does not match'));
    }
    const marker = readDescriptor(descriptor.markerPath);
    if (marker === null || marker.ownerNonce !== options.ownerNonce || marker.path !== descriptor.path) {
      return err(runtimeError('E_LOCK_NOT_OWNER', 'Managed worktree owner marker does not match'));
    }
    const status = git(descriptor.path, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (!status.ok || status.value.stdout !== '') {
      return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Dirty managed worktree is preserved', { path: descriptor.path }));
    }
    if (!options.integrated) {
      const head = git(descriptor.path, ['rev-parse', 'HEAD']);
      if (!head.ok || head.value.stdout.trim() !== descriptor.baseSha) {
        return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Unintegrated commits require worktree preservation'));
      }
    }
    const removed = git(this.leaderRepo, ['worktree', 'remove', descriptor.path]);
    if (!removed.ok) return removed;
    fs.rmSync(descriptor.markerPath, { force: true });
    return ok(undefined);
  }
}

export function resolveGitWorktreeIdentity(worktree: string): LeaderWorktreeIdentityV1 {
  const canonicalRealpath = fs.realpathSync(worktree);
  const topLevel = mustGit(canonicalRealpath, ['rev-parse', '--show-toplevel']);
  const canonicalTopLevel = fs.realpathSync(topLevel);
  const commonRaw = mustGit(canonicalRealpath, ['rev-parse', '--git-common-dir']);
  const commonPath = fs.realpathSync(path.resolve(canonicalRealpath, commonRaw));
  const adminHeadRaw = mustGit(canonicalRealpath, ['rev-parse', '--git-path', 'HEAD']);
  const adminHead = path.resolve(canonicalRealpath, adminHeadRaw);
  const adminRoot = fs.realpathSync(path.dirname(adminHead));
  const stat = fs.statSync(canonicalTopLevel);
  return {
    canonicalRealpath: canonicalTopLevel,
    workspaceKey: sha256(canonicalTopLevel),
    repoKey: sha256(commonPath),
    gitCommonDir: commonPath,
    gitWorktreeAdminId: path.relative(commonPath, adminRoot) || '.',
    deviceAndInodeIfAvailable: `${stat.dev}:${stat.ino}`,
  };
}

interface GitOutput {
  stdout: string;
  stderr: string;
}

function git(cwd: string, argv: readonly string[]): Result<GitOutput> {
  const result = spawnSync('git', [...argv], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    return err(runtimeError('E_RETRYABLE_BLOCKER', 'Git worktree command failed', {
      argv,
      exitCode: result.status,
      stderr: result.stderr,
    }));
  }
  return ok({ stdout: result.stdout, stderr: result.stderr });
}

function mustGit(cwd: string, argv: readonly string[]): string {
  const result = git(cwd, argv);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.stdout.trim();
}

function readDescriptor(markerPath: string): ManagedWorktreeV1 | null {
  try { return JSON.parse(fs.readFileSync(markerPath, 'utf8')) as ManagedWorktreeV1; } catch (_) { return null; }
}

function safeId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function isContained(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

