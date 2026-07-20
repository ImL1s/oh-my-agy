import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { canonicalJson } from '../runtime/atomic';
import { runtimeError } from '../runtime/errors';
import { acquireOwnerLock, releaseOwnerLock } from '../runtime/lock';
import { Result, err, ok } from '../runtime/types';
import {
  IntegrationTransactionV1,
  captureLeaderPreimage,
  git,
  readIntegrationTransaction,
  sameWorktreeIdentity,
  writeIntegrationTransaction,
} from './integration';
import { resolveGitWorktreeIdentity } from './worktree';

export interface FastForwardPublisherOptions {
  beforeRefUpdate?: () => void;
  afterRefPublished?: () => void;
}

export class FastForwardPublisherV1 {
  constructor(private readonly options: FastForwardPublisherOptions = {}) {}

  async publishCheckedOutRef(
    transaction: Readonly<IntegrationTransactionV1>,
  ): Promise<Result<IntegrationTransactionV1>> {
    return this.withPublishLock(transaction, (current) => {
      if (current.publishPhase === 'readback_verified') return this.verifyReadback(current);
      if (current.publishPhase === 'ref_published' || current.publishPhase === 'worktree_materialized') {
        return this.recoverLocked(current);
      }
      if (current.publishPhase !== 'temporary_verified' || current.integrationTip === undefined) {
        return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Integration transaction is not ready to publish'));
      }
      const preflight = this.validatePrePublish(current);
      if (!preflight.ok) return preflight;
      this.options.beforeRefUpdate?.();
      const fastForward = spawnSync('git', ['merge-base', '--is-ancestor', current.expectedRefOid, current.integrationTip], {
        cwd: current.leaderRepo,
        encoding: 'utf8',
      });
      if (fastForward.status !== 0) return err(runtimeError('E_DELIVERY_NONLINEAR', 'Integration tip is not a fast-forward descendant'));
      const updated = spawnSync('git', ['update-ref', current.targetSymbolicRef, current.integrationTip, current.expectedRefOid], {
        cwd: current.leaderRepo,
        encoding: 'utf8',
      });
      if (updated.status !== 0) {
        return err(runtimeError('E_TARGET_REF_CHANGED', 'Guarded target ref update lost its expected-old-OID race', {
          stderr: updated.stderr,
        }));
      }
      const published: IntegrationTransactionV1 = { ...current, publishPhase: 'ref_published' };
      writeIntegrationTransaction(published);
      try {
        this.options.afterRefPublished?.();
      } catch (error) {
        return err(runtimeError('E_RETRYABLE_BLOCKER', 'Publisher stopped after guarded ref publication', {
          transactionId: current.transactionId,
          cause: error instanceof Error ? error.message : String(error),
        }));
      }
      const materialized = this.materialize(published);
      if (!materialized.ok) return materialized;
      return this.finishReadback(materialized.value);
    });
  }

  async recover(
    transaction: Readonly<IntegrationTransactionV1>,
  ): Promise<Result<IntegrationTransactionV1>> {
    return this.withPublishLock(transaction, (current) => this.recoverLocked(current));
  }

  private recoverLocked(current: IntegrationTransactionV1): Result<IntegrationTransactionV1> {
    if (current.integrationTip === undefined) return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Recovery transaction has no integration tip'));
    if (current.publishPhase === 'readback_verified') return this.verifyReadback(current);
    const symbolic = git(current.leaderRepo, ['symbolic-ref', '-q', 'HEAD'], 'E_TARGET_REF_CHANGED');
    if (!symbolic.ok || symbolic.value.stdout.trim() !== current.targetSymbolicRef) {
      return err(runtimeError('E_TARGET_REF_CHANGED', 'Recovery target symbolic ref changed'));
    }
    const refOid = git(current.leaderRepo, ['rev-parse', current.targetSymbolicRef], 'E_TARGET_REF_CHANGED');
    if (!refOid.ok) return refOid;
    if (refOid.value.stdout.trim() === current.expectedRefOid && current.publishPhase === 'temporary_verified') {
      return this.publishLockedFromPrepared(current);
    }
    if (refOid.value.stdout.trim() !== current.integrationTip) {
      return err(runtimeError('E_TARGET_REF_CHANGED', 'Recovery observed neither expected old nor integration tip OID'));
    }
    let next = current;
    if (next.publishPhase === 'temporary_verified') {
      next = { ...next, publishPhase: 'ref_published' };
      writeIntegrationTransaction(next);
    }
    if (next.publishPhase === 'ref_published') {
      const materialized = this.materialize(next);
      if (!materialized.ok) return materialized;
      next = materialized.value;
    }
    return this.finishReadback(next);
  }

  private publishLockedFromPrepared(current: IntegrationTransactionV1): Result<IntegrationTransactionV1> {
    const preflight = this.validatePrePublish(current);
    if (!preflight.ok) return preflight;
    const update = spawnSync('git', ['update-ref', current.targetSymbolicRef, current.integrationTip!, current.expectedRefOid], {
      cwd: current.leaderRepo,
      encoding: 'utf8',
    });
    if (update.status !== 0) return err(runtimeError('E_TARGET_REF_CHANGED', 'Guarded recovery publish failed'));
    const published = { ...current, publishPhase: 'ref_published' as const };
    writeIntegrationTransaction(published);
    const materialized = this.materialize(published);
    return materialized.ok ? this.finishReadback(materialized.value) : materialized;
  }

  private validatePrePublish(transaction: Readonly<IntegrationTransactionV1>): Result<void> {
    const current = captureLeaderPreimage(transaction.leaderRepo);
    if (!current.ok) return current;
    if (!sameWorktreeIdentity(current.value.identity, transaction.leaderWorktreeIdentity)) {
      return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Canonical leader worktree identity changed'));
    }
    if (current.value.symbolicRef !== transaction.targetSymbolicRef) {
      return err(runtimeError('E_TARGET_REF_CHANGED', 'Leader symbolic branch changed, even if its OID is identical'));
    }
    if (current.value.refOid !== transaction.expectedRefOid || current.value.headOid !== transaction.expectedHeadOid) {
      return err(runtimeError('E_LEADER_HEAD_CHANGED', 'Leader HEAD or exact target ref OID changed'));
    }
    if (current.value.statusDigest !== transaction.leaderStatusDigest || current.value.indexTree !== transaction.expectedOldTree) {
      return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Leader status or index tree changed'));
    }
    return ok(undefined);
  }

  private materialize(transaction: IntegrationTransactionV1): Result<IntegrationTransactionV1> {
    if (transaction.integrationTip === undefined) return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Integration tip is missing'));
    let identity;
    try { identity = resolveGitWorktreeIdentity(transaction.leaderRepo); } catch (_) {
      return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Leader identity cannot be read during materialization'));
    }
    if (!sameWorktreeIdentity(identity, transaction.leaderWorktreeIdentity)) {
      return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Leader identity changed during materialization'));
    }
    const symbolic = git(transaction.leaderRepo, ['symbolic-ref', '-q', 'HEAD'], 'E_TARGET_REF_CHANGED');
    const ref = git(transaction.leaderRepo, ['rev-parse', transaction.targetSymbolicRef], 'E_TARGET_REF_CHANGED');
    const head = git(transaction.leaderRepo, ['rev-parse', 'HEAD'], 'E_LEADER_HEAD_CHANGED');
    const indexTree = git(transaction.leaderRepo, ['write-tree'], 'E_LEADER_WORKTREE_CHANGED');
    if (!symbolic.ok) return symbolic;
    if (!ref.ok) return ref;
    if (!head.ok) return head;
    if (!indexTree.ok) return indexTree;
    if (
      symbolic.value.stdout.trim() !== transaction.targetSymbolicRef
      || ref.value.stdout.trim() !== transaction.integrationTip
      || head.value.stdout.trim() !== transaction.integrationTip
    ) {
      return err(runtimeError('E_TARGET_REF_CHANGED', 'Published ref/HEAD identity does not match the transaction'));
    }
    if (indexTree.value.stdout.trim() !== transaction.expectedOldTree) {
      return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Leader index no longer matches the journaled preimage; no materialization attempted'));
    }
    const worktreeDiff = spawnSync('git', ['diff-files', '--quiet'], { cwd: transaction.leaderRepo, encoding: 'utf8' });
    const untracked = git(transaction.leaderRepo, ['ls-files', '--others', '--exclude-standard'], 'E_LEADER_WORKTREE_CHANGED');
    if (worktreeDiff.status !== 0 || !untracked.ok || untracked.value.stdout !== '') {
      return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'User changes appeared after ref publication; materialization is blocked'));
    }
    const materialized = git(
      transaction.leaderRepo,
      ['read-tree', '-u', '-m', transaction.expectedRefOid, transaction.integrationTip],
      'E_LEADER_WORKTREE_CHANGED',
    );
    if (!materialized.ok) return materialized;
    const next = { ...transaction, publishPhase: 'worktree_materialized' as const };
    writeIntegrationTransaction(next);
    return ok(next);
  }

  private finishReadback(transaction: IntegrationTransactionV1): Result<IntegrationTransactionV1> {
    const verified = this.verifyReadback(transaction);
    if (!verified.ok) return verified;
    const verifiedTransaction: IntegrationTransactionV1 = {
      ...verified.value,
      publishPhase: 'readback_verified',
    };
    writeIntegrationTransaction(verifiedTransaction);
    const cleaned = this.cleanupTemporary(verifiedTransaction);
    return cleaned.ok ? cleaned : ok(verifiedTransaction);
  }

  private verifyReadback(transaction: IntegrationTransactionV1): Result<IntegrationTransactionV1> {
    if (transaction.integrationTip === undefined) return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Integration tip is missing'));
    let identity;
    try { identity = resolveGitWorktreeIdentity(transaction.leaderRepo); } catch (_) {
      return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Leader identity cannot be read back'));
    }
    if (!sameWorktreeIdentity(identity, transaction.leaderWorktreeIdentity)) {
      return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Leader identity changed before readback'));
    }
    const symbolic = git(transaction.leaderRepo, ['symbolic-ref', '-q', 'HEAD'], 'E_TARGET_REF_CHANGED');
    if (!symbolic.ok) return symbolic;
    const ref = git(transaction.leaderRepo, ['rev-parse', transaction.targetSymbolicRef], 'E_TARGET_REF_CHANGED');
    if (!ref.ok) return ref;
    const head = git(transaction.leaderRepo, ['rev-parse', 'HEAD'], 'E_LEADER_HEAD_CHANGED');
    if (!head.ok) return head;
    const status = git(transaction.leaderRepo, ['status', '--porcelain=v1', '--untracked-files=all'], 'E_LEADER_WORKTREE_CHANGED');
    if (!status.ok) return status;
    const tree = git(transaction.leaderRepo, ['write-tree'], 'E_LEADER_WORKTREE_CHANGED');
    if (!tree.ok) return tree;
    const tipTree = git(transaction.leaderRepo, ['rev-parse', `${transaction.integrationTip}^{tree}`], 'E_DELIVERY_UNINTEGRATED');
    if (!tipTree.ok) return tipTree;
    if (
      symbolic.value.stdout.trim() !== transaction.targetSymbolicRef
      || ref.value.stdout.trim() !== transaction.integrationTip
      || head.value.stdout.trim() !== transaction.integrationTip
      || status.value.stdout !== ''
      || tree.value.stdout.trim() !== tipTree.value.stdout.trim()
      || transaction.commitMapping.length !== transaction.delivery.evidence.orderedCommits.length
      || transaction.deliveryDigest !== transaction.delivery.deliveryDigest
    ) {
      return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Publisher readback does not match integration transaction'));
    }
    return ok(transaction);
  }

  private cleanupTemporary(transaction: IntegrationTransactionV1): Result<IntegrationTransactionV1> {
    if (transaction.temporaryCleaned) return ok(transaction);
    if (fs.existsSync(transaction.temporaryWorktreePath)) {
      const removed = spawnSync('git', ['worktree', 'remove', transaction.temporaryWorktreePath], {
        cwd: transaction.leaderRepo,
        encoding: 'utf8',
      });
      if (removed.status !== 0) return ok(transaction);
    }
    spawnSync('git', ['branch', '-D', transaction.temporaryBranch], { cwd: transaction.leaderRepo, encoding: 'utf8' });
    const next = { ...transaction, temporaryCleaned: true };
    writeIntegrationTransaction(next);
    return ok(next);
  }

  private async withPublishLock(
    transaction: Readonly<IntegrationTransactionV1>,
    operation: (current: IntegrationTransactionV1) => Result<IntegrationTransactionV1>,
  ): Promise<Result<IntegrationTransactionV1>> {
    // 設計概念映射：OwnerLock 為 async（競爭時需 yield event loop）；
    // 禁止 busy-wait/Atomics.wait 封鎖主執行緒，否則 Promise 永遠不會 settle。
    const lockResult = await acquireOwnerLock(`${transaction.journalPath}.publish.lock`, {
      timeoutMs: 5_000,
    });
    if (!lockResult.ok) {
      return err(lockResult.error ?? runtimeError('E_LOCK_TIMEOUT', 'Publisher integration lock timed out'));
    }
    try {
      const current = readIntegrationTransaction(transaction.journalPath);
      if (
        current.transactionId !== transaction.transactionId
        || current.ownerNonce !== transaction.ownerNonce
        || current.stateRevision !== transaction.stateRevision
        || current.deliveryDigest !== transaction.deliveryDigest
      ) {
        return err(runtimeError('E_REVISION_CONFLICT', 'Integration journal changed before publish'));
      }
      return operation(current);
    } catch (error) {
      return err(runtimeError('E_CORRUPT_STATE', 'Integration journal cannot be read', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      releaseOwnerLock(lockResult.value);
    }
  }
}

