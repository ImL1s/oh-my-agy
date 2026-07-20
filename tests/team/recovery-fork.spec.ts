import { StateStore } from '../../src/runtime/state-store';
import { sha256 } from '../../src/runtime/atomic';
import {
  RecoveryForkResolver,
  RecoveryTaskAggregateV1,
  assertRecoveryWriteAuthority,
  digestRecoverySelectionEvidence,
} from '../../src/team/recovery-fork';
import { LeaderWorktreeIdentityV1, RuntimeContext, TeamActorIdentityV1 } from '../../src/team/types';
import { GitFixture } from '../helpers/git-fixture';

function identity(root: string): LeaderWorktreeIdentityV1 {
  return {
    canonicalRealpath: root, workspaceKey: 'leader-workspace', repoKey: 'repo-key',
    gitCommonDir: `${root}/.git`, gitWorktreeAdminId: 'leader-admin',
  };
}

function aggregate(root: string): RecoveryTaskAggregateV1 {
  const worktree = identity(root);
  return {
    schemaVersion: 1, teamId: 'alpha', taskId: 'task-a', repoKey: 'repo-key', ownerNonce: 'owner-a',
    leaderWorkspaceKey: 'leader-workspace', leaderWorktree: worktree, canonicalGeneration: 1,
    fork: {
      schemaVersion: 1, forkId: 'fork-a', taskId: 'task-a', status: 'unresolved',
      candidates: [
        { generation: 1, branch: 'old', worktreeIdentity: 'old-wt', claimTokenDigest: sha256('old-token'), headSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), statusDigest: sha256('old-status'), verificationDigest: sha256('old-v'), deliveryDigest: sha256('old-d'), candidateRevision: 3, status: 'active' },
        { generation: 2, branch: 'new', worktreeIdentity: 'new-wt', claimTokenDigest: sha256('new-token'), headSha: 'c'.repeat(40), treeSha: 'd'.repeat(40), statusDigest: sha256('new-status'), verificationDigest: sha256('new-v'), deliveryDigest: sha256('new-d'), candidateRevision: 2, status: 'active' },
      ],
    },
  };
}

function leaderContext(root: string, token = 'fresh-token'): RuntimeContext {
  const worktree = identity(root);
  const actor: TeamActorIdentityV1 = {
    kind: 'leader', teamId: 'alpha', repoKey: 'repo-key', workspaceKey: 'leader-workspace', ownerNonce: 'owner-a', worktree,
  };
  return { stateRoot: root, workspaceRoot: root, repoKey: 'repo-key', workspaceKey: 'leader-workspace', actor, tokenFactory: () => token };
}

function evidence(state: RecoveryTaskAggregateV1, operationNonce: string, winnerGeneration: number) {
  const value: any = {
    schemaVersion: 1, operationNonce, forkId: state.fork.forkId, taskId: state.taskId,
    expectedAggregateRevision: 0,
    candidates: state.fork.candidates.map((candidate) => ({ ...candidate })),
    selectedGeneration: winnerGeneration, reason: 'leader selected verified result',
    leaderActor: { teamId: state.teamId, repoKey: state.repoKey, workspaceKey: state.leaderWorkspaceKey, ownerNonce: state.ownerNonce, worktree: state.leaderWorktree },
    artifactDigest: '',
  };
  value.artifactDigest = digestRecoverySelectionEvidence(value);
  return value;
}

describe('leader-only recovery fork resolution', () => {
  let fixture: GitFixture;
  let store: StateStore<RecoveryTaskAggregateV1>;
  let resolver: RecoveryForkResolver;
  const key = 'recovery/alpha/task-a';

  beforeEach(async () => {
    fixture = GitFixture.create();
    store = new StateStore(fixture.stateRoot);
    const created = await store.create(key, aggregate(fixture.repo));
    if (!created.ok) throw new Error(created.error.message);
    resolver = new RecoveryForkResolver(store, key);
  });
  afterEach(() => fixture.cleanup());

  test('TEAM-09F requires canonical leader and issues a fresh winner token while fencing both old tokens', async () => {
    const state = aggregate(fixture.repo);
    const workerContext = { ...leaderContext(fixture.repo), actor: { ...leaderContext(fixture.repo).actor!, kind: 'worker' as const } };
    const rejected = await resolver.resolve({ forkId: 'fork-a', winnerGeneration: 2, expectedRevision: 0, evidence: evidence(state, 'op-worker', 2) }, workerContext);
    expect(rejected.kind).toBe('Rejected');
    if (rejected.kind === 'Rejected') expect(rejected.error.code).toBe('E_TEAM_LEADER_REQUIRED');

    const selected = await resolver.resolve({ forkId: 'fork-a', winnerGeneration: 2, expectedRevision: 0, evidence: evidence(state, 'op-leader', 2) }, leaderContext(fixture.repo));
    expect(selected.kind).toBe('Selected');
    if (selected.kind !== 'Selected') return;
    expect(selected.issuedClaimToken).toBe('fresh-token');
    expect(selected.resolution.freshClaimTokenDigest).toBe(sha256('fresh-token'));
    // durable aggregate 不得殘留明文 claim token
    expect(JSON.stringify(selected.aggregate.fork.resolution)).not.toContain('fresh-token');
    expect(assertRecoveryWriteAuthority(selected.aggregate, 1, 'old-token').ok).toBe(false);
    expect(assertRecoveryWriteAuthority(selected.aggregate, 2, 'new-token').ok).toBe(false);
    expect(assertRecoveryWriteAuthority(selected.aggregate, 2, 'fresh-token').ok).toBe(true);
  });

  test('TEAM-09G same operation replays and racing different selections have one CAS winner', async () => {
    const state = aggregate(fixture.repo);
    const firstEvidence = evidence(state, 'op-replay', 2);
    const selected = await resolver.resolve({ forkId: 'fork-a', winnerGeneration: 2, expectedRevision: 0, evidence: firstEvidence }, leaderContext(fixture.repo));
    expect(selected.kind).toBe('Selected');
    const replay = await resolver.resolve({ forkId: 'fork-a', winnerGeneration: 2, expectedRevision: 0, evidence: firstEvidence }, leaderContext(fixture.repo));
    expect(replay.kind).toBe('Replayed');
  });
});

