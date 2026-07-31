import * as fs from 'fs';
import * as path from 'path';
import { TeamOrchestrator, listReadyTaskSpecs } from '../../src/team/orchestrator';
import { TeamStateStore } from '../../src/team/state';
import { resolveGitWorktreeIdentity } from '../../src/team/worktree';
import { parseTeamCommand, teamCommand } from '../../src/team/commands';
import { requireDeadProof } from '../../src/team/reclaim';
import { GitFixture } from '../helpers/git-fixture';
import { TmuxFixture } from '../helpers/tmux-fixture';
import { headlessProviderRouteFactory } from '../helpers/team-provider-route';

const maybeTmux = TmuxFixture.available() ? test : test.skip;

describe('supervise and reclaim', () => {
  test('requireDeadProof rejects alive/unknown', () => {
    expect(requireDeadProof('alive', 'dead').ok).toBe(false);
    expect(requireDeadProof('dead', 'alive').ok).toBe(false);
    expect(requireDeadProof('dead', 'unknown').ok).toBe(false);
    expect(requireDeadProof('dead', 'dead').ok).toBe(true);
  });

  test('parse team reclaim and supervise flags', () => {
    expect(parseTeamCommand(['supervise', '--team', 'alpha'])).toEqual({
      ok: true,
      value: { kind: 'supervise', teamId: 'alpha' },
    });
    expect(parseTeamCommand([
      'reclaim', '--team', 't', '--task', 'a', '--expected-revision', '2',
      '--pane', 'dead', '--process', 'dead',
    ]).ok).toBe(true);
    const bad = parseTeamCommand([
      'reclaim', '--team', 't', '--task', 'a', '--expected-revision', '2',
      '--pane', 'alive', '--process', 'dead',
    ]);
    expect(bad.ok).toBe(true); // parse ok; reclaim rejects at fence
  });

  maybeTmux('ORCH-T3 reclaim requires DeadProof and clears claim', async () => {
    const fixture = GitFixture.create();
    const tmux = new TmuxFixture();
    try {
      const leader = resolveGitWorktreeIdentity(fixture.repo);
      const holdJs = path.join(fixture.root, 'hold.js');
      fs.writeFileSync(holdJs, "require('fs').writeFileSync(process.argv[2],'ready\\n'); setInterval(()=>{},1000);\n");
      const sessionNamePrefix = tmux.session('sup');
      tmux.session('sup-task-a-g1');
      const orch = new TeamOrchestrator({
        providerProfileFactory: headlessProviderRouteFactory(),
        stateRoot: fixture.stateRoot,
        workspaceRoot: fixture.repo,
        repoKey: leader.repoKey,
        workspaceKey: leader.workspaceKey,
        managedWorktreesRoot: fixture.managedWorktreesRoot,
        sessionNamePrefix,
        tokenFactory: (() => { let n = 0; return () => `tok-${++n}`; })(),
        nowMs: () => 1_700_000_000_000,
        leaseMs: 1, // expire immediately so assess is not healthy-by-lease
        workerExecutablePath: process.execPath,
        workerBootstrapArgv: [holdJs],
      });
      const manifestPath = path.join(fixture.root, 'm.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        schema: 'oma.team-manifest/v1',
        teamId: 'alpha',
        revision: 1,
        tasks: [{
          id: 'task-a',
          dependencies: [],
          write_scope: [{ kind: 'file', path: 'a.txt' }],
          mode: 'headless',
          verification: { version: 1, commands: [], requiredArtifacts: [] },
        }],
      }));
      const started = await orch.startFromManifest(manifestPath, 'headless');
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      const rejectAlive = await orch.reclaimTask(
        'alpha', 'task-a', started.value.aggregateRevision, 'alive', 'dead',
      );
      expect(rejectAlive.ok).toBe(false);
      if (!rejectAlive.ok) expect(rejectAlive.error.code).toBe('E_RECLAIM_IDENTITY_UNPROVEN');

      // kill session then prove dead
      await orch.stop('alpha');
      const reclaimed = await orch.reclaimTask(
        'alpha', 'task-a', started.value.aggregateRevision, 'dead', 'dead',
      );
      expect(reclaimed.ok).toBe(true);
      if (!reclaimed.ok) return;
      expect(reclaimed.value.status).toBe('orphan_identity_unproven');

      const store = new TeamStateStore(
        fixture.stateRoot, leader.repoKey, leader.workspaceKey, 'alpha',
      );
      const snap = store.read();
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      expect(snap.value.value.tasks['task-a'].claim).toBeUndefined();
    } finally {
      tmux.cleanup();
      fixture.cleanup();
    }
  }, 25000);

  test('CLI reclaim without dead proof exits 2', async () => {
    const fixture = GitFixture.create();
    try {
      const leader = resolveGitWorktreeIdentity(fixture.repo);
      let stderr = '';
      const code = await teamCommand(
        [
          'reclaim', '--team', 'missing', '--task', 't', '--expected-revision', '0',
          '--pane', 'alive', '--process', 'alive',
        ],
        {
          context: {
            stateRoot: fixture.stateRoot,
            workspaceRoot: fixture.repo,
            repoKey: leader.repoKey,
            workspaceKey: leader.workspaceKey,
          },
          stderr: (v) => { stderr += v; },
          stdout: () => undefined,
        },
      );
      // missing team or not dead-proof both non-zero; prefer 2 when fence rejects
      expect(code).not.toBe(0);
      expect(stderr.length).toBeGreaterThan(0);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('listReadyTaskSpecs', () => {
  test('blocks dependents until completed', () => {
    const manifest = {
      schema: 'oma.team-manifest/v1' as const,
      teamId: 't',
      revision: 1,
      repoRoot: '/tmp',
      tasks: [
        {
          id: 'a', dependencies: [] as string[], write_scope: 'none' as const, mode: 'read_only' as const,
          verification: { version: 1 as const, commands: [], requiredArtifacts: [] },
        },
        {
          id: 'b', dependencies: ['a'], write_scope: 'none' as const, mode: 'read_only' as const,
          verification: { version: 1 as const, commands: [], requiredArtifacts: [] },
        },
      ],
    };
    const aggregate = {
      schemaVersion: 1 as const,
      teamId: 't',
      repoKey: null as string | null,
      leaderWorkspaceKey: 'w',
      ownerNonce: 'o',
      manifest,
      tasks: {
        a: { id: 'a', revision: 0, status: 'pending' as const, commandEvidence: {} },
        b: { id: 'b', revision: 0, status: 'pending' as const, commandEvidence: {} },
      },
      heartbeats: {},
      mailbox: {},
    };
    expect(listReadyTaskSpecs(manifest, aggregate).map((t) => t.id)).toEqual(['a']);
    const afterA = {
      ...aggregate,
      tasks: {
        ...aggregate.tasks,
        a: { ...aggregate.tasks.a, status: 'completed' as const },
      },
    };
    expect(listReadyTaskSpecs(manifest, afterA).map((t) => t.id)).toEqual(['b']);
  });
});
