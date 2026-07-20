import * as crypto from 'crypto';
import { canonicalJson, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { StateStore } from '../runtime/state-store';
import { Result, Snapshot, err, ok } from '../runtime/types';
import { LeaderWorktreeIdentityV1, RuntimeContext } from './types';

export interface RecoveryForkCandidateV1 {
  generation: number;
  branch: string;
  worktreeIdentity: string;
  claimTokenDigest: string;
  headSha: string;
  treeSha: string;
  statusDigest: string;
  verificationDigest: string;
  deliveryDigest: string;
  candidateRevision: number;
  status: 'active' | 'selected' | 'fenced_superseded';
}

export interface RecoveryForkResolutionRecordV1 {
  schemaVersion: 1;
  operationNonce: string;
  evidenceDigest: string;
  selectedGeneration: number;
  selectionRevision: number;
  freshClaimToken: string;
  freshClaimTokenDigest: string;
}

export interface RecoveryForkV1 {
  schemaVersion: 1;
  forkId: string;
  taskId: string;
  status: 'unresolved' | 'selected';
  candidates: RecoveryForkCandidateV1[];
  resolution?: RecoveryForkResolutionRecordV1;
}

export interface RecoveryTaskAggregateV1 {
  schemaVersion: 1;
  teamId: string;
  taskId: string;
  repoKey: string;
  ownerNonce: string;
  leaderWorkspaceKey: string;
  leaderWorktree: LeaderWorktreeIdentityV1;
  canonicalGeneration: number;
  fork: RecoveryForkV1;
}

export interface RecoveryForkSelectionEvidenceV1 {
  schemaVersion: 1;
  operationNonce: string;
  forkId: string;
  taskId: string;
  expectedAggregateRevision: number;
  candidates: RecoveryForkCandidateV1[];
  selectedGeneration: number;
  reason: string;
  leaderActor: {
    teamId: string;
    repoKey: string;
    workspaceKey: string;
    ownerNonce: string;
    worktree: LeaderWorktreeIdentityV1;
  };
  artifactDigest: string;
}

export interface ResolveRecoveryForkInput {
  forkId: string;
  winnerGeneration: number;
  expectedRevision: number;
  evidence: RecoveryForkSelectionEvidenceV1;
}

export interface RecoveryForkResolvedValue {
  aggregate: RecoveryTaskAggregateV1;
  revision: number;
  resolution: RecoveryForkResolutionRecordV1;
}

export type RecoveryForkResolveResult =
  | ({ kind: 'Selected' } & RecoveryForkResolvedValue)
  | ({ kind: 'Replayed' } & RecoveryForkResolvedValue)
  | { kind: 'Rejected'; error: RuntimeError };

export class RecoveryForkResolver {
  constructor(
    private readonly store: StateStore<RecoveryTaskAggregateV1>,
    private readonly key: string,
  ) {}

  async resolve(
    input: Readonly<ResolveRecoveryForkInput>,
    context: Readonly<RuntimeContext>,
  ): Promise<RecoveryForkResolveResult> {
    const snapshot = this.store.read(this.key);
    if (!snapshot.ok) return { kind: 'Rejected', error: snapshot.error };
    const leader = validateLeader(snapshot.value.value, context);
    if (!leader.ok) return { kind: 'Rejected', error: leader.error };
    const evidenceDigest = sha256(canonicalJson(input.evidence));
    const existing = snapshot.value.value.fork.resolution;
    if (existing !== undefined) {
      if (
        existing.operationNonce === input.evidence.operationNonce
        && existing.evidenceDigest === evidenceDigest
        && existing.selectedGeneration === input.winnerGeneration
      ) {
        return replayValue(snapshot.value, existing);
      }
      return { kind: 'Rejected', error: runtimeError('E_RECOVERY_FORK_ALREADY_RESOLVED', 'Recovery fork is already resolved') };
    }
    if (snapshot.value.revision !== input.expectedRevision) {
      return { kind: 'Rejected', error: runtimeError('E_REVISION_CONFLICT', 'Recovery aggregate revision changed', {
        expectedRevision: input.expectedRevision,
        actualRevision: snapshot.value.revision,
      }) };
    }
    const evidence = validateEvidence(input, snapshot.value);
    if (!evidence.ok) return { kind: 'Rejected', error: evidence.error };
    const freshClaimToken = context.tokenFactory?.() ?? randomToken();
    const resolution: RecoveryForkResolutionRecordV1 = {
      schemaVersion: 1,
      operationNonce: input.evidence.operationNonce,
      evidenceDigest,
      selectedGeneration: input.winnerGeneration,
      selectionRevision: input.expectedRevision + 1,
      freshClaimToken,
      freshClaimTokenDigest: sha256(freshClaimToken),
    };
    const committed = await this.store.compareAndSwap(this.key, input.expectedRevision, (current) => ({
      ...current,
      canonicalGeneration: input.winnerGeneration,
      fork: {
        ...current.fork,
        status: 'selected',
        resolution,
        candidates: current.fork.candidates.map((candidate) => candidate.generation === input.winnerGeneration
          ? { ...candidate, status: 'selected', claimTokenDigest: resolution.freshClaimTokenDigest }
          : { ...candidate, status: 'fenced_superseded' }),
      },
    }));
    if (!committed.ok) return { kind: 'Rejected', error: committed.error };
    return {
      kind: 'Selected',
      aggregate: committed.value.value,
      revision: committed.value.revision,
      resolution,
    };
  }
}

export function digestRecoverySelectionEvidence(evidence: RecoveryForkSelectionEvidenceV1): string {
  const { artifactDigest: _artifactDigest, ...unsigned } = evidence;
  return sha256(canonicalJson(unsigned));
}

export function assertRecoveryWriteAuthority(
  aggregate: Readonly<RecoveryTaskAggregateV1>,
  generation: number,
  claimToken: string,
): Result<void, RuntimeError> {
  if (
    aggregate.fork.status !== 'selected'
    || aggregate.canonicalGeneration !== generation
    || aggregate.fork.resolution?.freshClaimTokenDigest !== sha256(claimToken)
  ) {
    return err(runtimeError('E_RECOVERY_FORK_FENCED', 'Recovery fork generation or claim token is fenced', {
      generation,
      canonicalGeneration: aggregate.canonicalGeneration,
    }));
  }
  return ok(undefined);
}

function validateLeader(
  aggregate: Readonly<RecoveryTaskAggregateV1>,
  context: Readonly<RuntimeContext>,
): Result<void, RuntimeError> {
  const actor = context.actor;
  if (
    actor?.kind !== 'leader'
    || actor.teamId !== aggregate.teamId
    || actor.repoKey !== aggregate.repoKey
    || actor.workspaceKey !== aggregate.leaderWorkspaceKey
    || actor.ownerNonce !== aggregate.ownerNonce
    || canonicalJson(actor.worktree) !== canonicalJson(aggregate.leaderWorktree)
  ) {
    return err(runtimeError('E_TEAM_LEADER_REQUIRED', 'Recovery fork resolution requires the current canonical Team leader'));
  }
  return ok(undefined);
}

function validateEvidence(
  input: Readonly<ResolveRecoveryForkInput>,
  snapshot: Readonly<Snapshot<RecoveryTaskAggregateV1>>,
): Result<void, RuntimeError> {
  const evidence = input.evidence;
  const aggregate = snapshot.value;
  if (
    evidence.schemaVersion !== 1
    || evidence.forkId !== input.forkId
    || evidence.forkId !== aggregate.fork.forkId
    || evidence.taskId !== aggregate.taskId
    || evidence.expectedAggregateRevision !== input.expectedRevision
    || evidence.selectedGeneration !== input.winnerGeneration
    || evidence.reason.trim() === ''
    || evidence.artifactDigest !== digestRecoverySelectionEvidence(evidence)
    || canonicalJson(evidence.candidates) !== canonicalJson(aggregate.fork.candidates)
    || canonicalJson(evidence.leaderActor) !== canonicalJson({
      teamId: aggregate.teamId,
      repoKey: aggregate.repoKey,
      workspaceKey: aggregate.leaderWorkspaceKey,
      ownerNonce: aggregate.ownerNonce,
      worktree: aggregate.leaderWorktree,
    })
    || !aggregate.fork.candidates.some((candidate) => candidate.generation === input.winnerGeneration)
  ) {
    return err(runtimeError('E_RECOVERY_FORK_UNRESOLVED', 'Recovery fork selection evidence does not match authoritative state'));
  }
  return ok(undefined);
}

function replayValue(
  snapshot: Readonly<Snapshot<RecoveryTaskAggregateV1>>,
  resolution: RecoveryForkResolutionRecordV1,
): RecoveryForkResolveResult {
  return {
    kind: 'Replayed',
    aggregate: snapshot.value,
    revision: snapshot.revision,
    resolution,
  };
}

function randomToken(): string {
  // 設計概念映射：claim token 為 capability；必須用 CSPRNG，不可 Math.random
  return crypto.randomBytes(32).toString('hex');
}

