import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson, canonicalJson, sha256 } from '../runtime/atomic';
import { RuntimeErrorCode, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { ValidatedDeliveryV1 } from './delivery';
import { LeaderWorktreeIdentityV1, TeamVerificationCommandV1 } from './types';
import { resolveGitWorktreeIdentity } from './worktree';

export type IntegrationPublishPhase =
  | 'prepared'
  | 'applying'
  | 'temporary_verified'
  | 'integration_blocked'
  | 'ref_published'
  | 'worktree_materialized'
  | 'readback_verified';

export interface IntegrationCommitMappingV1 {
  originalCommit: string;
  integratedCommit: string;
}

export interface IntegrationTransactionV1 {
  schemaVersion: 1;
  transactionId: string;
  stateRevision: number;
  ownerNonce: string;
  leaderRepo: string;
  leaderWorktreeIdentity: LeaderWorktreeIdentityV1;
  targetSymbolicRef: string;
  expectedRefOid: string;
  expectedHeadOid: string;
  expectedOldTree: string;
  leaderStatusDigest: string;
  deliveryDigest: string;
  delivery: ValidatedDeliveryV1;
  temporaryWorktreePath: string;
  temporaryBranch: string;
  temporaryWorktreeIdentity?: LeaderWorktreeIdentityV1;
  integrationTip?: string;
  commitMapping: readonly IntegrationCommitMappingV1[];
  publishPhase: IntegrationPublishPhase;
  journalPath: string;
  temporaryCleaned: boolean;
  blockedReason?: string;
}

export interface PrepareIntegrationInput {
  leaderRepo: string;
  stateRevision: number;
  ownerNonce: string;
  delivery: ValidatedDeliveryV1;
  verificationCommands?: readonly TeamVerificationCommandV1[];
}

export interface IntegrationManagerOptions {
  transactionIdFactory?: () => string;
  afterCommitApplied?: (index: number, transaction: Readonly<IntegrationTransactionV1>) => void;
}

export class IntegrationManager {
  readonly managedRoot: string;
  private readonly transactionIdFactory: () => string;
  private readonly afterCommitApplied?: IntegrationManagerOptions['afterCommitApplied'];

  constructor(managedRoot: string, options: IntegrationManagerOptions = {}) {
    fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
    this.managedRoot = fs.realpathSync(managedRoot);
    this.transactionIdFactory = options.transactionIdFactory ?? (() => crypto.randomBytes(12).toString('hex'));
    this.afterCommitApplied = options.afterCommitApplied;
  }

  prepare(input: Readonly<PrepareIntegrationInput>): Result<IntegrationTransactionV1> {
    const leader = captureLeaderPreimage(input.leaderRepo);
    if (!leader.ok) return leader;
    if (isContained(leader.value.identity.canonicalRealpath, this.managedRoot)) {
      return err(runtimeError('E_STATE_ROOT_TRACKED', 'Temporary integration root must be outside the leader worktree'));
    }
    const transactionId = this.transactionIdFactory();
    const transactionRoot = path.join(this.managedRoot, 'integration');
    fs.mkdirSync(transactionRoot, { recursive: true, mode: 0o700 });
    const temporaryWorktreePath = path.join(transactionRoot, `${transactionId}-worktree`);
    const temporaryBranch = `oma-integration/${transactionId}`;
    const journalPath = path.join(transactionRoot, `${transactionId}.json`);
    let transaction: IntegrationTransactionV1 = {
      schemaVersion: 1,
      transactionId,
      stateRevision: input.stateRevision,
      ownerNonce: input.ownerNonce,
      leaderRepo: leader.value.identity.canonicalRealpath,
      leaderWorktreeIdentity: leader.value.identity,
      targetSymbolicRef: leader.value.symbolicRef,
      expectedRefOid: leader.value.refOid,
      expectedHeadOid: leader.value.headOid,
      expectedOldTree: leader.value.indexTree,
      leaderStatusDigest: leader.value.statusDigest,
      deliveryDigest: input.delivery.deliveryDigest,
      delivery: input.delivery,
      temporaryWorktreePath,
      temporaryBranch,
      commitMapping: [],
      publishPhase: 'prepared',
      journalPath,
      temporaryCleaned: false,
    };
    writeIntegrationTransaction(transaction);
    const added = git(transaction.leaderRepo, ['worktree', 'add', '-b', temporaryBranch, temporaryWorktreePath, transaction.expectedRefOid], 'E_RETRYABLE_BLOCKER');
    if (!added.ok) return this.block(transaction, added.error.message);
    try {
      transaction = {
        ...transaction,
        temporaryWorktreeIdentity: resolveGitWorktreeIdentity(temporaryWorktreePath),
        publishPhase: 'applying',
      };
      writeIntegrationTransaction(transaction);
      const mappings: IntegrationCommitMappingV1[] = [];
      for (let index = 0; index < input.delivery.evidence.orderedCommits.length; index++) {
        const originalCommit = input.delivery.evidence.orderedCommits[index];
        const cherryPicked = git(temporaryWorktreePath, ['cherry-pick', originalCommit], 'E_DELIVERY_UNINTEGRATED');
        if (!cherryPicked.ok) return this.block(transaction, `Commit ${originalCommit} failed: ${cherryPicked.error.message}`);
        const integrated = mustGit(temporaryWorktreePath, ['rev-parse', 'HEAD']);
        mappings.push({ originalCommit, integratedCommit: integrated });
        transaction = { ...transaction, commitMapping: [...mappings] };
        writeIntegrationTransaction(transaction);
        this.afterCommitApplied?.(index, transaction);
      }
      for (const command of input.verificationCommands ?? []) {
        const cwd = path.resolve(temporaryWorktreePath, command.cwd);
        if (!isContained(temporaryWorktreePath, cwd)) return this.block(transaction, 'Verification cwd escapes temporary worktree');
        const result = spawnSync(command.command, [...command.argv], {
          cwd,
          encoding: 'utf8',
          timeout: command.deadlineMs,
        });
        if ((result.status ?? 1) !== command.expectedExit) {
          return this.block(transaction, `Verification command failed: ${command.command}`);
        }
      }
      const integrationTip = mustGit(temporaryWorktreePath, ['rev-parse', 'HEAD']);
      const descendant = spawnSync('git', ['merge-base', '--is-ancestor', transaction.expectedRefOid, integrationTip], {
        cwd: temporaryWorktreePath,
        encoding: 'utf8',
      });
      if (descendant.status !== 0) return this.block(transaction, 'Temporary integration tip is not a fast-forward descendant');
      const status = mustGit(temporaryWorktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
      if (status !== '') return this.block(transaction, 'Temporary integration worktree is dirty after verification');
      transaction = { ...transaction, integrationTip, publishPhase: 'temporary_verified' };
      writeIntegrationTransaction(transaction);
      return ok(transaction);
    } catch (error) {
      return this.block(transaction, error instanceof Error ? error.message : String(error));
    }
  }

  private block(transaction: IntegrationTransactionV1, reason: string): Result<IntegrationTransactionV1> {
    const blocked = { ...transaction, publishPhase: 'integration_blocked' as const, blockedReason: reason };
    writeIntegrationTransaction(blocked);
    return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Temporary integration is blocked; leader remains untouched', {
      transactionId: transaction.transactionId,
      journalPath: transaction.journalPath,
      reason,
    }));
  }
}

export interface LeaderPreimage {
  identity: LeaderWorktreeIdentityV1;
  symbolicRef: string;
  refOid: string;
  headOid: string;
  indexTree: string;
  statusDigest: string;
}

export function captureLeaderPreimage(leaderRepo: string): Result<LeaderPreimage> {
  let identity: LeaderWorktreeIdentityV1;
  try { identity = resolveGitWorktreeIdentity(leaderRepo); } catch (error) {
    return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Canonical leader worktree identity cannot be resolved', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
  const symbolic = git(identity.canonicalRealpath, ['symbolic-ref', '-q', 'HEAD'], 'E_TARGET_REF_CHANGED');
  if (!symbolic.ok) return symbolic;
  const targetSymbolicRef = symbolic.value.stdout.trim();
  if (!targetSymbolicRef.startsWith('refs/heads/')) {
    return err(runtimeError('E_TARGET_REF_CHANGED', 'Leader HEAD is not an exact symbolic branch ref'));
  }
  const ref = git(identity.canonicalRealpath, ['rev-parse', targetSymbolicRef], 'E_TARGET_REF_CHANGED');
  const head = git(identity.canonicalRealpath, ['rev-parse', 'HEAD'], 'E_LEADER_HEAD_CHANGED');
  const status = git(identity.canonicalRealpath, ['status', '--porcelain=v1', '--untracked-files=all'], 'E_LEADER_WORKTREE_CHANGED');
  const tree = git(identity.canonicalRealpath, ['write-tree'], 'E_LEADER_WORKTREE_CHANGED');
  if (!ref.ok) return ref;
  if (!head.ok) return head;
  if (!status.ok) return status;
  if (!tree.ok) return tree;
  if (ref.value.stdout.trim() !== head.value.stdout.trim()) {
    return err(runtimeError('E_LEADER_HEAD_CHANGED', 'Leader target ref and HEAD OID differ'));
  }
  if (status.value.stdout !== '') {
    return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Leader worktree must be clean before temporary integration'));
  }
  return ok({
    identity,
    symbolicRef: targetSymbolicRef,
    refOid: ref.value.stdout.trim(),
    headOid: head.value.stdout.trim(),
    indexTree: tree.value.stdout.trim(),
    statusDigest: sha256(status.value.stdout),
  });
}

export function writeIntegrationTransaction(transaction: Readonly<IntegrationTransactionV1>): void {
  atomicWriteJson(transaction.journalPath, transaction);
}

export function readIntegrationTransaction(journalPath: string): IntegrationTransactionV1 {
  return JSON.parse(fs.readFileSync(journalPath, 'utf8')) as IntegrationTransactionV1;
}

export function sameWorktreeIdentity(
  left: Readonly<LeaderWorktreeIdentityV1>,
  right: Readonly<LeaderWorktreeIdentityV1>,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

interface GitOutput {
  stdout: string;
  stderr: string;
}

export function git(
  cwd: string,
  argv: readonly string[],
  code: RuntimeErrorCode,
): Result<GitOutput> {
  const result = spawnSync('git', [...argv], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    return err(runtimeError(code, 'Git integration command failed', {
      argv,
      exitCode: result.status,
      stderr: result.stderr,
    }));
  }
  return ok({ stdout: result.stdout, stderr: result.stderr });
}

export function mustGit(cwd: string, argv: readonly string[]): string {
  const result = git(cwd, argv, 'E_RETRYABLE_BLOCKER');
  if (!result.ok) throw new Error(result.error.message);
  return result.value.stdout.trim();
}

function isContained(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

