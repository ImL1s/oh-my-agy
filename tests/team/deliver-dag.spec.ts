import * as fs from 'fs';
import * as path from 'path';
import { TeamOrchestrator } from '../../src/team/orchestrator';
import { TeamStateStore } from '../../src/team/state';
import { resolveGitWorktreeIdentity } from '../../src/team/worktree';
import { GitFixture } from '../helpers/git-fixture';
import { TmuxFixture } from '../helpers/tmux-fixture';
import { headlessProviderRouteFactory } from '../helpers/team-provider-route';

const maybeTmux = TmuxFixture.available() ? test : test.skip;

describe('deliver and DAG tick', () => {
  maybeTmux('ORCH-T4 deliver write task to completed via real git', async () => {
    const fixture = GitFixture.create();
    const tmux = new TmuxFixture();
    try {
      const leader = resolveGitWorktreeIdentity(fixture.repo);
      const holdJs = path.join(fixture.root, 'hold.js');
      fs.writeFileSync(holdJs, "require('fs').writeFileSync(process.argv[2],'ready\\n'); setInterval(()=>{},1000);\n");
      fs.mkdirSync(path.join(fixture.repo, 'src'), { recursive: true });
      fixture.git(['add', 'src']);
      // ensure src exists on base
      fs.writeFileSync(path.join(fixture.repo, 'src', '.keep'), '');
      fixture.git(['add', 'src/.keep']);
      fixture.git(['commit', '-m', 'src keep']);

      const sessionNamePrefix = tmux.session('del');
      tmux.session('del-task-a-g1');
      const orch = new TeamOrchestrator({
        providerProfileFactory: headlessProviderRouteFactory(),
        stateRoot: fixture.stateRoot,
        workspaceRoot: fixture.repo,
        repoKey: leader.repoKey,
        workspaceKey: leader.workspaceKey,
        managedWorktreesRoot: fixture.managedWorktreesRoot,
        sessionNamePrefix,
        tokenFactory: (() => { let n = 0; return () => `d-tok-${++n}`; })(),
        workerExecutablePath: process.execPath,
        workerBootstrapArgv: [holdJs],
      });
      const manifestPath = path.join(fixture.root, 'm.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        schema: 'oma.team-manifest/v1',
        teamId: 'del-team',
        revision: 1,
        tasks: [{
          id: 'task-a',
          dependencies: [],
          write_scope: [{ kind: 'dir', path: 'src' }],
          mode: 'headless',
          verification: { version: 1, commands: [], requiredArtifacts: [] },
        }],
      }));
      const started = await orch.startFromManifest(manifestPath, 'headless');
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const worker = started.value.workers[0];
      const commit = fixture.commitFile('src/feature.txt', 'feature\n', 'feature', worker.worktreePath);
      expect(commit).toBeTruthy();

      const delivered = await orch.deliverTask({
        teamId: 'del-team',
        taskId: 'task-a',
        expectedRevision: started.value.aggregateRevision,
        claimToken: worker.claimToken,
        generation: worker.generation,
        worktreePath: worker.worktreePath,
      });
      expect(delivered.ok).toBe(true);
      if (!delivered.ok) {
        // eslint-disable-next-line no-console
        console.error(delivered.error);
        return;
      }
      expect(delivered.value.status).toBe('completed');
      expect(fs.readFileSync(path.join(fixture.repo, 'src/feature.txt'), 'utf8')).toBe('feature\n');

      await orch.stop('del-team');
    } finally {
      tmux.cleanup();
      fixture.cleanup();
    }
  }, 40000);

  maybeTmux('ORCH-T5 tick starts B after A completed', async () => {
    const fixture = GitFixture.create();
    const tmux = new TmuxFixture();
    try {
      const leader = resolveGitWorktreeIdentity(fixture.repo);
      const holdJs = path.join(fixture.root, 'hold.js');
      fs.writeFileSync(holdJs, "require('fs').writeFileSync(process.argv[2],'ready\\n'); setInterval(()=>{},1000);\n");
      const sessionNamePrefix = tmux.session('dag');
      // pre-register possible session names
      tmux.session('dag-a-g1');
      tmux.session('dag-b-g1');

      const orch = new TeamOrchestrator({
        providerProfileFactory: headlessProviderRouteFactory(),
        stateRoot: fixture.stateRoot,
        workspaceRoot: fixture.repo,
        repoKey: leader.repoKey,
        workspaceKey: leader.workspaceKey,
        managedWorktreesRoot: fixture.managedWorktreesRoot,
        sessionNamePrefix,
        maxParallelWorkers: 1,
        tokenFactory: (() => { let n = 0; return () => `g-tok-${++n}`; })(),
        workerExecutablePath: process.execPath,
        workerBootstrapArgv: [holdJs],
      });
      const manifestPath = path.join(fixture.root, 'm.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        schema: 'oma.team-manifest/v1',
        teamId: 'dag',
        revision: 1,
        tasks: [
          {
            id: 'a',
            dependencies: [],
            write_scope: 'none',
            mode: 'read_only',
            verification: { version: 1, commands: [], requiredArtifacts: [] },
          },
          {
            id: 'b',
            dependencies: ['a'],
            write_scope: 'none',
            mode: 'read_only',
            verification: { version: 1, commands: [], requiredArtifacts: [] },
          },
        ],
      }));
      const started = await orch.startFromManifest(manifestPath, 'headless');
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.value.workers).toHaveLength(1);
      expect(started.value.workers[0].taskId).toBe('a');

      // complete A via store (read_only path)
      const store = new TeamStateStore(fixture.stateRoot, leader.repoKey, leader.workspaceKey, 'dag');
      const snap = store.read();
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      const taskA = snap.value.value.tasks.a;
      const completed = await store.completeReadOnlyTask(
        'a',
        snap.value.revision,
        taskA.claim!.token,
        taskA.claim!.generation,
        'a'.repeat(64),
      );
      expect(completed.ok).toBe(true);
      if (!completed.ok) return;

      await orch.stop('dag');

      const tick = await orch.tick('dag', 'headless');
      expect(tick.ok).toBe(true);
      if (!tick.ok) return;
      expect(tick.value.started.map((w) => w.taskId)).toEqual(['b']);
      await orch.stop('dag');
    } finally {
      tmux.cleanup();
      fixture.cleanup();
    }
  }, 40000);

  maybeTmux('ORCH-R3b startFromManifest fails when active dir lease overlaps file scope', async () => {
    const fixture = GitFixture.create();
    const tmux = new TmuxFixture();
    try {
      const leader = resolveGitWorktreeIdentity(fixture.repo);
      const holdJs = path.join(fixture.root, 'hold.js');
      fs.writeFileSync(holdJs, "require('fs').writeFileSync(process.argv[2],'ready\\n'); setInterval(()=>{},1000);\n");
      fs.mkdirSync(path.join(fixture.repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(fixture.repo, 'src', '.keep'), '');
      fixture.git(['add', 'src/.keep']);
      fixture.git(['commit', '-m', 'src']);
      const sessionNamePrefix = tmux.session('lease');
      const orch = new TeamOrchestrator({
        providerProfileFactory: headlessProviderRouteFactory(),
        stateRoot: fixture.stateRoot,
        workspaceRoot: fixture.repo,
        repoKey: leader.repoKey,
        workspaceKey: leader.workspaceKey,
        managedWorktreesRoot: fixture.managedWorktreesRoot,
        sessionNamePrefix,
        maxParallelWorkers: 1,
        tokenFactory: (() => { let n = 0; return () => `lease-tok-${++n}`; })(),
        workerExecutablePath: process.execPath,
        workerBootstrapArgv: [holdJs],
      });
      // Pre-hold dir:src lease (as if another worker still owns the scope)
      const { AuthorityLeaseStore } = await import('../../src/team/authority-lease');
      const dig = (await import('crypto')).createHash('sha256').update('holder').digest('hex');
      const leaseStore = new AuthorityLeaseStore(fixture.stateRoot, 'lease-team');
      const ensured = await leaseStore.ensure();
      expect(ensured.ok).toBe(true);
      if (!ensured.ok) return;
      const held = await leaseStore.acquire(
        'dir:src', 'external-holder', dig, Date.now(), 300_000, ensured.value.revision,
      );
      expect(held.ok).toBe(true);

      const manifestPath = path.join(fixture.root, 'm-lease.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        schema: 'oma.team-manifest/v1',
        teamId: 'lease-team',
        revision: 1,
        tasks: [{
          id: 'narrow',
          dependencies: [],
          write_scope: [{ kind: 'file', path: 'src/a.ts' }],
          mode: 'headless',
          verification: { version: 1, commands: [], requiredArtifacts: [] },
        }],
      }));
      const started = await orch.startFromManifest(manifestPath, 'headless');
      expect(started.ok).toBe(false);
      if (!started.ok) {
        expect(started.error.message).toMatch(/overlap|lease/i);
      }
    } finally {
      tmux.cleanup();
      fixture.cleanup();
    }
  }, 40000);

  maybeTmux('ORCH-T5 maxParallel starts two independent tasks', async () => {
    const fixture = GitFixture.create();
    const tmux = new TmuxFixture();
    try {
      const leader = resolveGitWorktreeIdentity(fixture.repo);
      const holdJs = path.join(fixture.root, 'hold.js');
      fs.writeFileSync(holdJs, "require('fs').writeFileSync(process.argv[2],'ready\\n'); setInterval(()=>{},1000);\n");
      const sessionNamePrefix = tmux.session('par');
      tmux.session('par-x-g1');
      tmux.session('par-y-g1');
      const orch = new TeamOrchestrator({
        providerProfileFactory: headlessProviderRouteFactory(),
        stateRoot: fixture.stateRoot,
        workspaceRoot: fixture.repo,
        repoKey: leader.repoKey,
        workspaceKey: leader.workspaceKey,
        managedWorktreesRoot: fixture.managedWorktreesRoot,
        sessionNamePrefix,
        maxParallelWorkers: 2,
        tokenFactory: (() => { let n = 0; return () => `p-tok-${++n}`; })(),
        workerExecutablePath: process.execPath,
        workerBootstrapArgv: [holdJs],
      });
      const manifestPath = path.join(fixture.root, 'm.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        schema: 'oma.team-manifest/v1',
        teamId: 'par',
        revision: 1,
        tasks: [
          {
            id: 'x', dependencies: [], write_scope: 'none', mode: 'read_only',
            verification: { version: 1, commands: [], requiredArtifacts: [] },
          },
          {
            id: 'y', dependencies: [], write_scope: 'none', mode: 'read_only',
            verification: { version: 1, commands: [], requiredArtifacts: [] },
          },
        ],
      }));
      const started = await orch.startFromManifest(manifestPath, 'headless');
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.value.workers).toHaveLength(2);
      await orch.stop('par');
    } finally {
      tmux.cleanup();
      fixture.cleanup();
    }
  }, 40000);
});
