import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { TeamOrchestrator } from '../../src/team/orchestrator';
import { TeamStateStore } from '../../src/team/state';
import { GitWorktreeManager, resolveGitWorktreeIdentity } from '../../src/team/worktree';
import { runtimeError } from '../../src/runtime/errors';
import { err, ok } from '../../src/runtime/types';
import { sha256 } from '../../src/runtime/atomic';
import { AuthorityLeaseStore } from '../../src/team/authority-lease';
import { GitFixture } from '../helpers/git-fixture';
import { TmuxFixture } from '../helpers/tmux-fixture';
import {
  HostIdentityV1,
  PluginIdentityV1,
  assembleHostCapabilityProfile,
} from '../../src/native/capability-profile';
import { TeamOrchestratorOptions } from '../../src/team/orchestrator';
import { workerRouteAuthorityPath } from '../../src/team/route-authority';

const maybe = TmuxFixture.available() ? test : test.skip;

function providerRouteOptions(
  provider: 'agy_headless' | 'tmux_agy' | 'antigravity_native' = 'agy_headless',
): Pick<TeamOrchestratorOptions, 'providerProfileFactory'> {
  return {
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
      const capabilities = provider === 'antigravity_native'
        ? ['subagent.invoke', 'subagent.send_message', 'subagent.manage']
        : ['headless.print', 'headless.json'];
      const profile = assembleHostCapabilityProfile({
        evaluationTimestamp: selectedAt, hostIdentityBefore: host, hostIdentityAfter: host,
        pluginIdentityBefore: plugin, pluginIdentityAfter: plugin,
        observations: capabilities
          .map((key) => ({ capability: key, source: 'live_probe' as const, tier: provider === 'antigravity_native' ? 'verified' as const : 'healthy' as const, result: 'positive' as const, observedAt: selectedAt, identityDigest: empty.identityDigest, detailCode: 'TEST_OK', diagnostic: null })),
      });
      return ok({
        profile,
        resolvedExecutable: '/opt/agy',
      });
    },
  };
}

describe('TeamOrchestrator v1 vertical slice', () => {
  let fixture: GitFixture;
  let tmux: TmuxFixture;

  beforeEach(() => {
    fixture = GitFixture.create();
    tmux = new TmuxFixture();
  });

  afterEach(() => {
    tmux.cleanup();
    tmux.assertClean();
    fixture.cleanup();
  });

  maybe('ORCH-01 starts first ready task: worktree + owned tmux + claim + heartbeat', async () => {
    const leader = resolveGitWorktreeIdentity(fixture.repo);
    const manifestPath = path.join(fixture.root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema: 'oma.team-manifest/v1', teamId: 'alpha', revision: 1, tasks: [],
    }));

    const initialOrch = new TeamOrchestrator({
      ...providerRouteOptions(),
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.repo,
      repoKey: leader.repoKey,
      workspaceKey: leader.workspaceKey,
      managedWorktreesRoot: fixture.managedWorktreesRoot,
    });
    const emptyStart = await initialOrch.startFromManifest(manifestPath, 'headless');
    expect(emptyStart.ok).toBe(false);
    expect(new TeamStateStore(
      fixture.stateRoot, leader.repoKey, leader.workspaceKey, 'alpha',
    ).read().ok).toBe(false);

    // The same canonical team ID remains reusable after validation fails.
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema: 'oma.team-manifest/v1',
      teamId: 'alpha',
      revision: 1,
      tasks: [{
        id: 'task-a',
        dependencies: [],
        // headless 不可用 write_scope none（manifest 契約）
        write_scope: [{ kind: 'file', path: 'task-a.txt' }],
        mode: 'headless',
        verification: { version: 1, commands: [], requiredArtifacts: [] },
      }],
    }));

    // 測試隔離：寫入 fixture 內 hold 腳本，避免依賴 ts-node / dist 解析
    const holdJs = path.join(fixture.root, 'hold.js');
    fs.writeFileSync(holdJs, [
      "const fs = require('fs');",
      'const marker = process.argv[2];',
      "if (!marker) { process.stderr.write('marker required\\n'); process.exit(2); }",
      "fs.writeFileSync(marker, 'ready\\n');",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'), 'utf8');

    // sessionNamePrefix 供 orchestrator 組 session；再預先登記衍生 session 以便 cleanup
    const sessionNamePrefix = tmux.session('orch');
    tmux.session('orch-task-a-g1');

    const orch = new TeamOrchestrator({
      ...providerRouteOptions(),
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.repo,
      repoKey: leader.repoKey,
      workspaceKey: leader.workspaceKey,
      managedWorktreesRoot: fixture.managedWorktreesRoot,
      sessionNamePrefix,
      tokenFactory: (() => {
        let n = 0;
        return () => `tok-${++n}`;
      })(),
      nowMs: () => 1_700_000_000_000,
      leaseMs: 60_000,
      workerExecutablePath: process.execPath,
      workerBootstrapArgv: [holdJs],
    });

    const started = await orch.startFromManifest(manifestPath, 'headless');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(started.value.teamId).toBe('alpha');
    expect(started.value.workers).toHaveLength(1);
    const worker = started.value.workers[0];
    expect(worker.taskId).toBe('task-a');
    expect(worker.generation).toBe(1);
    expect(worker.claimToken).toBeTruthy();
    expect(worker.sessionName).toBe(`${sessionNamePrefix}-task-a-g1`);
    expect(fs.existsSync(worker.worktreePath)).toBe(true);
    expect(tmux.hasSession(worker.sessionName)).toBe(true);

    const status = await orch.status(started.value.teamId);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.tasks['task-a'].status).toBe('in_progress');
    expect(status.value.heartbeats['task-a']).toBeDefined();
    expect(status.value.tmux[worker.sessionName].alive).toBe(true);

    const stopped = await orch.stop(started.value.teamId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.value.killedSessions).toContain(worker.sessionName);
    expect(tmux.hasSession(worker.sessionName)).toBe(false);
  }, 20_000);

  test('invalid path-like team identifier is rejected before any durable state', async () => {
    const leader = resolveGitWorktreeIdentity(fixture.repo);
    const manifestPath = path.join(fixture.root, 'bad-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema: 'oma.team-manifest/v1',
      teamId: 'bad/id',
      revision: 1,
      tasks: [{
        id: 'task-a', dependencies: [], write_scope: 'none', mode: 'read_only',
        verification: { version: 1, commands: [], requiredArtifacts: [] },
      }],
    }));
    const orch = new TeamOrchestrator({
      ...providerRouteOptions(),
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.repo,
      repoKey: leader.repoKey,
      workspaceKey: leader.workspaceKey,
      managedWorktreesRoot: fixture.managedWorktreesRoot,
    });
    const started = await orch.startFromManifest(manifestPath, 'headless');
    expect(started.ok).toBe(false);
    expect(fs.readdirSync(fixture.stateRoot, { recursive: true }).map(String)
      .some((entry) => entry.includes('bad'))).toBe(false);
  });

  test('native candidate stops before worktree, descriptor, control-plane, or bootstrap', async () => {
    const leader = resolveGitWorktreeIdentity(fixture.repo);
    const manifestPath = path.join(fixture.root, 'native-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema: 'oma.team-manifest/v1', teamId: 'native-stop', revision: 1,
      tasks: [{
        id: 'task-a', dependencies: [], write_scope: [{ kind: 'file', path: 'native.txt' }],
        mode: 'headless', verification: { version: 1, commands: [], requiredArtifacts: [] },
      }],
    }));
    const orch = new TeamOrchestrator({
      ...providerRouteOptions('antigravity_native'),
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.repo,
      repoKey: leader.repoKey,
      workspaceKey: leader.workspaceKey,
      managedWorktreesRoot: fixture.managedWorktreesRoot,
      nowMs: () => 1_700_000_000_000,
    });
    const result = await orch.startFromManifest(manifestPath, 'headless');
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'E_NATIVE_ADAPTER_UNAVAILABLE',
        message: 'Antigravity native worker adapter is unavailable',
        details: { provider: 'antigravity_native', adapterImplemented: false },
      },
    });
    expect(fs.readdirSync(fixture.managedWorktreesRoot)).toEqual([]);
    expect(fs.readdirSync(fixture.repo).some((entry) => entry.includes('worker-descriptor'))).toBe(false);
  });

  test('issues the short-lived route receipt after slow worktree preparation', async () => {
    const leader = resolveGitWorktreeIdentity(fixture.repo);
    const teamId = 'slow-worktree-route';
    const manifestPath = path.join(fixture.root, 'slow-worktree-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema: 'oma.team-manifest/v1',
      teamId,
      revision: 1,
      tasks: [{
        id: 'task-a', dependencies: [], write_scope: [{ kind: 'file', path: 'slow.txt' }],
        mode: 'headless', verification: { version: 1, commands: [], requiredArtifacts: [] },
      }],
    }));
    const baseNow = 1_700_000_000_000;
    let now = baseNow;
    const realWorktrees = new GitWorktreeManager(fixture.repo, fixture.managedWorktreesRoot);
    const slowWorktrees = {
      create: (input: any) => {
        expect(fs.existsSync(workerRouteAuthorityPath(
          fixture.stateRoot,
          teamId,
          'task-a',
          1,
        ))).toBe(false);
        const created = realWorktrees.create(input);
        if (created.ok) now += 31_000;
        return created;
      },
      rollbackLaunch: realWorktrees.rollbackLaunch.bind(realWorktrees),
    };
    const fakeTmux = {
      startWorker: (input: any) => ok({
        sessionName: input.sessionName,
        paneId: '%slow',
        ownerNonce: input.ownerNonce,
        workerNonce: input.workerNonce,
      }),
      killOwnedSession: () => ok(undefined),
      hasSession: () => false,
      inspectOwnedPane: () => err(runtimeError('E_NOT_FOUND', 'not live')),
    };
    const refreshTimes: number[] = [];
    const baseProviderFactory = providerRouteOptions().providerProfileFactory!;
    const orch = new TeamOrchestrator({
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.repo,
      repoKey: leader.repoKey,
      workspaceKey: leader.workspaceKey,
      managedWorktreesRoot: fixture.managedWorktreesRoot,
      nowMs: () => now,
      worktrees: slowWorktrees as GitWorktreeManager,
      tmux: fakeTmux as any,
      providerProfileFactory: async (input) => {
        refreshTimes.push(Date.parse(input.selectedAt));
        return baseProviderFactory(input);
      },
    });

    const started = await orch.startFromManifest(manifestPath, 'headless');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const authority = JSON.parse(fs.readFileSync(workerRouteAuthorityPath(
      fixture.stateRoot,
      teamId,
      'task-a',
      1,
    ), 'utf8')) as { receipt: { selectedAt: string; expiresAt: string } };
    expect(Date.parse(authority.receipt.selectedAt)).toBe(baseNow + 31_000);
    expect(Date.parse(authority.receipt.selectedAt)).toBeGreaterThan(baseNow + 30_000);
    expect(Date.parse(authority.receipt.expiresAt)).toBe(baseNow + 61_000);
    expect(refreshTimes).toEqual([baseNow, baseNow + 31_000]);
  });

  maybe('claim-time launch failure rolls back state and allows the same team ID to retry', async () => {
    const leader = resolveGitWorktreeIdentity(fixture.repo);
    const manifestPath = path.join(fixture.root, 'retry-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema: 'oma.team-manifest/v1', teamId: 'retry-team', revision: 1,
      tasks: [{
        id: 'task-a', dependencies: [],
        write_scope: [{ kind: 'file', path: 'retry.txt' }], mode: 'headless',
        verification: { version: 1, commands: [], requiredArtifacts: [] },
      }],
    }));
    const tokens = () => {
      let value = 0;
      return () => `retry-${++value}`;
    };
    const failedOrch = new TeamOrchestrator({
      ...providerRouteOptions(),
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.repo,
      repoKey: leader.repoKey,
      workspaceKey: leader.workspaceKey,
      managedWorktreesRoot: fixture.managedWorktreesRoot,
      tokenFactory: tokens(),
      workerExecutablePath: path.join(fixture.root, 'missing-node'),
    });
    const failed = await failedOrch.startFromManifest(manifestPath, 'headless');
    expect(failed.ok).toBe(false);
    expect(new TeamStateStore(
      fixture.stateRoot, leader.repoKey, leader.workspaceKey, 'retry-team',
    ).read().ok).toBe(false);
    const stateFiles = fs.readdirSync(fixture.stateRoot, { recursive: true })
      .map(String).filter((entry) => entry.endsWith('.json'));
    expect(stateFiles).toEqual([]);
    const branchesAfterFailure = spawnSync(
      'git', ['branch', '--list', 'oma-team/retry-team/*'], { cwd: fixture.repo, encoding: 'utf8' },
    );
    expect(branchesAfterFailure.stdout.trim()).toBe('');

    const holdJs = path.join(fixture.root, 'retry-hold.js');
    fs.writeFileSync(holdJs, [
      "const fs = require('fs');", 'const marker = process.argv[2];',
      "fs.writeFileSync(marker, 'ready\\n');", 'setInterval(() => {}, 1000);', '',
    ].join('\n'));
    const sessionNamePrefix = tmux.session('retry');
    tmux.session('retry-task-a-g1');
    const retryOrch = new TeamOrchestrator({
      ...providerRouteOptions(),
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.repo,
      repoKey: leader.repoKey,
      workspaceKey: leader.workspaceKey,
      managedWorktreesRoot: fixture.managedWorktreesRoot,
      sessionNamePrefix,
      tokenFactory: tokens(),
      workerExecutablePath: process.execPath,
      workerBootstrapArgv: [holdJs],
    });
    const retried = await retryOrch.startFromManifest(manifestPath, 'headless');
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.workers[0].generation).toBe(1);
    const stopped = await retryOrch.stop('retry-team');
    expect(stopped.ok).toBe(true);
  }, 20_000);

  test('initial partial launch failure rolls back the failed task and remains retry-safe', async () => {
    const leader = resolveGitWorktreeIdentity(fixture.repo);
    const teamId = 'partial-initial-retry';
    const manifestPath = path.join(fixture.root, 'partial-initial-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema: 'oma.team-manifest/v1',
      teamId,
      revision: 1,
      tasks: [
        {
          id: 'task-a',
          dependencies: [],
          write_scope: [{ kind: 'file', path: 'task-a.txt' }],
          mode: 'headless',
          verification: { version: 1, commands: [], requiredArtifacts: [] },
        },
        {
          id: 'task-b',
          dependencies: [],
          write_scope: [{ kind: 'file', path: 'task-b.txt' }],
          mode: 'headless',
          verification: { version: 1, commands: [], requiredArtifacts: [] },
        },
      ],
    }));

    const realWorktrees = new GitWorktreeManager(fixture.repo, fixture.managedWorktreesRoot);
    let createCount = 0;
    const failSecondWorktree = {
      create: (input: any) => {
        createCount += 1;
        return createCount === 2
          ? err(runtimeError('E_RETRYABLE_BLOCKER', 'injected second worktree failure'))
          : realWorktrees.create(input);
      },
      rollbackLaunch: realWorktrees.rollbackLaunch.bind(realWorktrees),
    };
    const fakeTmux = {
      startWorker: (input: any) => ok({
        sessionName: input.sessionName,
        paneId: `%${createCount}`,
        ownerNonce: input.ownerNonce,
        workerNonce: input.workerNonce,
      }),
      killOwnedSession: () => ok(undefined),
      hasSession: () => false,
      inspectOwnedPane: () => err(runtimeError('E_NOT_FOUND', 'not live')),
    };
    const tokenFactory = (() => {
      let sequence = 0;
      return () => `partial-${++sequence}`;
    })();
    const orch = new TeamOrchestrator({
      ...providerRouteOptions(),
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.repo,
      repoKey: leader.repoKey,
      workspaceKey: leader.workspaceKey,
      managedWorktreesRoot: fixture.managedWorktreesRoot,
      maxParallelWorkers: 2,
      tokenFactory,
      worktrees: failSecondWorktree as GitWorktreeManager,
      tmux: fakeTmux as any,
    });

    const started = await orch.startFromManifest(manifestPath, 'headless');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.workers.map((worker) => worker.taskId)).toEqual(['task-a']);

    const store = new TeamStateStore(
      fixture.stateRoot, leader.repoKey, leader.workspaceKey, teamId,
    );
    const afterFailure = store.read();
    expect(afterFailure.ok).toBe(true);
    if (!afterFailure.ok) return;
    expect(started.value.aggregateRevision).toBe(afterFailure.value.revision);
    expect(afterFailure.value.value.tasks['task-a'].status).toBe('in_progress');
    expect(afterFailure.value.value.tasks['task-b'].status).toBe('pending');
    expect(afterFailure.value.value.tasks['task-b'].claim).toBeUndefined();
    expect(afterFailure.value.value.heartbeats['task-b']).toBeUndefined();
    expect(afterFailure.value.value.workerBindings?.['task-b']).toBeUndefined();
    expect(afterFailure.value.value.mailboxCursors?.['task-b']).toBeUndefined();

    const leases = await new AuthorityLeaseStore(fixture.stateRoot, teamId).ensure();
    expect(leases.ok).toBe(true);
    if (!leases.ok) return;
    expect(Object.values(leases.value.value.leases).map((lease) => lease.ownerTaskId))
      .toEqual(['task-a']);
    expect(spawnSync(
      'git', ['branch', '--list', `oma-team/${teamId}/task-b-*`],
      { cwd: fixture.repo, encoding: 'utf8' },
    ).stdout.trim()).toBe('');

    const retry = new TeamOrchestrator({
      ...providerRouteOptions(),
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.repo,
      repoKey: leader.repoKey,
      workspaceKey: leader.workspaceKey,
      managedWorktreesRoot: fixture.managedWorktreesRoot,
      maxParallelWorkers: 2,
      tokenFactory,
      worktrees: realWorktrees,
      tmux: fakeTmux as any,
    });
    const retried = await retry.tick(teamId);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.started.map((worker) => worker.taskId)).toEqual(['task-b']);
    expect(retried.value.started[0].generation).toBe(2);
  });

  test.each(['worktree', 'tmux', 'heartbeat'] as const)(
    'tick %s launch failure rolls back per-task authority and a retry can launch',
    async (failurePoint) => {
      const leader = resolveGitWorktreeIdentity(fixture.repo);
      const teamId = `tick-${failurePoint}`;
      const ownerNonce = `owner-${failurePoint}`;
      const manifest = {
        schema: 'oma.team-manifest/v1' as const,
        teamId,
        revision: 1,
        repoRoot: fs.realpathSync(fixture.repo),
        tasks: [{
          id: 'task-a',
          dependencies: [],
          write_scope: [{ kind: 'file' as const, path: `${failurePoint}.txt` }],
          mode: 'headless' as const,
          verification: { version: 1 as const, commands: [], requiredArtifacts: [] },
        }],
      };
      const store = new TeamStateStore(
        fixture.stateRoot, leader.repoKey, leader.workspaceKey, teamId,
      );
      const created = await store.create(manifest, ownerNonce, leader.repoKey, leader.workspaceKey);
      expect(created.ok).toBe(true);

      const realWorktrees = new GitWorktreeManager(fixture.repo, fixture.managedWorktreesRoot);
      const killed: string[] = [];
      const failingTmux = {
        startWorker: (input: any) => failurePoint === 'tmux'
          ? err(runtimeError('E_RETRYABLE_BLOCKER', 'injected tmux failure'))
          : ok({
            sessionName: input.sessionName,
            paneId: '%99',
            ownerNonce: input.ownerNonce,
            workerNonce: input.workerNonce,
          }),
        killOwnedSession: (sessionName: string) => {
          killed.push(sessionName);
          return ok(undefined);
        },
        hasSession: () => false,
        inspectOwnedPane: () => err(runtimeError('E_NOT_FOUND', 'not live')),
      };
      const failingWorktrees = failurePoint === 'worktree'
        ? {
          create: () => err(runtimeError('E_RETRYABLE_BLOCKER', 'injected worktree failure')),
        }
        : realWorktrees;
      const originalHeartbeat = TeamStateStore.prototype.recordHeartbeat;
      if (failurePoint === 'heartbeat') {
        TeamStateStore.prototype.recordHeartbeat = async function injectedHeartbeatFailure() {
          return err(runtimeError('E_RETRYABLE_BLOCKER', 'injected heartbeat failure'));
        };
      }
      try {
        const failing = new TeamOrchestrator({
      ...providerRouteOptions(),
          stateRoot: fixture.stateRoot,
          workspaceRoot: fixture.repo,
          repoKey: leader.repoKey,
          workspaceKey: leader.workspaceKey,
          managedWorktreesRoot: fixture.managedWorktreesRoot,
          tokenFactory: (() => {
            let sequence = 0;
            return () => `${failurePoint}-${++sequence}`;
          })(),
          worktrees: failingWorktrees as GitWorktreeManager,
          tmux: failingTmux as any,
        });
        const failed = await failing.tick(teamId);
        expect(failed.ok).toBe(false);
      } finally {
        TeamStateStore.prototype.recordHeartbeat = originalHeartbeat;
      }

      const rolledBack = store.read();
      expect(rolledBack.ok).toBe(true);
      if (!rolledBack.ok) return;
      expect(rolledBack.value.value.tasks['task-a'].status).toBe('pending');
      expect(rolledBack.value.value.tasks['task-a'].claim).toBeUndefined();
      expect(rolledBack.value.value.heartbeats['task-a']).toBeUndefined();
      expect(rolledBack.value.value.workerBindings?.['task-a']).toBeUndefined();
      expect(rolledBack.value.value.mailboxCursors?.['task-a']).toBeUndefined();
      expect(spawnSync(
        'git', ['branch', '--list', `oma-team/${teamId}/*`],
        { cwd: fixture.repo, encoding: 'utf8' },
      ).stdout.trim()).toBe('');
      if (failurePoint === 'heartbeat') expect(killed).toHaveLength(1);

      const successfulTmux = {
        ...failingTmux,
        startWorker: (input: any) => ok({
          sessionName: input.sessionName,
          paneId: '%100',
          ownerNonce: input.ownerNonce,
          workerNonce: input.workerNonce,
        }),
      };
      const retry = new TeamOrchestrator({
      ...providerRouteOptions(),
        stateRoot: fixture.stateRoot,
        workspaceRoot: fixture.repo,
        repoKey: leader.repoKey,
        workspaceKey: leader.workspaceKey,
        managedWorktreesRoot: fixture.managedWorktreesRoot,
        tokenFactory: (() => {
          let sequence = 100;
          return () => `retry-${failurePoint}-${++sequence}`;
        })(),
        worktrees: realWorktrees,
        tmux: successfulTmux as any,
      });
      const retried = await retry.tick(teamId);
      expect(retried.ok).toBe(true);
      if (!retried.ok) return;
      expect(retried.value.started).toHaveLength(1);
      expect(retried.value.started[0].generation).toBe(2);
    },
  );

  test('tick releases leases acquired before a later write-scope lease conflicts', async () => {
    const leader = resolveGitWorktreeIdentity(fixture.repo);
    const teamId = 'tick-partial-lease';
    const ownerNonce = 'owner-partial-lease';
    const store = new TeamStateStore(
      fixture.stateRoot, leader.repoKey, leader.workspaceKey, teamId,
    );
    const created = await store.create({
      schema: 'oma.team-manifest/v1',
      teamId,
      revision: 1,
      repoRoot: fs.realpathSync(fixture.repo),
      tasks: [{
        id: 'task-a',
        dependencies: [],
        write_scope: [
          { kind: 'file', path: 'first.txt' },
          { kind: 'file', path: 'blocked.txt' },
        ],
        mode: 'headless',
        verification: { version: 1, commands: [], requiredArtifacts: [] },
      }],
    }, ownerNonce, leader.repoKey, leader.workspaceKey);
    expect(created.ok).toBe(true);
    const leases = new AuthorityLeaseStore(fixture.stateRoot, teamId);
    const initial = await leases.ensure();
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const occupied = await leases.acquire(
      'file:blocked.txt',
      'other-task',
      sha256('other-claim'),
      1_700_000_000_000,
      60_000,
      initial.value.revision,
    );
    expect(occupied.ok).toBe(true);

    const orch = new TeamOrchestrator({
      ...providerRouteOptions(),
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.repo,
      repoKey: leader.repoKey,
      workspaceKey: leader.workspaceKey,
      managedWorktreesRoot: fixture.managedWorktreesRoot,
      nowMs: () => 1_700_000_000_001,
      leaseMs: 60_000,
      tokenFactory: () => 'task-claim',
    });
    const tick = await orch.tick(teamId);
    expect(tick.ok).toBe(false);
    const after = await leases.ensure();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(Object.values(after.value.value.leases).map((lease) => lease.ownerTaskId))
      .toEqual(['other-task']);
    const aggregate = store.read();
    expect(aggregate.ok).toBe(true);
    if (!aggregate.ok) return;
    expect(aggregate.value.value.tasks['task-a'].status).toBe('pending');
    expect(aggregate.value.value.tasks['task-a'].claim).toBeUndefined();
  });
});
