import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '../../src/runtime/atomic';
import { StateStore } from '../../src/runtime/state-store';
import { parseTeamCommand, teamCommand } from '../../src/team/commands';
import { TeamOrchestrator } from '../../src/team/orchestrator';
import {
  RecoveryTaskAggregateV1,
  digestRecoverySelectionEvidence,
} from '../../src/team/recovery-fork';
import { resolveGitWorktreeIdentity } from '../../src/team/worktree';
import { RuntimeContext } from '../../src/team/types';
import { GitFixture } from '../helpers/git-fixture';
import { TmuxFixture } from '../helpers/tmux-fixture';
import {
  HostIdentityV1,
  PluginIdentityV1,
  assembleHostCapabilityProfile,
} from '../../src/native/capability-profile';

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
  test('team start defaults to the profile-routable headless mode', () => {
    expect(parseTeamCommand(['start', '--manifest', 'team.json'])).toEqual({
      ok: true,
      value: {
        kind: 'start',
        manifestPath: 'team.json',
        workerMode: 'headless',
      },
    });
  });

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

  test('parseTeamCommand accepts status and stop', () => {
    expect(parseTeamCommand(['status', '--team', 'alpha'])).toEqual({
      ok: true,
      value: { kind: 'status', teamId: 'alpha' },
    });
    expect(parseTeamCommand(['stop', '--team', 'alpha'])).toEqual({
      ok: true,
      value: { kind: 'stop', teamId: 'alpha' },
    });
  });

  const maybeTmux = TmuxFixture.available() ? test : test.skip;

  maybeTmux('teamCommand start creates tmux worker (not manifest-validated stub)', async () => {
    const fixture = GitFixture.create();
    const tmux = new TmuxFixture();
    try {
      const leader = resolveGitWorktreeIdentity(fixture.repo);
      const manifestPath = path.join(fixture.root, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        schema: 'oma.team-manifest/v1',
        teamId: 'cli-team',
        revision: 1,
        tasks: [{
          id: 't1',
          dependencies: [],
          write_scope: [{ kind: 'file', path: 't1.txt' }],
          mode: 'headless',
          verification: { version: 1, commands: [], requiredArtifacts: [] },
        }],
      }));

      const holdJs = path.join(fixture.root, 'hold.js');
      fs.writeFileSync(
        holdJs,
        "require('fs').writeFileSync(process.argv[2],'ready\\n'); setInterval(()=>{},1000);\n",
      );

      const sessionNamePrefix = tmux.session('cli');
      // 預先登記衍生 session 供 fixture cleanup
      tmux.session('cli-t1-g1');

      const makeOrch = (ctx: RuntimeContext) => new TeamOrchestrator({
        stateRoot: ctx.stateRoot,
        workspaceRoot: ctx.workspaceRoot,
        repoKey: ctx.repoKey,
        workspaceKey: ctx.workspaceKey,
        managedWorktreesRoot: fixture.managedWorktreesRoot,
        sessionNamePrefix,
        tokenFactory: ctx.tokenFactory ?? (() => {
          let i = 0;
          return () => `cli-tok-${++i}`;
        })(),
        workerExecutablePath: process.execPath,
        workerBootstrapArgv: [holdJs],
        providerProfileFactory: ({ selectedAt }) => {
          const host: HostIdentityV1 = {
            realpath: '/opt/agy', binarySha256: sha256('binary'), version: null,
            versionOutputSha256: sha256('version'), helpOutputSha256: sha256('help'),
            platform: 'darwin', arch: 'arm64',
          };
          const plugin: PluginIdentityV1 = {
            status: 'present', realpath: '/opt/plugin', packageDigest: sha256('plugin'),
            version: '1', readbackDigest: sha256('readback'), enabled: true,
          };
          const empty = assembleHostCapabilityProfile({ evaluationTimestamp: selectedAt, hostIdentityBefore: host, hostIdentityAfter: host, pluginIdentityBefore: plugin, pluginIdentityAfter: plugin, observations: [] });
          const profile = assembleHostCapabilityProfile({
            evaluationTimestamp: selectedAt, hostIdentityBefore: host, hostIdentityAfter: host,
            pluginIdentityBefore: plugin, pluginIdentityAfter: plugin,
            observations: ['headless.print', 'headless.json'].map((capability) => ({ capability, source: 'live_probe' as const, tier: 'healthy' as const, result: 'positive' as const, observedAt: selectedAt, identityDigest: empty.identityDigest, detailCode: 'TEST_OK', diagnostic: null })),
          });
          return { ok: true, value: {
            profile,
            resolvedExecutable: '/opt/agy',
          } };
        },
      });

      let stdout = '';
      let stderr = '';
      const context: RuntimeContext = {
        stateRoot: fixture.stateRoot,
        workspaceRoot: fixture.repo,
        repoKey: leader.repoKey,
        workspaceKey: leader.workspaceKey,
        tokenFactory: (() => {
          let i = 0;
          return () => `cli-tok-${++i}`;
        })(),
      };

      const code = await teamCommand(
        ['start', '--manifest', manifestPath, '--worker-mode', 'headless'],
        {
          context,
          stdout: (value) => { stdout += value; },
          stderr: (value) => { stderr += value; },
          orchestratorFactory: makeOrch,
        },
      );
      expect(stderr).toBe('');
      expect(code).toBe(0);
      const body = JSON.parse(stdout);
      expect(body.ok).toBe(true);
      expect(body.kind).toBe('team-started');
      expect(body.workers).toHaveLength(1);
      expect(body.note).toBeUndefined();
      expect(tmux.hasSession(body.workers[0].sessionName)).toBe(true);

      let statusOut = '';
      const statusCode = await teamCommand(
        ['status', '--team', 'cli-team'],
        {
          context,
          stdout: (value) => { statusOut += value; },
          stderr: (value) => { stderr += value; },
          orchestratorFactory: makeOrch,
        },
      );
      expect(statusCode).toBe(0);
      const statusBody = JSON.parse(statusOut);
      expect(statusBody.kind).toBe('team-status');
      expect(statusBody.tasks.t1.status).toBe('in_progress');

      const stopCode = await teamCommand(
        ['stop', '--team', 'cli-team'],
        {
          context,
          stdout: () => undefined,
          stderr: (value) => { stderr += value; },
          orchestratorFactory: makeOrch,
        },
      );
      expect(stopCode).toBe(0);
      expect(tmux.hasSession(body.workers[0].sessionName)).toBe(false);
    } finally {
      tmux.cleanup();
      fixture.cleanup();
    }
  }, 20_000);
});
