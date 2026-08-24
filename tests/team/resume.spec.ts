/**
 * 設計概念映射：OMC `omc team resume` / OMX `omx team resume` / OMG `omg team resume`。
 * 驗收：健康採納不重啟、無法證明身分則圍籬、lease 競爭與 CAS 拒絕不變更狀態、
 * 重複 resume 幂等、leader-context.json 有界且 redaction。禁止 git reset。
 */
import * as fs from 'fs';
import * as path from 'path';
import { CLI_HELP } from '../../src/cli/application';
import { sha256 } from '../../src/runtime/atomic';
import { parseTeamCommand, teamCommand } from '../../src/team/commands';
import {
  LEADER_CONTEXT_FILE_NAME,
  writeBoundedLeaderContext,
} from '../../src/team/leader-context';
import { ok } from '../../src/runtime/types';
import { listReadyTaskSpecs, observeBoundWorkerForResume, TeamOrchestrator } from '../../src/team/orchestrator';
import { TeamStateStore } from '../../src/team/state';
import {
  PersistentTeamSupervisor,
  reconcileWorkerObservation,
  WorkerRuntimeObservationV1,
} from '../../src/team/supervisor-control';
import { TmuxController } from '../../src/team/tmux';
import {
  CanonicalTeamManifestV1,
  RuntimeContext,
  WorkerAuthorityBindingV1,
} from '../../src/team/types';
import { GitWorktreeManager } from '../../src/team/worktree';
import { GitFixture } from '../helpers/git-fixture';
import { createStateFixture } from '../helpers/state-fixture';

function resumeManifest(teamId: string, taskIds: readonly string[]): CanonicalTeamManifestV1 {
  return {
    schema: 'oma.team-manifest/v1',
    teamId,
    revision: 1,
    repoRoot: '/tmp',
    tasks: taskIds.map((id) => ({
      id,
      dependencies: [],
      mode: 'headless' as const,
      write_scope: 'none' as const,
      verification: { version: 1, commands: [], requiredArtifacts: [] },
    })),
  };
}

function bindingFor(
  taskId: string,
  provider: WorkerAuthorityBindingV1['provider'] = 'agy_headless',
): WorkerAuthorityBindingV1 {
  return {
    schemaVersion: 1,
    taskId,
    claimTokenDigest: sha256(`claim-${taskId}`),
    generation: 1,
    provider,
    providerReceiptHash: sha256(`receipt-${taskId}`),
    // bindWorkerAuthority 只接受 claimed / sequence 0（真實 store 契約）。
    // resume 採納判定走 reconcileWorkerObservation，不依賴 execution state。
    state: 'claimed',
    transitionSequence: 0,
    boundAtMs: 1,
    process: { pid: 4242, startMarker: `start-${taskId}` },
    ...(provider === 'tmux_agy'
      ? {
        pane: {
          schemaVersion: 1 as const,
          sessionName: `oma-${taskId}`,
          paneId: '%1',
          ownerNonce: 'owner-secret',
          workerNonce: `worker-${taskId}`,
        },
      }
      : {}),
  };
}

function observationFor(
  binding: WorkerAuthorityBindingV1,
  extras: Partial<WorkerRuntimeObservationV1> = {},
): WorkerRuntimeObservationV1 {
  return {
    taskId: binding.taskId,
    generation: binding.generation,
    providerReceiptHash: binding.providerReceiptHash,
    processLiveness: 'alive',
    paneLiveness: binding.pane === undefined ? 'dead' : 'alive',
    ...(binding.process === undefined ? {} : { process: binding.process }),
    ...(binding.pane === undefined ? {} : { pane: binding.pane }),
    ...extras,
  };
}

function throwingTmux(): TmuxController {
  return {
    hasSession: () => false,
    startWorker: () => { throw new Error('resume must not start workers'); },
    killOwnedSession: () => { throw new Error('resume must not kill sessions'); },
    inspectOwnedPane: () => { throw new Error('resume must not inspect panes when observer injected'); },
  } as unknown as TmuxController;
}

async function seededResumeTeam(taskIds: readonly string[] = ['task']) {
  const fixture = createStateFixture('oma-resume-');
  const teamId = 'resume-team';
  const store = new TeamStateStore(fixture.root, 'repo', 'workspace', teamId);
  const created = await store.create(resumeManifest(teamId, taskIds), 'owner-secret');
  if (!created.ok) throw new Error(created.error.message);
  let revision = created.value.revision;
  const bindings: Record<string, WorkerAuthorityBindingV1> = {};
  for (const taskId of taskIds) {
    const claimed = await store.claimTask(
      taskId, `worker-${taskId}`, revision, 1_000, 50_000, `claim-${taskId}`,
    );
    if (!claimed.ok) throw new Error(claimed.error.message);
    const authority = bindingFor(taskId);
    const bound = await store.bindWorkerAuthority(claimed.value.revision, `claim-${taskId}`, authority);
    if (!bound.ok) throw new Error(bound.error.message);
    revision = bound.value.revision;
    bindings[taskId] = authority;
  }
  const context: RuntimeContext = {
    stateRoot: fixture.root,
    workspaceRoot: fixture.root,
    repoKey: 'repo',
    workspaceKey: 'workspace',
  };
  const aggregatePath = fixture.path('repositories', 'repo', 'teams', teamId, 'aggregate.json');
  const leaderContextFile = fixture.path(
    'repositories', 'repo', 'teams', teamId, LEADER_CONTEXT_FILE_NAME,
  );
  return {
    fixture, store, teamId, context, aggregatePath, leaderContextFile, revision, bindings,
  };
}

function orchestratorFor(
  fixtureRoot: string,
  observer: (binding: WorkerAuthorityBindingV1) => WorkerRuntimeObservationV1,
  extras: { leaderContextMaxBytes?: number; supervisorOwnerToken?: string } = {},
): TeamOrchestrator {
  return new TeamOrchestrator({
    stateRoot: fixtureRoot,
    workspaceRoot: fixtureRoot,
    repoKey: 'repo',
    workspaceKey: 'workspace',
    managedWorktreesRoot: path.join(fixtureRoot, 'managed-worktrees'),
    nowMs: () => 1_000,
    leaseMs: 50_000,
    tmux: throwingTmux(),
    worktrees: {
      create: () => { throw new Error('resume must not create worktrees'); },
      rollbackLaunch: () => { throw new Error('resume must not roll back worktrees'); },
    } as unknown as GitWorktreeManager,
    resumeObserver: ({ binding }) => observer(binding),
    supervisorProcess: { pid: 7, startMarker: 'leader-resume' },
    ...(extras.leaderContextMaxBytes === undefined
      ? {}
      : { leaderContextMaxBytes: extras.leaderContextMaxBytes }),
    ...(extras.supervisorOwnerToken === undefined
      ? {}
      : { supervisorOwnerToken: extras.supervisorOwnerToken }),
  });
}

describe('oma team resume / TeamOrchestrator.resume', () => {
  test('CLI_HELP documents the resume verb', () => {
    expect(CLI_HELP).toContain(
      'oma team resume --team <id> --expected-revision <n> [--json]',
    );
  });

  test('parseTeamCommand accepts resume flags including boolean --json', () => {
    expect(parseTeamCommand([
      'resume', '--team', 'alpha', '--expected-revision', '3',
    ])).toEqual({
      ok: true,
      value: { kind: 'resume', teamId: 'alpha', expectedRevision: 3, json: false },
    });
    expect(parseTeamCommand([
      'resume', '--json', '--team', 'alpha', '--expected-revision', '0',
    ])).toEqual({
      ok: true,
      value: { kind: 'resume', teamId: 'alpha', expectedRevision: 0, json: true },
    });
  });

  test('resume argv missing flags or invalid revision is E_VALIDATOR_REJECTED', async () => {
    expect(parseTeamCommand(['resume', '--team', 'alpha']).ok).toBe(false);
    expect(parseTeamCommand(['resume', '--expected-revision', '1']).ok).toBe(false);
    expect(parseTeamCommand([
      'resume', '--team', 'alpha', '--expected-revision', '-1',
    ]).ok).toBe(false);
    expect(parseTeamCommand([
      'resume', '--team', 'alpha', '--expected-revision', '1.5',
    ]).ok).toBe(false);
    const unknownFlag = parseTeamCommand([
      'resume', '--team', 'alpha', '--expected-revision', '0', '--restart',
    ]);
    expect(unknownFlag).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'E_VALIDATOR_REJECTED' }),
    }));

    let stderr = '';
    const code = await teamCommand(['resume', '--team', 'alpha'], {
      context: {
        stateRoot: '/tmp',
        workspaceRoot: '/tmp',
        repoKey: 'repo',
        workspaceKey: 'workspace',
      },
      stdout: () => undefined,
      stderr: (value) => { stderr += value; },
    });
    expect(code).toBe(2);
    expect(stderr).toContain('E_VALIDATOR_REJECTED');
  });

  test('unknown team id is the existing E_NOT_FOUND', async () => {
    const seeded = await seededResumeTeam();
    try {
      const orch = orchestratorFor(seeded.fixture.root, (binding) => observationFor(binding));
      const missing = await orch.resume('no-such-team', 0);
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.error.code).toBe('E_NOT_FOUND');

      let stderr = '';
      const code = await teamCommand([
        'resume', '--team', 'no-such-team', '--expected-revision', '0', '--json',
      ], {
        context: seeded.context,
        orchestratorFactory: () => orch,
        stdout: () => undefined,
        stderr: (value) => { stderr += value; },
      });
      expect(code).toBe(1);
      expect(stderr).toContain('E_NOT_FOUND');
      expect(fs.existsSync(seeded.leaderContextFile)).toBe(false);
    } finally {
      seeded.fixture.cleanup();
    }
  });

  test('healthy bound workers are adopted and not restarted', async () => {
    const seeded = await seededResumeTeam(['healthy']);
    try {
      const orch = orchestratorFor(
        seeded.fixture.root,
        (binding) => observationFor(binding, { processLiveness: 'alive' }),
      );
      const tick = jest.spyOn(orch, 'tick');
      const before = seeded.store.read();
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const generation = before.value.value.tasks.healthy.claim?.generation;
      expect(generation).toBe(1);

      const resumed = await orch.resume(seeded.teamId, seeded.revision);
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.value.adopted).toEqual([{ taskId: 'healthy', generation: 1 }]);
      expect(resumed.value.fenced).toEqual([]);
      expect(resumed.value.reclaimable).toEqual([]);
      expect(tick).not.toHaveBeenCalled();

      const after = seeded.store.read();
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.value.tasks.healthy.status).toBe('in_progress');
      expect(after.value.value.tasks.healthy.claim?.generation).toBe(1);
      expect(after.value.value.workerBindings?.healthy.generation).toBe(1);
      expect(listReadyTaskSpecs(after.value.value.manifest, after.value.value)).toEqual([]);
      expect(after.value.value.supervisor?.generation).toBe(1);
      expect(fs.existsSync(resumed.value.leaderContextPath)).toBe(true);
      const context = JSON.parse(fs.readFileSync(resumed.value.leaderContextPath, 'utf8')) as {
        adopted: Array<{ taskId: string }>;
        token?: unknown;
        ownerNonce?: unknown;
      };
      expect(context.adopted).toEqual([{ generation: 1, taskId: 'healthy' }]);
      expect(context.token).toBeUndefined();
      expect(context.ownerNonce).toBeUndefined();
    } finally {
      seeded.fixture.cleanup();
    }
  });

  test('unproven identity is fenced and not blindly adopted', async () => {
    const seeded = await seededResumeTeam(['ghost']);
    try {
      const orch = orchestratorFor(
        seeded.fixture.root,
        (binding) => observationFor(binding, {
          processLiveness: 'unknown',
          paneLiveness: 'unknown',
        }),
      );
      const tick = jest.spyOn(orch, 'tick');
      const resumed = await orch.resume(seeded.teamId, seeded.revision);
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.value.adopted).toEqual([]);
      expect(resumed.value.reclaimable).toEqual([]);
      expect(resumed.value.fenced).toEqual([{
        taskId: 'ghost',
        generation: 1,
        reason: 'block_identity_unproven',
      }]);
      expect(tick).not.toHaveBeenCalled();

      const after = seeded.store.read();
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.value.tasks.ghost.status).toBe('orphan_identity_unproven');
      expect(after.value.value.tasks.ghost.claim?.generation).toBe(1);
      expect(after.value.value.workerBindings?.ghost.generation).toBe(1);
      expect(listReadyTaskSpecs(after.value.value.manifest, after.value.value)).toEqual([]);
    } finally {
      seeded.fixture.cleanup();
    }
  });

  test('stale process identity is fenced rather than adopted', async () => {
    const seeded = await seededResumeTeam(['stale']);
    try {
      const orch = orchestratorFor(
        seeded.fixture.root,
        (binding) => observationFor(binding, {
          process: { pid: 4242, startMarker: 'reused-pid' },
          processLiveness: 'alive',
        }),
      );
      const resumed = await orch.resume(seeded.teamId, seeded.revision);
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.value.fenced).toEqual([{
        taskId: 'stale',
        generation: 1,
        reason: 'fence_stale_observation',
      }]);
      const after = seeded.store.read();
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.value.tasks.stale.status).toBe('orphan_identity_unproven');
    } finally {
      seeded.fixture.cleanup();
    }
  });

  test('supervisor lease held by another live owner is E_REVISION_CONFLICT with no state change', async () => {
    const seeded = await seededResumeTeam();
    try {
      const foreign = new PersistentTeamSupervisor({
        store: seeded.store,
        ownerToken: 'foreign-supervisor',
        process: { pid: 9, startMarker: 'other-leader' },
        leaseMs: 50_000,
      });
      const held = await foreign.acquire(seeded.revision, 1_000);
      expect(held.ok).toBe(true);
      if (!held.ok) return;
      const before = fs.readFileSync(seeded.aggregatePath);
      expect(fs.existsSync(seeded.leaderContextFile)).toBe(false);

      const orch = orchestratorFor(
        seeded.fixture.root,
        (binding) => observationFor(binding),
      );
      const resumed = await orch.resume(seeded.teamId, held.value.revision);
      expect(resumed.ok).toBe(false);
      if (resumed.ok) return;
      expect(resumed.error.code).toBe('E_REVISION_CONFLICT');
      expect(fs.readFileSync(seeded.aggregatePath)).toEqual(before);
      expect(fs.existsSync(seeded.leaderContextFile)).toBe(false);
    } finally {
      seeded.fixture.cleanup();
    }
  });

  test('stale --expected-revision is CAS-rejected with no state change', async () => {
    const seeded = await seededResumeTeam();
    try {
      const before = fs.readFileSync(seeded.aggregatePath);
      const orch = orchestratorFor(
        seeded.fixture.root,
        (binding) => observationFor(binding),
      );
      const resumed = await orch.resume(seeded.teamId, seeded.revision + 9);
      expect(resumed.ok).toBe(false);
      if (!resumed.ok) {
        expect(resumed.error.code).toBe('E_REVISION_CONFLICT');
      }
      expect(fs.readFileSync(seeded.aggregatePath)).toEqual(before);
      expect(fs.existsSync(seeded.leaderContextFile)).toBe(false);
    } finally {
      seeded.fixture.cleanup();
    }
  });

  test('repeat resume is idempotent: no extra workers and no generation bump', async () => {
    const seeded = await seededResumeTeam(['healthy', 'ghost']);
    try {
      const orch = orchestratorFor(seeded.fixture.root, (binding) => (
        binding.taskId === 'healthy'
          ? observationFor(binding, { processLiveness: 'alive' })
          : observationFor(binding, { processLiveness: 'unknown', paneLiveness: 'unknown' })
      ));
      const first = await orch.resume(seeded.teamId, seeded.revision);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const mid = seeded.store.read();
      expect(mid.ok).toBe(true);
      if (!mid.ok) return;
      const second = await orch.resume(seeded.teamId, first.value.revision);
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      expect(second.value.revision).toBe(first.value.revision);
      expect(second.value.supervisorGeneration).toBe(first.value.supervisorGeneration);
      expect(second.value.adopted).toEqual(first.value.adopted);
      expect(second.value.fenced).toEqual(first.value.fenced);

      const after = seeded.store.read();
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(Object.keys(after.value.value.workerBindings ?? {})).toEqual(
        Object.keys(mid.value.value.workerBindings ?? {}),
      );
      expect(after.value.value.workerBindings?.healthy.generation).toBe(1);
      expect(after.value.value.workerBindings?.ghost.generation).toBe(1);
      expect(after.value.value.tasks.healthy.claim?.generation).toBe(1);
      expect(after.value.value.tasks.ghost.claim?.generation).toBe(1);
      expect(after.value.value.supervisor?.generation).toBe(1);
      expect(after.value.value.tasks.ghost.status).toBe('orphan_identity_unproven');
    } finally {
      seeded.fixture.cleanup();
    }
  });

  test('leader-context.json is size-capped and redacted', async () => {
    const direct = createStateFixture('oma-resume-ctx-');
    try {
      const target = direct.path(LEADER_CONTEXT_FILE_NAME);
      const written = writeBoundedLeaderContext(target, {
        schemaVersion: 1,
        store_kind: 'team_leader_context',
        teamId: 'resume-team',
        revision: 1,
        supervisorGeneration: 1,
        recordedAtMs: 1,
        adopted: [],
        fenced: [],
        reclaimable: [],
        token: 'claim-secret',
        prompt: 'private-prompt',
        padding: 'x'.repeat(80_000),
      }, 200);
      expect(written.ok).toBe(true);
      if (!written.ok) return;
      expect(written.value.bytes).toBeLessThanOrEqual(200);
      expect(written.value.truncated).toBe(true);
      const raw = fs.readFileSync(target);
      expect(raw.length).toBeLessThanOrEqual(200);
      expect(raw.toString('utf8')).not.toContain('claim-secret');
      expect(raw.toString('utf8')).not.toContain('private-prompt');
    } finally {
      direct.cleanup();
    }

    const seeded = await seededResumeTeam(['healthy']);
    try {
      const orch = orchestratorFor(
        seeded.fixture.root,
        (binding) => observationFor(binding),
        { leaderContextMaxBytes: 64 },
      );
      const resumed = await orch.resume(seeded.teamId, seeded.revision);
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.value.leaderContextTruncated).toBe(true);
      expect(resumed.value.leaderContextBytes).toBeLessThanOrEqual(64);
      const stat = fs.statSync(resumed.value.leaderContextPath);
      expect(stat.size).toBeLessThanOrEqual(64);
    } finally {
      seeded.fixture.cleanup();
    }
  });

  test('teamCommand resume prints team-resumed JSON on success', async () => {
    const seeded = await seededResumeTeam(['healthy']);
    try {
      const orch = orchestratorFor(
        seeded.fixture.root,
        (binding) => observationFor(binding, { processLiveness: 'alive' }),
      );
      let stdout = '';
      const code = await teamCommand([
        'resume', '--team', seeded.teamId, '--expected-revision', String(seeded.revision), '--json',
      ], {
        context: seeded.context,
        orchestratorFactory: () => orch,
        stdout: (value) => { stdout += value; },
        stderr: () => undefined,
      });
      expect(code).toBe(0);
      const body = JSON.parse(stdout) as {
        ok: boolean;
        kind: string;
        teamId: string;
        adopted: Array<{ taskId: string }>;
      };
      expect(body).toEqual(expect.objectContaining({
        ok: true,
        kind: 'team-resumed',
        teamId: seeded.teamId,
      }));
      expect(body.adopted).toEqual([{ taskId: 'healthy', generation: 1 }]);
    } finally {
      seeded.fixture.cleanup();
    }
  });

  test('resume from a non-leader workspace is E_TEAM_LEADER_REQUIRED', async () => {
    const seeded = await seededResumeTeam(['healthy']);
    try {
      const orch = new TeamOrchestrator({
        stateRoot: seeded.fixture.root,
        workspaceRoot: seeded.fixture.root,
        repoKey: 'repo',
        workspaceKey: 'other-workspace',
        managedWorktreesRoot: path.join(seeded.fixture.root, 'managed-worktrees'),
        nowMs: () => 1_000,
        leaseMs: 50_000,
        tmux: throwingTmux(),
        worktrees: {
          create: () => { throw new Error('resume must not create worktrees'); },
          rollbackLaunch: () => { throw new Error('resume must not roll back worktrees'); },
        } as unknown as GitWorktreeManager,
        resumeObserver: ({ binding }) => observationFor(binding),
        supervisorProcess: { pid: 7, startMarker: 'leader-resume' },
      });
      const before = seeded.store.read();
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const resumed = await orch.resume(seeded.teamId, seeded.revision);
      expect(resumed.ok).toBe(false);
      if (resumed.ok) return;
      expect(resumed.error.code).toBe('E_TEAM_LEADER_REQUIRED');
      const after = seeded.store.read();
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.revision).toBe(before.value.revision);
    } finally {
      seeded.fixture.cleanup();
    }
  });

  test('observed tmux process marker replacement is fenced, not adopted', () => {
    const binding = bindingFor('healthy', 'tmux_agy');
    const aggregate = {
      schemaVersion: 1 as const,
      teamId: 'resume-team',
      repoKey: 'repo',
      leaderWorkspaceKey: 'workspace',
      ownerNonce: 'owner-secret',
      manifest: resumeManifest('resume-team', ['healthy']),
      tasks: {
        healthy: {
          id: 'healthy',
          revision: 1,
          status: 'in_progress' as const,
          commandEvidence: {},
          claim: { ownerId: 'worker-healthy', token: 'claim-healthy', generation: 1, leasedUntilMs: 50_000 },
        },
      },
      heartbeats: {
        healthy: {
          schemaVersion: 1 as const,
          workerId: 'healthy',
          ownerNonce: 'owner-secret',
          workerNonce: 'worker-healthy',
          process: binding.process!,
          paneId: '%1',
          sessionName: 'oma-healthy',
          providerBasename: 'node',
          recordedAtMs: 1,
        },
      },
      mailbox: {},
      workerBindings: { healthy: binding },
      mailboxCursors: {},
      terminalReceipts: {},
    };
    const panePid = 501;
    const replacementPid = 9999;
    const oldStart = binding.process!.startMarker;
    const newStart = 'Mon Aug 24 12:00:00 2026';
    const psStdout = [
      `  ${panePid}     1 Mon Aug 24 11:00:00 2026 zsh`,
      `  ${replacementPid}   ${panePid} ${newStart} node`,
      '',
    ].join('\n');
    const tmux = {
      inspectOwnedPane: () => ok({
        sessionName: 'oma-healthy',
        paneId: '%1',
        ownerNonce: 'owner-secret',
        workerNonce: 'worker-healthy',
      }),
    } as unknown as TmuxController;
    const observed = observeBoundWorkerForResume(
      aggregate,
      binding,
      tmux,
      undefined,
      '/usr/bin/node',
      {
        tmuxSpawn: () => ({ status: 0, stdout: `${panePid}\n`, stderr: '' }),
        psSpawn: () => ({ status: 0, stdout: psStdout, stderr: '' }),
        probePane: () => 'alive',
      },
    );
    expect(observed.process).toEqual({ pid: replacementPid, startMarker: newStart });
    expect(observed.process).not.toEqual({ pid: binding.process!.pid, startMarker: oldStart });
    expect(reconcileWorkerObservation(aggregate, observed).action).toBe('fence_stale_observation');
  });

  test('unproven child keeps the bound marker and blocks rather than fences', () => {
    const binding = bindingFor('healthy', 'tmux_agy');
    const aggregate = {
      schemaVersion: 1 as const,
      teamId: 'resume-team',
      repoKey: 'repo',
      leaderWorkspaceKey: 'workspace',
      ownerNonce: 'owner-secret',
      manifest: resumeManifest('resume-team', ['healthy']),
      tasks: {
        healthy: {
          id: 'healthy', revision: 1, status: 'in_progress' as const, commandEvidence: {},
          claim: { ownerId: 'worker-healthy', token: 'claim-healthy', generation: 1, leasedUntilMs: 50_000 },
        },
      },
      heartbeats: {
        healthy: {
          schemaVersion: 1 as const,
          workerId: 'healthy',
          ownerNonce: 'owner-secret',
          workerNonce: 'worker-healthy',
          process: binding.process!,
          paneId: '%1',
          sessionName: 'oma-healthy',
          providerBasename: 'node',
          recordedAtMs: 1,
        },
      },
      mailbox: {},
      workerBindings: { healthy: binding },
      mailboxCursors: {},
      terminalReceipts: {},
    };
    const panePid = 501;
    const paneOnly = [
      `  ${panePid}     1 Mon Aug 24 11:00:00 2026 node`,
      '',
    ].join('\n');
    const tmux = {
      inspectOwnedPane: () => ok({
        sessionName: 'oma-healthy',
        paneId: '%1',
        ownerNonce: 'owner-secret',
        workerNonce: 'worker-healthy',
      }),
    } as unknown as TmuxController;
    const observed = observeBoundWorkerForResume(
      aggregate,
      binding,
      tmux,
      undefined,
      '/usr/bin/node',
      {
        tmuxSpawn: () => ({ status: 0, stdout: `${panePid}\n`, stderr: '' }),
        psSpawn: () => ({ status: 0, stdout: paneOnly, stderr: '' }),
        probePane: () => 'alive',
      },
    );
    expect(observed.process).toEqual(binding.process);
    expect(observed.providerIdentityMatched).toBe(false);
    expect(reconcileWorkerObservation(aggregate, observed).action).toBe('block_identity_unproven');
  });

  test('unproven launch placeholder process does not fence a later worker child', () => {
    const binding = bindingFor('healthy', 'tmux_agy');
    const placeholder = { pid: 0, startMarker: '' };
    const live = { pid: 9001, startMarker: 'Mon Aug 24 12:00:01 2026' };
    const bound = { ...binding, process: placeholder };
    const aggregate = {
      schemaVersion: 1 as const,
      teamId: 'resume-team',
      repoKey: 'repo',
      leaderWorkspaceKey: 'workspace',
      ownerNonce: 'owner-secret',
      manifest: resumeManifest('resume-team', ['healthy']),
      tasks: {
        healthy: {
          id: 'healthy', revision: 1, status: 'in_progress' as const, commandEvidence: {},
          claim: { ownerId: 'worker-healthy', token: 'claim-healthy', generation: 1, leasedUntilMs: 50_000 },
        },
      },
      heartbeats: {},
      mailbox: {},
      workerBindings: { healthy: bound },
      mailboxCursors: {},
      terminalReceipts: {},
    };
    expect(reconcileWorkerObservation(aggregate, {
      taskId: 'healthy',
      generation: 1,
      providerReceiptHash: bound.providerReceiptHash,
      process: live,
      pane: bound.pane,
      processLiveness: 'alive',
      paneLiveness: 'alive',
      providerIdentityMatched: true,
    }).action).toBe('adopt');
  });

  test('dead bound workers are reclaimable and not restarted', async () => {
    const seeded = await seededResumeTeam(['dead']);
    try {
      const orch = orchestratorFor(
        seeded.fixture.root,
        (binding) => observationFor(binding, { processLiveness: 'dead', paneLiveness: 'dead' }),
      );
      const tick = jest.spyOn(orch, 'tick');
      const resumed = await orch.resume(seeded.teamId, seeded.revision);
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.value.adopted).toEqual([]);
      expect(resumed.value.fenced).toEqual([]);
      expect(resumed.value.reclaimable).toEqual([{ taskId: 'dead', generation: 1 }]);
      expect(tick).not.toHaveBeenCalled();

      const after = seeded.store.read();
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.value.tasks.dead.status).toBe('in_progress');
      expect(after.value.value.tasks.dead.claim?.generation).toBe(1);
      expect(listReadyTaskSpecs(after.value.value.manifest, after.value.value)).toEqual([]);
    } finally {
      seeded.fixture.cleanup();
    }
  });

  test('resume does not git reset --hard, git clean -fd, or drop dirty files', async () => {
    // 設計概念映射：OMC/OMX/OMG team resume 不得對 leader worktree 做破壞性 git；
    // OMA circuit breaker 同一禁令。resume 只重綁 lease / 採納或圍籬，不碰 worktree。
    const git = GitFixture.create();
    try {
      const trackedPath = path.join(git.repo, 'README.md');
      const untrackedPath = path.join(git.repo, 'keep-untracked.txt');
      fs.writeFileSync(trackedPath, 'dirty tracked\n', 'utf8');
      fs.writeFileSync(untrackedPath, 'do not delete\n', 'utf8');
      const head = git.head();
      const porcelainBefore = git.git(['status', '--porcelain=v1', '--untracked-files=all']).stdout;
      expect(porcelainBefore).toContain('README.md');
      expect(porcelainBefore).toContain('keep-untracked.txt');

      const teamId = 'resume-team';
      const store = new TeamStateStore(git.stateRoot, 'repo', 'workspace', teamId);
      const created = await store.create(resumeManifest(teamId, ['healthy']), 'owner-secret');
      if (!created.ok) throw new Error(created.error.message);
      const claimed = await store.claimTask(
        'healthy', 'worker-healthy', created.value.revision, 1_000, 50_000, 'claim-healthy',
      );
      if (!claimed.ok) throw new Error(claimed.error.message);
      const bound = await store.bindWorkerAuthority(
        claimed.value.revision, 'claim-healthy', bindingFor('healthy'),
      );
      if (!bound.ok) throw new Error(bound.error.message);

      const orch = new TeamOrchestrator({
        stateRoot: git.stateRoot,
        workspaceRoot: git.repo,
        repoKey: 'repo',
        workspaceKey: 'workspace',
        managedWorktreesRoot: git.managedWorktreesRoot,
        nowMs: () => 1_000,
        leaseMs: 50_000,
        tmux: throwingTmux(),
        worktrees: {
          create: () => { throw new Error('resume must not create worktrees'); },
          rollbackLaunch: () => { throw new Error('resume must not roll back worktrees'); },
        } as unknown as GitWorktreeManager,
        resumeObserver: ({ binding }) => observationFor(binding),
        supervisorProcess: { pid: 7, startMarker: 'leader-resume' },
      });
      const resumed = await orch.resume(teamId, bound.value.revision);
      expect(resumed.ok).toBe(true);

      expect(git.head()).toBe(head);
      expect(fs.readFileSync(trackedPath, 'utf8')).toBe('dirty tracked\n');
      expect(fs.readFileSync(untrackedPath, 'utf8')).toBe('do not delete\n');
      expect(git.git(['status', '--porcelain=v1', '--untracked-files=all']).stdout)
        .toBe(porcelainBefore);
    } finally {
      git.cleanup();
    }
  });
});
