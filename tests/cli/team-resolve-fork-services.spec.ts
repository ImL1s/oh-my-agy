import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '../../src/runtime/atomic';
import { StateStore } from '../../src/runtime/state-store';
import { createDefaultServices } from '../../src/cli/services';
import {
  RecoveryTaskAggregateV1,
  digestRecoverySelectionEvidence,
} from '../../src/team/recovery-fork';
import { resolveGitWorktreeIdentity } from '../../src/team/worktree';
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

describe('createDefaultServices team resolve-fork (shipped path)', () => {
  test('Selected without injected actor when caller is canonical leader worktree', async () => {
    const fixture = GitFixture.create();
    try {
      const store = new StateStore<RecoveryTaskAggregateV1>(fixture.stateRoot);
      const state = aggregate(fixture.repo);
      const created = await store.create('recovery/alpha/task-a', state);
      if (!created.ok) throw new Error(created.error.message);

      const evidence: any = {
        schemaVersion: 1,
        operationNonce: 'op-services-cli',
        forkId: 'fork-a',
        taskId: 'task-a',
        expectedAggregateRevision: 0,
        candidates: state.fork.candidates.map((candidate) => ({ ...candidate })),
        selectedGeneration: 2,
        reason: 'leader selected verified result via shipped services',
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
      const services = createDefaultServices({
        stateRoot: fixture.stateRoot,
        cwd: fixture.repo,
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
      });

      const code = await services.teamCommand([
        'resolve-fork',
        '--team', 'alpha',
        '--fork', 'fork-a',
        '--winner-generation', '2',
        '--expected-revision', '0',
        '--evidence', evidencePath,
      ]);

      expect(stderr).toBe('');
      expect(code).toBe(0);
      const payload = JSON.parse(stdout);
      expect(payload).toEqual(expect.objectContaining({
        ok: true,
        kind: 'Selected',
        forkId: 'fork-a',
        selectedGeneration: 2,
      }));
      expect(typeof payload.freshClaimTokenDigest).toBe('string');
      expect(payload.freshClaimTokenDigest).toHaveLength(64);
      expect(typeof payload.issuedClaimToken).toBe('string');
      expect(payload.issuedClaimToken.length).toBeGreaterThan(16);
    } finally {
      fixture.cleanup();
    }
  });

  test('missing recovery state fails closed without inventing a leader', async () => {
    const fixture = GitFixture.create();
    try {
      let stdout = '';
      let stderr = '';
      const services = createDefaultServices({
        stateRoot: fixture.stateRoot,
        cwd: fixture.repo,
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
      });
      const worktree = resolveGitWorktreeIdentity(fixture.repo);
      const evidencePath = path.join(fixture.root, 'empty-selection.json');
      fs.writeFileSync(evidencePath, JSON.stringify({
        schemaVersion: 1,
        operationNonce: 'x',
        forkId: 'fork-a',
        taskId: 'task-a',
        expectedAggregateRevision: 0,
        candidates: [],
        selectedGeneration: 2,
        reason: 'no state',
        leaderActor: {
          teamId: 'alpha',
          repoKey: worktree.repoKey,
          workspaceKey: worktree.workspaceKey,
          ownerNonce: 'owner-a',
          worktree,
        },
        artifactDigest: '0'.repeat(64),
      }));
      const code = await services.teamCommand([
        'resolve-fork',
        '--team', 'alpha',
        '--fork', 'fork-a',
        '--winner-generation', '2',
        '--expected-revision', '0',
        '--evidence', evidencePath,
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain('E_NOT_FOUND');
      expect(stdout).toBe('');
    } finally {
      fixture.cleanup();
    }
  });
});
