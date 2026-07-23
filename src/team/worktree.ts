import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson, canonicalJson, sha256 } from '../runtime/atomic';
import { runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { LeaderWorktreeIdentityV1 } from './types';
import { isCanonicalTeamIdentifier } from './manifest';

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

export interface ManagedWorktreeSealV1 {
  schemaVersion: 1;
  teamId: string;
  workerId: string;
  generation: number;
  ownerNonce: string;
  worktreeRealpath: string;
  baseSha: string;
  headSha: string;
  cleanStatusDigest: string;
  sealedAtMs: number;
  sealDigest: string;
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
    if (!isCanonicalTeamIdentifier(input.teamId) || !isCanonicalTeamIdentifier(input.workerId)
      || !Number.isInteger(input.generation) || input.generation < 1) {
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
      spawnSync('git', ['branch', '-D', input.branchName], { cwd: this.leaderRepo, encoding: 'utf8' });
      return err(runtimeError('E_CORRUPT_STATE', 'Unable to describe the managed worktree', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  seal(
    descriptor: Readonly<ManagedWorktreeV1>,
    options: Readonly<{ ownerNonce: string; expectedHead: string; sealedAtMs: number }>,
  ): Result<ManagedWorktreeSealV1> {
    const owner = validateOwnedDescriptor(this.managedRoot, descriptor, options.ownerNonce);
    if (!owner.ok) return owner;
    const status = git(descriptor.path, ['status', '--porcelain=v1', '--untracked-files=all']);
    const head = git(descriptor.path, ['rev-parse', 'HEAD']);
    if (!status.ok) return status;
    if (!head.ok) return head;
    if (status.value.stdout !== '' || head.value.stdout.trim() !== options.expectedHead) {
      return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Managed worktree cannot be sealed with dirty or changed bytes'));
    }
    const material = {
      schemaVersion: 1 as const,
      teamId: descriptor.teamId,
      workerId: descriptor.workerId,
      generation: descriptor.generation,
      ownerNonce: descriptor.ownerNonce,
      worktreeRealpath: descriptor.path,
      baseSha: descriptor.baseSha,
      headSha: options.expectedHead,
      cleanStatusDigest: sha256(status.value.stdout),
      sealedAtMs: options.sealedAtMs,
    };
    const seal: ManagedWorktreeSealV1 = {
      ...material,
      sealDigest: sha256(canonicalJson(material)),
    };
    const sealPath = `${descriptor.markerPath}.seal.json`;
    if (fs.existsSync(sealPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(sealPath, 'utf8')) as ManagedWorktreeSealV1;
        return canonicalJson(existing) === canonicalJson(seal)
          ? ok(existing)
          : err(runtimeError('E_REVISION_CONFLICT', 'Managed worktree seal is immutable'));
      } catch (_) {
        return err(runtimeError('E_CORRUPT_STATE', 'Managed worktree seal is corrupt'));
      }
    }
    atomicWriteJson(sealPath, seal);
    return ok(seal);
  }

  cleanupTerminal(
    descriptor: Readonly<ManagedWorktreeV1>,
    options: Readonly<{ ownerNonce: string; outcome: 'integrated' | 'cancelled' }>,
  ): Result<void> {
    const removed = this.removeIfSafe(descriptor, {
      ownerNonce: options.ownerNonce,
      integrated: options.outcome === 'integrated',
    });
    if (!removed.ok) return removed;
    fs.rmSync(`${descriptor.markerPath}.seal.json`, { force: true });
    return ok(undefined);
  }

  /** Abort a newly-created launch without preserving its disposable branch. */
  rollbackLaunch(
    descriptor: Readonly<ManagedWorktreeV1>,
    ownerNonce: string,
  ): Result<void> {
    const removed = this.removeIfSafe(descriptor, { ownerNonce, integrated: true });
    if (!removed.ok) return removed;
    const branch = git(this.leaderRepo, ['branch', '-D', descriptor.branchName]);
    return branch.ok ? ok(undefined) : branch;
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

function validateOwnedDescriptor(
  managedRoot: string,
  descriptor: Readonly<ManagedWorktreeV1>,
  ownerNonce: string,
): Result<ManagedWorktreeV1> {
  if (!isContained(managedRoot, descriptor.path) || descriptor.ownerNonce !== ownerNonce) {
    return err(runtimeError('E_LOCK_NOT_OWNER', 'Managed worktree owner does not match'));
  }
  const marker = readDescriptor(descriptor.markerPath);
  if (marker === null || marker.ownerNonce !== ownerNonce
    || marker.path !== descriptor.path || canonicalJson(marker) !== canonicalJson(descriptor)) {
    return err(runtimeError('E_LOCK_NOT_OWNER', 'Managed worktree owner marker does not match'));
  }
  return ok(marker);
}

function isContained(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}
