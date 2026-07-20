import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '../../src/runtime/atomic';
import { StateStore } from '../../src/runtime/state-store';
import { parseTeamCommand, teamCommand } from '../../src/team/commands';
import {
  RecoveryTaskAggregateV1,
  digestRecoverySelectionEvidence,
} from '../../src/team/recovery-fork';
import { resolveGitWorktreeIdentity } from '../../src/team/worktree';
import { RuntimeContext } from '../../src/team/types';
import { GitFixture } from '../helpers/git-fixture';

function aggregate(root: string): RecoveryTaskAggregateV1 {
  const worktree = resolveGitWorktreeIdentity(root);
  return {
    schemaVersion: 1,
    teamId: 'alpha',
    taskId: 'task-a',
    repoKey: worktree.repoKey,
    ownerNonce: 'owner-a',
    leaderWorkspaceKey: worktree.workspaceKey,
    leaderWorktree: worktree,
    canonicalGeneration: 1,
    fork: {
      schemaVersion: 1,
      forkId: 'fork-a',
      taskId: 'task-a',
      status: 'unresolved',
      candidates: [
        {
          generation: 1, branch: 'old', worktreeIdentity: 'old-wt',
          claimTokenDigest: sha256('old-token'), headSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
          statusDigest: sha256('old-status'), verificationDigest: sha256('old-v'),
          deliveryDigest: sha256('old-d'), candidateRevision: 3, status: 'active',
        },
        {
          generation: 2, branch: 'new', worktreeIdentity: 'new-wt',
          claimTokenDigest: sha256('new-token'), headSha: 'c'.repeat(40), treeSha: 'd'.repeat(40),
          statusDigest: sha256('new-status'), verificationDigest: sha256('new-v'),
          deliveryDigest: sha256('new-d'), candidateRevision: 2, status: 'active',
        },
      ],
    },
  };
}

describe('typed teamCommand surface', () => {
  test('parseTeamCommand preserves resolve-fork flags without reinterpretation', () => {
    expect(parseTeamCommand([
      'resolve-fork', '--team', 't1', '--fork', 'f1', '--winner-generation', '2',
      '--expected-revision', '9', '--evidence', '/tmp/selection.json',
    ])).toEqual({
      ok: true,
      value: {
        kind: 'resolve-fork',
        teamId: 't1',
        forkId: 'f1',
        winnerGeneration: 2,
        expectedRevision: 9,
        evidencePath: '/tmp/selection.json',
      },
    });
  });

  test('teamCommand resolve-fork proves leader via caller worktree (no actor injection)', async () => {
    const fixture = GitFixture.create();
    try {
      const store = new StateStore<RecoveryTaskAggregateV1>(fixture.stateRoot);
      const state = aggregate(fixture.repo);
      const created = await store.create('recovery/alpha/task-a', state);
      if (!created.ok) throw new Error(created.error.message);

      const evidence: any = {
        schemaVersion: 1,
        operationNonce: 'op-cli',
        forkId: 'fork-a',
        taskId: 'task-a',
        expectedAggregateRevision: 0,
        candidates: state.fork.candidates.map((candidate) => ({ ...candidate })),
        selectedGeneration: 2,
        reason: 'leader selected verified result',
        leaderActor: {
          teamId: state.teamId,
          repoKey: state.repoKey,
          workspaceKey: state.leaderWorkspaceKey,
          ownerNonce: state.ownerNonce,
          worktree: state.leaderWorktree,
        },
        artifactDigest: '',
      };
      evidence.artifactDigest = digestRecoverySelectionEvidence(evidence);
      const evidencePath = path.join(fixture.root, 'selection.json');
      fs.writeFileSync(evidencePath, JSON.stringify(evidence));

      let stdout = '';
      let stderr = '';
      const context: RuntimeContext = {
        stateRoot: fixture.stateRoot,
        workspaceRoot: fixture.repo,
        repoKey: null,
        workspaceKey: 'unrelated-label',
        tokenFactory: () => 'fresh-from-cli',
      };

      const code = await teamCommand([
        'resolve-fork',
        '--team', 'alpha',
        '--fork', 'fork-a',
        '--winner-generation', '2',
        '--expected-revision', '0',
        '--evidence', evidencePath,
      ], {
        context,
        storeRoot: fixture.stateRoot,
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
      });

      expect(stderr).toBe('');
      expect(code).toBe(0);
      const payload = JSON.parse(stdout);
      expect(payload).toEqual(expect.objectContaining({
        ok: true,
        kind: 'Selected',
        forkId: 'fork-a',
        selectedGeneration: 2,
        freshClaimTokenDigest: sha256('fresh-from-cli'),
        issuedClaimToken: 'fresh-from-cli',
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test('non-leader cwd is rejected even with durable recovery state', async () => {
    const fixture = GitFixture.create();
    const other = GitFixture.create();
    try {
      const store = new StateStore<RecoveryTaskAggregateV1>(fixture.stateRoot);
      const state = aggregate(fixture.repo);
      await store.create('recovery/alpha/task-a', state);
      const evidence: any = {
        schemaVersion: 1,
        operationNonce: 'op-nonleader',
        forkId: 'fork-a',
        taskId: 'task-a',
        expectedAggregateRevision: 0,
        candidates: state.fork.candidates.map((candidate) => ({ ...candidate })),
        selectedGeneration: 2,
        reason: 'non-leader should fail',
        leaderActor: {
          teamId: state.teamId,
          repoKey: state.repoKey,
          workspaceKey: state.leaderWorkspaceKey,
          ownerNonce: state.ownerNonce,
          worktree: state.leaderWorktree,
        },
        artifactDigest: '',
      };
      evidence.artifactDigest = digestRecoverySelectionEvidence(evidence);
      const evidencePath = path.join(fixture.root, 'nonleader.json');
      fs.writeFileSync(evidencePath, JSON.stringify(evidence));
      let stderr = '';
      const code = await teamCommand([
        'resolve-fork',
        '--team', 'alpha',
        '--fork', 'fork-a',
        '--winner-generation', '2',
        '--expected-revision', '0',
        '--evidence', evidencePath,
      ], {
        context: {
          stateRoot: fixture.stateRoot,
          workspaceRoot: other.repo, // different git worktree
          repoKey: null,
          workspaceKey: 'other',
        },
        storeRoot: fixture.stateRoot,
        stdout: () => undefined,
        stderr: (value) => { stderr += value; },
      });
      expect(code).toBe(1);
      expect(stderr).toContain('E_TEAM_LEADER_REQUIRED');
    } finally {
      fixture.cleanup();
      other.cleanup();
    }
  });
});
