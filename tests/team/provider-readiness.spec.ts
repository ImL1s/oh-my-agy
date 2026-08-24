/**
 * #59：tmux provider 子程序 liveness。fake tmux/ps adapter，不打真實程序表。
 */
import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '../../src/runtime/atomic';
import { probeRecordedWorkerProcess, probeTmuxSession } from '../../src/team/liveness';
import {
  foldWorkerReadinessPhases,
  providerCommMatchesBasename,
  readinessPhaseForExecutionState,
  workerReadinessFromBinding,
  withMonotonicReadinessPhase,
} from '../../src/team/provider-readiness';
import { reconcileWorkerObservation } from '../../src/team/supervisor-control';
import {
  ArgvSpawnFn,
  PS_PROCESS_TABLE_ARGV,
  observeTmuxWorkerIdentity,
  parsePsProcessTable,
  providerChildProcessMarker,
  providerLivenessFromResolution,
  resolveProviderChild,
  tmuxListPanePidArgv,
} from '../../src/team/tmux';
import { TeamStateStore } from '../../src/team/state';
import {
  TeamAggregateV1,
  WorkerAuthorityBindingV1,
  WorkerReadinessPhaseV1,
} from '../../src/team/types';
import { createStateFixture } from '../helpers/state-fixture';

const SESSION = 'oma-team-task-g1';
const PANE_PID = 501;
const PROVIDER_PID = 700;
const LSTART = 'Mon Aug 24 10:00:01 2026';
const PANE_LSTART = 'Mon Aug 24 10:00:00 2026';

function spawnOk(stdout: string): ReturnType<ArgvSpawnFn> {
  return { status: 0, stdout, stderr: '' };
}

function spawnFail(status: number | null, error?: { code?: string; message?: string }): ReturnType<ArgvSpawnFn> {
  return { status, stdout: '', stderr: error?.message ?? 'failed', error };
}

function macosPsTable(childComm = 'agy'): string {
  return [
    `  ${PANE_PID}     1 ${PANE_LSTART} zsh`,
    `  ${PROVIDER_PID}   ${PANE_PID} ${LSTART} ${childComm}`,
    '',
  ].join('\n');
}

function linuxPsTable(childComm = 'agy'): string {
  return [
    `    ${PANE_PID}       1 ${PANE_LSTART} bash`,
    `    ${PROVIDER_PID}     ${PANE_PID} ${LSTART} ${childComm}`,
    '',
  ].join('\n');
}

function recordingSpawns(input: {
  panePid?: string;
  psStdout?: string;
  tmux?: ReturnType<ArgvSpawnFn>;
  ps?: ReturnType<ArgvSpawnFn>;
} = {}): { tmuxCalls: string[][]; psCalls: string[][]; tmuxSpawn: ArgvSpawnFn; psSpawn: ArgvSpawnFn } {
  const tmuxCalls: string[][] = [];
  const psCalls: string[][] = [];
  return {
    tmuxCalls,
    psCalls,
    tmuxSpawn: (argv) => {
      tmuxCalls.push([...argv]);
      return input.tmux ?? spawnOk(`${input.panePid ?? String(PANE_PID)}\n`);
    },
    psSpawn: (argv) => {
      psCalls.push([...argv]);
      return input.ps ?? spawnOk(input.psStdout ?? macosPsTable());
    },
  };
}

function tmuxBinding(overrides: Partial<WorkerAuthorityBindingV1> = {}): WorkerAuthorityBindingV1 {
  return {
    schemaVersion: 1,
    taskId: 'task',
    claimTokenDigest: sha256('claim'),
    generation: 1,
    provider: 'tmux_agy',
    providerReceiptHash: sha256('tmux_agy'),
    process: { pid: PROVIDER_PID, startMarker: LSTART },
    pane: {
      schemaVersion: 1,
      sessionName: SESSION,
      paneId: '%1',
      ownerNonce: 'owner',
      workerNonce: 'worker',
    },
    state: 'running',
    transitionSequence: 2,
    boundAtMs: 1,
    ...overrides,
  };
}

function headlessBinding(): WorkerAuthorityBindingV1 {
  return {
    schemaVersion: 1,
    taskId: 'task',
    claimTokenDigest: sha256('claim'),
    generation: 1,
    provider: 'agy_headless',
    providerReceiptHash: sha256('agy_headless'),
    process: { pid: 42, startMarker: 'start' },
    state: 'running',
    transitionSequence: 2,
    boundAtMs: 1,
  };
}

function aggregateFor(binding: WorkerAuthorityBindingV1): TeamAggregateV1 {
  return {
    schemaVersion: 1,
    teamId: 'team',
    repoKey: 'repo',
    leaderWorkspaceKey: 'workspace',
    ownerNonce: 'owner',
    manifest: {
      schema: 'oma.team-manifest/v1',
      teamId: 'team',
      revision: 1,
      repoRoot: '/tmp',
      tasks: [{
        id: 'task',
        dependencies: [],
        write_scope: 'none',
        mode: 'read_only',
        verification: { version: 1, commands: [], requiredArtifacts: [] },
      }],
    },
    tasks: {
      task: {
        id: 'task',
        revision: 1,
        status: 'in_progress',
        commandEvidence: {},
        claim: { ownerId: 'worker', token: 'claim', generation: 1, leasedUntilMs: 1 },
      },
    },
    heartbeats: {},
    mailbox: {},
    workerBindings: { task: binding },
    mailboxCursors: {},
    terminalReceipts: {},
  };
}

describe('resolveProviderChild', () => {
  test('orphan pane shell without matching provider is not matched', () => {
    const fake = recordingSpawns({ psStdout: macosPsTable('zsh') });
    const resolved = resolveProviderChild(SESSION, {
      expectedBasename: 'agy',
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(resolved.status).toBe('orphan');
    expect(resolved.matched).toBeUndefined();
    expect(resolved.pane?.comm).toBe('zsh');
    expect(resolved.children.some((child) => child.comm === 'agy')).toBe(false);
  });

  test('matches a live provider child on macOS ps lstart/comm sample', () => {
    const fake = recordingSpawns({ psStdout: macosPsTable('agy') });
    const resolved = resolveProviderChild(SESSION, {
      expectedBasename: '/opt/bin/agy',
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(resolved.status).toBe('matched');
    expect(resolved.matched).toEqual({
      pid: PROVIDER_PID,
      startMarker: LSTART,
      comm: 'agy',
    });
    expect(resolved.matched?.startMarker).toContain('2026');
    expect(resolved.matched?.startMarker.startsWith('tmux:')).toBe(false);
  });

  test('matches a nested provider grandchild under the pane shell', () => {
    const nested = [
      `  ${PANE_PID}     1 ${PANE_LSTART} zsh`,
      `  600   ${PANE_PID} ${PANE_LSTART} node`,
      `  ${PROVIDER_PID}   600 ${LSTART} agy`,
      '',
    ].join('\n');
    const fake = recordingSpawns({ psStdout: nested });
    const resolved = resolveProviderChild(SESSION, {
      expectedBasename: 'agy',
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(resolved.status).toBe('matched');
    expect(resolved.matched).toEqual({
      pid: PROVIDER_PID,
      startMarker: LSTART,
      comm: 'agy',
    });
  });

  test('matches a live provider child on Linux padded ps sample', () => {
    const fake = recordingSpawns({ psStdout: linuxPsTable('agy') });
    const resolved = resolveProviderChild(SESSION, {
      expectedBasename: 'agy',
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(resolved.status).toBe('matched');
    expect(resolved.matched?.pid).toBe(PROVIDER_PID);
    expect(resolved.matched?.startMarker).toBe(LSTART);
  });

  test('ps failure is unknown, not alive', () => {
    const fake = recordingSpawns({ ps: spawnFail(1) });
    const resolved = resolveProviderChild(SESSION, {
      expectedBasename: 'agy',
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(resolved.status).toBe('unknown');
    expect(resolved.matched).toBeUndefined();
  });

  test('tmux missing (ENOENT) is unknown, not alive', () => {
    const fake = recordingSpawns({
      tmux: spawnFail(null, { code: 'ENOENT', message: 'spawnSync tmux ENOENT' }),
    });
    const resolved = resolveProviderChild(SESSION, {
      expectedBasename: 'agy',
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(resolved.status).toBe('unknown');
    expect(fake.psCalls).toEqual([]);
  });

  test('tmux list-panes non-zero is unknown, not alive', () => {
    const fake = recordingSpawns({ tmux: spawnFail(1) });
    const resolved = resolveProviderChild(SESSION, {
      expectedBasename: 'agy',
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(resolved.status).toBe('unknown');
    expect(resolved.matched).toBeUndefined();
    expect(fake.psCalls).toEqual([]);
  });

  test('malformed ps table is unknown, not alive', () => {
    const fake = recordingSpawns({ psStdout: 'garbage\nnot a process table\n' });
    const resolved = resolveProviderChild(SESSION, {
      expectedBasename: 'agy',
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(resolved.status).toBe('unknown');
    expect(parsePsProcessTable('garbage\nnot a process table\n')).toBeNull();
  });

  test('invalid session name does not spawn tmux or ps', () => {
    const fake = recordingSpawns();
    const resolved = resolveProviderChild('bad session', {
      expectedBasename: 'agy',
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(resolved.status).toBe('unknown');
    expect(fake.tmuxCalls).toEqual([]);
    expect(fake.psCalls).toEqual([]);
  });

  test('empty expected basename is orphan, not matched', () => {
    const fake = recordingSpawns({ psStdout: macosPsTable('agy') });
    const resolved = resolveProviderChild(SESSION, {
      expectedBasename: '  ',
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(resolved.status).toBe('orphan');
    expect(resolved.matched).toBeUndefined();
    expect(providerChildProcessMarker(resolved)).toBeUndefined();
  });

  test('padded single-digit lstart day parses on macOS samples', () => {
    const padded = [
      `  ${PANE_PID}     1 Mon Aug  4 09:00:00 2026 zsh`,
      `  ${PROVIDER_PID}   ${PANE_PID} Mon Aug  4 09:00:01 2026 agy`,
      '',
    ].join('\n');
    const fake = recordingSpawns({ psStdout: padded });
    const resolved = resolveProviderChild(SESSION, {
      expectedBasename: 'agy',
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(resolved.status).toBe('matched');
    expect(resolved.matched).toEqual({
      pid: PROVIDER_PID,
      startMarker: 'Mon Aug  4 09:00:01 2026',
      comm: 'agy',
    });
  });

  test('tmux and ps are argv arrays with no shell strings', () => {
    const fake = recordingSpawns();
    resolveProviderChild(SESSION, {
      expectedBasename: 'agy',
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(fake.tmuxCalls).toEqual([tmuxListPanePidArgv(SESSION)]);
    expect(fake.psCalls).toEqual([[...PS_PROCESS_TABLE_ARGV]]);
    const allArgv = [...fake.tmuxCalls, ...fake.psCalls];
    expect(allArgv.every((argv) => Array.isArray(argv))).toBe(true);
    expect(allArgv.every((argv) => argv.every((token) => !token.includes('|') && !token.includes(';')))).toBe(true);
    expect(PS_PROCESS_TABLE_ARGV).toContain('pid=');
    expect(PS_PROCESS_TABLE_ARGV).toContain('lstart=');
    expect(PS_PROCESS_TABLE_ARGV).toContain('comm=');
    const tmuxSrc = fs.readFileSync(path.join(__dirname, '../../src/team/tmux.ts'), 'utf8');
    expect(tmuxSrc).not.toMatch(/shell:\s*true/);
    expect(tmuxSrc).not.toMatch(/spawnSync\(\s*['"]tmux['"]\s*,\s*['"]/);
    expect(tmuxSrc).not.toMatch(/spawnSync\(\s*['"]ps['"]\s*,\s*['"]/);
  });
});

describe('WorkerReadinessPhaseV1', () => {
  test('fold of shuffled phases never goes backwards', () => {
    const shuffled: WorkerReadinessPhaseV1[] = [
      'task_dispatched',
      'pane_created',
      'provider_ready',
      'provider_spawned',
      'pane_created',
    ];
    expect(foldWorkerReadinessPhases(shuffled)).toBe('task_dispatched');
    expect(foldWorkerReadinessPhases([
      'provider_ready',
      'provider_spawned',
      'pane_created',
    ])).toBe('provider_ready');
    expect(foldWorkerReadinessPhases([
      'pane_created',
      'provider_spawned',
      'provider_ready',
      'task_dispatched',
    ])).toBe('task_dispatched');
  });

  test('legacy bindings without phase do not crash and downgrade', () => {
    const legacy = tmuxBinding();
    delete (legacy as { readinessPhase?: unknown }).readinessPhase;
    expect(() => workerReadinessFromBinding(legacy)).not.toThrow();
    expect(workerReadinessFromBinding(legacy)).toEqual({ kind: 'legacy' });
    expect(workerReadinessFromBinding({} as WorkerAuthorityBindingV1)).toEqual({ kind: 'legacy' });
    const advanced = withMonotonicReadinessPhase(legacy, 'pane_created');
    expect(advanced.readinessPhase).toBe('pane_created');
    expect(withMonotonicReadinessPhase(advanced, 'pane_created').readinessPhase).toBe('pane_created');
  });

  test('invalid stored phase is treated as legacy, not thrown', () => {
    const binding = tmuxBinding({ readinessPhase: 'wrapper_ready_legacy' as WorkerReadinessPhaseV1 });
    expect(workerReadinessFromBinding(binding)).toEqual({ kind: 'legacy' });
  });

  test('execution-state mapping is monotonic with out-of-order folds', () => {
    expect(readinessPhaseForExecutionState('claimed')).toBe('pane_created');
    expect(readinessPhaseForExecutionState('launched')).toBe('provider_spawned');
    expect(readinessPhaseForExecutionState('running')).toBe('provider_ready');
    expect(readinessPhaseForExecutionState('verifying')).toBe('task_dispatched');
    expect(foldWorkerReadinessPhases([
      readinessPhaseForExecutionState('verifying')!,
      readinessPhaseForExecutionState('claimed')!,
      readinessPhaseForExecutionState('running')!,
    ])).toBe('task_dispatched');
  });

  test('bindWorkerAuthority accepts omitted phase and a monotonic phase', async () => {
    for (const phase of [undefined, 'pane_created'] as const) {
      const fixture = createStateFixture('oma-provider-ready-bind-');
      try {
        const store = new TeamStateStore(fixture.root, 'repo', 'workspace', 'team');
        const created = await store.create(aggregateFor(tmuxBinding()).manifest, 'owner');
        if (!created.ok) throw new Error(created.error.message);
        const claimed = await store.claimTask('task', 'worker', created.value.revision, 1, 1000, 'claim');
        if (!claimed.ok) throw new Error(claimed.error.message);
        const toBind = tmuxBinding({
          state: 'claimed',
          transitionSequence: 0,
          claimTokenDigest: sha256('claim'),
          ...(phase === undefined ? {} : { readinessPhase: phase }),
        });
        if (phase === undefined) delete (toBind as { readinessPhase?: unknown }).readinessPhase;
        const bound = await store.bindWorkerAuthority(claimed.value.revision, 'claim', toBind);
        expect(bound.ok).toBe(true);
        if (!bound.ok) return;
        expect(bound.value.value.workerBindings?.task.readinessPhase).toBe(phase);
        expect(workerReadinessFromBinding(bound.value.value.workerBindings!.task)).toEqual(
          phase === undefined ? { kind: 'legacy' } : { kind: 'phased', phase },
        );
      } finally {
        fixture.cleanup();
      }
    }
  });

  test('bindWorkerAuthority rejects an invalid stored phase', async () => {
    const fixture = createStateFixture('oma-provider-ready-bad-phase-');
    try {
      const store = new TeamStateStore(fixture.root, 'repo', 'workspace', 'team');
      const created = await store.create(aggregateFor(tmuxBinding()).manifest, 'owner');
      if (!created.ok) throw new Error(created.error.message);
      const claimed = await store.claimTask('task', 'worker', created.value.revision, 1, 1000, 'claim');
      if (!claimed.ok) throw new Error(claimed.error.message);
      const toBind = tmuxBinding({
        state: 'claimed',
        transitionSequence: 0,
        claimTokenDigest: sha256('claim'),
        readinessPhase: 'wrapper_ready_legacy' as WorkerReadinessPhaseV1,
      });
      const bound = await store.bindWorkerAuthority(claimed.value.revision, 'claim', toBind);
      expect(bound.ok).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('tmux transitions advance phase monotonically; legacy stays omitted', async () => {
    const fixture = createStateFixture('oma-provider-ready-transition-');
    try {
      const store = new TeamStateStore(fixture.root, 'repo', 'workspace', 'team');
      const created = await store.create(aggregateFor(tmuxBinding()).manifest, 'owner');
      if (!created.ok) throw new Error(created.error.message);
      const claimed = await store.claimTask('task', 'worker', created.value.revision, 1, 1000, 'claim');
      if (!claimed.ok) throw new Error(claimed.error.message);
      const bound = await store.bindWorkerAuthority(
        claimed.value.revision,
        'claim',
        tmuxBinding({
          state: 'claimed',
          transitionSequence: 0,
          claimTokenDigest: sha256('claim'),
          readinessPhase: 'pane_created',
        }),
      );
      expect(bound.ok).toBe(true);
      if (!bound.ok) return;
      const launched = await store.transitionWorkerAuthority({
        expectedRevision: bound.value.revision,
        taskId: 'task',
        claimToken: 'claim',
        generation: 1,
        providerReceiptHash: sha256('tmux_agy'),
        expectedState: 'claimed',
        expectedSequence: 0,
        nextState: 'launched',
      });
      expect(launched.ok).toBe(true);
      if (!launched.ok) return;
      expect(launched.value.value.workerBindings?.task.readinessPhase).toBe('provider_spawned');
      const running = await store.transitionWorkerAuthority({
        expectedRevision: launched.value.revision,
        taskId: 'task',
        claimToken: 'claim',
        generation: 1,
        providerReceiptHash: sha256('tmux_agy'),
        expectedState: 'launched',
        expectedSequence: 1,
        nextState: 'running',
      });
      expect(running.ok).toBe(true);
      if (!running.ok) return;
      expect(running.value.value.workerBindings?.task.readinessPhase).toBe('provider_ready');

      const legacyFixture = createStateFixture('oma-provider-ready-legacy-transition-');
      try {
        const legacyStore = new TeamStateStore(legacyFixture.root, 'repo', 'workspace', 'team');
        const legacyCreated = await legacyStore.create(aggregateFor(tmuxBinding()).manifest, 'owner');
        if (!legacyCreated.ok) throw new Error(legacyCreated.error.message);
        const legacyClaimed = await legacyStore.claimTask(
          'task', 'worker', legacyCreated.value.revision, 1, 1000, 'claim',
        );
        if (!legacyClaimed.ok) throw new Error(legacyClaimed.error.message);
        const legacyBind = tmuxBinding({
          state: 'claimed',
          transitionSequence: 0,
          claimTokenDigest: sha256('claim'),
        });
        delete (legacyBind as { readinessPhase?: unknown }).readinessPhase;
        const legacyBound = await legacyStore.bindWorkerAuthority(
          legacyClaimed.value.revision, 'claim', legacyBind,
        );
        expect(legacyBound.ok).toBe(true);
        if (!legacyBound.ok) return;
        const legacyLaunched = await legacyStore.transitionWorkerAuthority({
          expectedRevision: legacyBound.value.revision,
          taskId: 'task',
          claimToken: 'claim',
          generation: 1,
          providerReceiptHash: sha256('tmux_agy'),
          expectedState: 'claimed',
          expectedSequence: 0,
          nextState: 'launched',
        });
        expect(legacyLaunched.ok).toBe(true);
        if (!legacyLaunched.ok) return;
        expect(legacyLaunched.value.value.workerBindings?.task.readinessPhase).toBeUndefined();
        expect(workerReadinessFromBinding(legacyLaunched.value.value.workerBindings!.task)).toEqual({
          kind: 'legacy',
        });
      } finally {
        legacyFixture.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('worker heartbeat preserves sessionName and providerBasename', async () => {
    const fixture = createStateFixture('oma-provider-ready-hb-session-');
    try {
      const store = new TeamStateStore(fixture.root, 'repo', 'workspace', 'team');
      const created = await store.create(aggregateFor(tmuxBinding()).manifest, 'owner');
      if (!created.ok) throw new Error(created.error.message);
      const claimed = await store.claimTask('task', 'worker', created.value.revision, 1, 1000, 'claim');
      if (!claimed.ok) throw new Error(claimed.error.message);
      const bound = await store.bindWorkerAuthority(
        claimed.value.revision,
        'claim',
        tmuxBinding({
          state: 'claimed',
          transitionSequence: 0,
          claimTokenDigest: sha256('claim'),
          readinessPhase: 'pane_created',
        }),
      );
      expect(bound.ok).toBe(true);
      if (!bound.ok) return;
      const heartbeat = await store.recordHeartbeat(bound.value.revision, {
        schemaVersion: 1,
        workerId: 'task',
        ownerNonce: 'owner',
        workerNonce: 'worker',
        process: tmuxBinding().process!,
        paneId: '%1',
        sessionName: SESSION,
        providerBasename: 'agy',
        recordedAtMs: 2,
      });
      expect(heartbeat.ok).toBe(true);
      if (!heartbeat.ok) return;
      const workerHb = await store.recordWorkerHeartbeat(heartbeat.value.revision, {
        schemaVersion: 1,
        taskId: 'task',
        claimTokenDigest: sha256('claim'),
        generation: 1,
        provider: 'tmux_agy',
        providerReceiptHash: sha256('tmux_agy'),
        process: tmuxBinding().process,
        pane: tmuxBinding().pane,
        recordedAtMs: 3,
      });
      expect(workerHb.ok).toBe(true);
      if (!workerHb.ok) return;
      expect(workerHb.value.value.heartbeats.task.sessionName).toBe(SESSION);
      expect(workerHb.value.value.heartbeats.task.providerBasename).toBe('agy');
      expect(workerHb.value.value.heartbeats.task.process.startMarker.startsWith('tmux:')).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('reconcileWorkerObservation tmux provider liveness', () => {
  test('pane alive without matching provider child is not adopt', () => {
    const tmux = aggregateFor(tmuxBinding());
    const orphan = reconcileWorkerObservation(tmux, {
      taskId: 'task',
      generation: 1,
      providerReceiptHash: sha256('tmux_agy'),
      process: tmuxBinding().process,
      pane: tmuxBinding().pane,
      processLiveness: 'unknown',
      paneLiveness: 'alive',
      providerIdentityMatched: false,
    });
    expect(orphan.action).not.toBe('adopt');
    expect(orphan.action).toBe('block_identity_unproven');
    const omitted = reconcileWorkerObservation(tmux, {
      taskId: 'task',
      generation: 1,
      providerReceiptHash: sha256('tmux_agy'),
      process: tmuxBinding().process,
      pane: tmuxBinding().pane,
      processLiveness: 'alive',
      paneLiveness: 'alive',
    });
    expect(omitted.action).not.toBe('adopt');
  });

  test('matched provider child with alive process is adopt', () => {
    const tmux = aggregateFor(tmuxBinding({ readinessPhase: 'provider_ready' }));
    expect(reconcileWorkerObservation(tmux, {
      taskId: 'task',
      generation: 1,
      providerReceiptHash: sha256('tmux_agy'),
      process: tmuxBinding().process,
      pane: tmuxBinding().pane,
      processLiveness: 'alive',
      paneLiveness: 'alive',
      providerIdentityMatched: true,
    }).action).toBe('adopt');
  });

  test('legacy binding without phase still does not adopt on pane-only liveness', () => {
    const legacy = tmuxBinding();
    delete (legacy as { readinessPhase?: unknown }).readinessPhase;
    expect(() => reconcileWorkerObservation(aggregateFor(legacy), {
      taskId: 'task',
      generation: 1,
      providerReceiptHash: sha256('tmux_agy'),
      process: legacy.process,
      pane: legacy.pane,
      processLiveness: 'dead',
      paneLiveness: 'alive',
    })).not.toThrow();
    expect(reconcileWorkerObservation(aggregateFor(legacy), {
      taskId: 'task',
      generation: 1,
      providerReceiptHash: sha256('tmux_agy'),
      process: legacy.process,
      pane: legacy.pane,
      processLiveness: 'dead',
      paneLiveness: 'alive',
    }).action).toBe('block_identity_unproven');
  });

  test('observeTmuxWorkerIdentity orphan pane is not adopt', () => {
    const fake = recordingSpawns({ psStdout: macosPsTable('zsh') });
    const observed = observeTmuxWorkerIdentity(SESSION, 'agy', {
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(observed.resolution.status).toBe('orphan');
    expect(observed.providerIdentityMatched).toBe(false);
    expect(observed.processLiveness).toBe('unknown');
    expect(observed.process).toBeUndefined();
    expect(providerChildProcessMarker(observed.resolution)).toBeUndefined();
    const action = reconcileWorkerObservation(aggregateFor(tmuxBinding()), {
      taskId: 'task',
      generation: 1,
      providerReceiptHash: sha256('tmux_agy'),
      process: tmuxBinding().process,
      pane: tmuxBinding().pane,
      processLiveness: observed.processLiveness,
      paneLiveness: 'alive',
      providerIdentityMatched: observed.providerIdentityMatched,
    }).action;
    expect(action).not.toBe('adopt');
    expect(action).toBe('block_identity_unproven');
  });

  test('observeTmuxWorkerIdentity matched provider is adopt', () => {
    const fake = recordingSpawns({ psStdout: macosPsTable('agy') });
    const observed = observeTmuxWorkerIdentity(SESSION, '/opt/bin/agy', {
      tmuxSpawn: fake.tmuxSpawn,
      psSpawn: fake.psSpawn,
    });
    expect(observed.providerIdentityMatched).toBe(true);
    expect(observed.processLiveness).toBe('alive');
    expect(observed.process).toEqual({ pid: PROVIDER_PID, startMarker: LSTART });
    expect(observed.process?.startMarker.startsWith('tmux:')).toBe(false);
    expect(reconcileWorkerObservation(aggregateFor(tmuxBinding({ readinessPhase: 'provider_ready' })), {
      taskId: 'task',
      generation: 1,
      providerReceiptHash: sha256('tmux_agy'),
      process: tmuxBinding().process,
      pane: tmuxBinding().pane,
      processLiveness: observed.processLiveness,
      paneLiveness: 'alive',
      providerIdentityMatched: observed.providerIdentityMatched,
    }).action).toBe('adopt');
  });

  test('headless observation is unchanged', () => {
    const headless = aggregateFor(headlessBinding());
    expect(reconcileWorkerObservation(headless, {
      taskId: 'task',
      generation: 1,
      providerReceiptHash: sha256('agy_headless'),
      process: { pid: 42, startMarker: 'start' },
      processLiveness: 'alive',
      paneLiveness: 'dead',
    }).action).toBe('adopt');
    expect(reconcileWorkerObservation(headless, {
      taskId: 'task',
      generation: 1,
      providerReceiptHash: sha256('agy_headless'),
      process: { pid: 42, startMarker: 'start' },
      processLiveness: 'dead',
      paneLiveness: 'dead',
    }).action).toBe('reclaim_generation_plus_one');
    expect(reconcileWorkerObservation(headless, {
      taskId: 'task',
      generation: 1,
      providerReceiptHash: sha256('agy_headless'),
      process: { pid: 42, startMarker: 'start' },
      processLiveness: 'unknown',
      paneLiveness: 'alive',
    }).action).toBe('block_identity_unproven');
  });
});

describe('ps table parse + basename match', () => {
  test('parses macOS and Linux samples', () => {
    expect(parsePsProcessTable(macosPsTable())?.map((row) => row.pid)).toEqual([PANE_PID, PROVIDER_PID]);
    expect(parsePsProcessTable(linuxPsTable())?.[1]).toEqual({
      pid: PROVIDER_PID,
      ppid: PANE_PID,
      startMarker: LSTART,
      comm: 'agy',
    });
  });

  test('matches truncated Darwin comm against a longer routed basename', () => {
    expect(providerCommMatchesBasename('antigravity-cli', 'antigravity-cli')).toBe(true);
    const truncated = 'abcdefghijklmnop';
    expect(truncated.length).toBe(16);
    expect(providerCommMatchesBasename(truncated, `${truncated}-extra`)).toBe(true);
    expect(providerCommMatchesBasename('antigravity-cli', 'other')).toBe(false);
  });
});

describe('recorded process marker liveness', () => {
  test('empty or invalid markers are unknown, not alive', () => {
    expect(probeRecordedWorkerProcess({ pid: 0, startMarker: 'tmux:session' })).toBe('unknown');
    expect(probeRecordedWorkerProcess({ pid: -3, startMarker: LSTART })).toBe('unknown');
    expect(probeRecordedWorkerProcess({ pid: PROVIDER_PID, startMarker: '' })).toBe('unknown');
    expect(probeRecordedWorkerProcess({ pid: PROVIDER_PID, startMarker: '   ' })).toBe('unknown');
    expect(probeTmuxSession('')).toBe('unknown');
    expect(probeTmuxSession('   ')).toBe('unknown');
  });

  test('providerLivenessFromResolution never treats unknown/orphan as alive', () => {
    expect(providerLivenessFromResolution({ status: 'unknown', panePid: null, children: [] })).toEqual({
      providerIdentityMatched: false,
      processLiveness: 'unknown',
    });
    expect(providerLivenessFromResolution({
      status: 'orphan',
      panePid: PANE_PID,
      pane: { pid: PANE_PID, startMarker: PANE_LSTART, comm: 'zsh' },
      children: [],
    })).toEqual({
      providerIdentityMatched: false,
      processLiveness: 'unknown',
    });
    expect(providerLivenessFromResolution({
      status: 'matched',
      panePid: PANE_PID,
      children: [],
      matched: { pid: PROVIDER_PID, startMarker: LSTART, comm: 'agy' },
    })).toEqual({
      providerIdentityMatched: true,
      processLiveness: 'alive',
    });
  });
});
