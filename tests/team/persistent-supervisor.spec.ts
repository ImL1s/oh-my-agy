import { sha256 } from '../../src/runtime/atomic';
import { TeamStateStore } from '../../src/team/state';
import { TeamOrchestrator, listReadyTaskSpecs } from '../../src/team/orchestrator';
import {
  PersistentTeamSupervisor,
  reconcileWorkerObservation,
} from '../../src/team/supervisor-control';
import { TeamAggregateV1, WorkerAuthorityBindingV1 } from '../../src/team/types';
import { createStateFixture } from '../helpers/state-fixture';

function binding(provider: WorkerAuthorityBindingV1['provider']): WorkerAuthorityBindingV1 {
  return {
    schemaVersion: 1, taskId: 'task', claimTokenDigest: sha256('claim'), generation: 1,
    provider, providerReceiptHash: sha256(provider), state: 'running', transitionSequence: 2, boundAtMs: 1,
    ...(provider === 'antigravity_native' ? {
      conversation: {
        schemaVersion: 1 as const, provider: 'antigravity_native' as const, conversationId: 'conversation',
        receiptId: 'receipt', generation: 1, observedAtMs: 1, capabilityDigest: sha256('capability'),
      },
    } : { process: { pid: 42, startMarker: 'start' } }),
    ...(provider === 'tmux_agy' ? {
      pane: { schemaVersion: 1 as const, sessionName: 'session', paneId: '%1', ownerNonce: 'owner', workerNonce: 'worker' },
    } : {}),
  };
}

function aggregate(provider: WorkerAuthorityBindingV1['provider']): TeamAggregateV1 {
  return {
    schemaVersion: 1, teamId: 'team', repoKey: 'repo', leaderWorkspaceKey: 'workspace', ownerNonce: 'owner',
    manifest: {
      schema: 'oma.team-manifest/v1', teamId: 'team', revision: 1, repoRoot: '/tmp',
      tasks: [{ id: 'task', dependencies: [], write_scope: 'none', mode: 'read_only', verification: { version: 1, commands: [], requiredArtifacts: [] } }],
    },
    tasks: { task: { id: 'task', revision: 1, status: 'in_progress', commandEvidence: {}, claim: { ownerId: 'worker', token: 'claim', generation: 1, leasedUntilMs: 1 } } },
    heartbeats: {}, mailbox: {}, workerBindings: { task: binding(provider) }, mailboxCursors: {}, terminalReceipts: {},
  };
}

describe('persistent supervisor adoption and recovery', () => {
  test('checks exact process+pane identities and only DeadProof schedules generation+1 recovery', () => {
    const headless = aggregate('agy_headless');
    const live = reconcileWorkerObservation(headless, {
      taskId: 'task', generation: 1, providerReceiptHash: sha256('agy_headless'),
      process: { pid: 42, startMarker: 'start' }, processLiveness: 'alive', paneLiveness: 'dead',
    });
    expect(live.action).toBe('adopt');
    const killed = reconcileWorkerObservation(headless, {
      taskId: 'task', generation: 1, providerReceiptHash: sha256('agy_headless'),
      process: { pid: 42, startMarker: 'start' }, processLiveness: 'dead', paneLiveness: 'dead', exitCode: 137,
    });
    expect(killed.action).toBe('reclaim_generation_plus_one');
    const pidReuse = reconcileWorkerObservation(headless, {
      taskId: 'task', generation: 1, providerReceiptHash: sha256('agy_headless'),
      process: { pid: 42, startMarker: 'different' }, processLiveness: 'alive', paneLiveness: 'dead',
    });
    expect(pidReuse.action).toBe('fence_stale_observation');

    const tmux = aggregate('tmux_agy');
    expect(reconcileWorkerObservation(tmux, {
      taskId: 'task', generation: 1, providerReceiptHash: sha256('tmux_agy'),
      process: { pid: 42, startMarker: 'start' }, pane: binding('tmux_agy').pane,
      processLiveness: 'dead', paneLiveness: 'alive',
    }).action).toBe('block_identity_unproven');
    expect(reconcileWorkerObservation(tmux, {
      taskId: 'task', generation: 1, providerReceiptHash: sha256('tmux_agy'),
      process: { pid: 42, startMarker: 'start' }, pane: binding('tmux_agy').pane,
      processLiveness: 'alive', paneLiveness: 'alive', providerIdentityMatched: true,
    }).action).toBe('adopt');
    expect(reconcileWorkerObservation(tmux, {
      taskId: 'task', generation: 1, providerReceiptHash: sha256('tmux_agy'),
      process: { pid: 42, startMarker: 'start' }, pane: binding('tmux_agy').pane,
      processLiveness: 'dead', paneLiveness: 'dead',
    }).action).toBe('reclaim_generation_plus_one');
  });

  test('native conversation health is required and exact terminal receipt reconciles exit', () => {
    const native = aggregate('antigravity_native');
    expect(reconcileWorkerObservation(native, {
      taskId: 'task', generation: 1, providerReceiptHash: sha256('antigravity_native'),
      processLiveness: 'unknown', paneLiveness: 'unknown', nativeConversationHealthy: true,
    }).action).toBe('adopt');
    expect(reconcileWorkerObservation(native, {
      taskId: 'task', generation: 1, providerReceiptHash: sha256('antigravity_native'),
      processLiveness: 'unknown', paneLiveness: 'unknown', nativeConversationHealthy: false,
    }).action).toBe('block_identity_unproven');
    native.workerBindings = { task: { ...binding('antigravity_native'), state: 'terminal', transitionSequence: 6 } };
    native.terminalReceipts = { 'task:g1': {
      schemaVersion: 1, taskId: 'task', generation: 1, provider: 'antigravity_native',
      providerReceiptHash: sha256('antigravity_native'), transitionSequence: 6, outcome: 'completed',
      capabilityPlaintextRemoved: true, recordedAtMs: 2,
    } };
    expect(reconcileWorkerObservation(native, {
      taskId: 'task', generation: 1, providerReceiptHash: sha256('antigravity_native'),
      processLiveness: 'unknown', paneLiveness: 'unknown', nativeConversationHealthy: false, exitCode: 0,
    }).action).toBe('terminal_reconciled');
  });

  test('Unknown supervision quarantines the task without clearing or requeueing its claim', async () => {
    const fixture = createStateFixture('oma-supervisor-unknown-');
    try {
      const store = new TeamStateStore(fixture.root, 'repo', 'workspace', 'team');
      const created = await store.create(aggregate('agy_headless').manifest, 'owner');
      if (!created.ok) throw new Error(created.error.message);
      const claimed = await store.claimTask('task', 'worker', created.value.revision, 0, 1, 'claim');
      if (!claimed.ok) throw new Error(claimed.error.message);
      const authority = { ...binding('agy_headless'), state: 'claimed' as const, transitionSequence: 0 };
      const bound = await store.bindWorkerAuthority(claimed.value.revision, 'claim', authority);
      if (!bound.ok) throw new Error(bound.error.message);
      const orchestrator = new TeamOrchestrator({
        stateRoot: fixture.root,
        workspaceRoot: fixture.root,
        repoKey: 'repo',
        workspaceKey: 'workspace',
        managedWorktreesRoot: fixture.path('worktrees'),
        nowMs: () => 2,
      });

      const supervised = await orchestrator.superviseOnce('team');
      expect(supervised.ok).toBe(true);
      const after = store.read();
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.value.tasks.task.status).toBe('orphan_identity_unproven');
      expect(after.value.value.tasks.task.claim).toEqual(bound.value.value.tasks.task.claim);
      expect(after.value.value.workerBindings?.task).toEqual(authority);
      expect(listReadyTaskSpecs(after.value.value.manifest, after.value.value)).toEqual([]);
      expect((await store.claimTask('task', 'worker-2', after.value.revision, 3, 1, 'claim-2')).ok).toBe(false);
    } finally { fixture.cleanup(); }
  });

  test('supervisor restart uses a persistent generation lease and rejects premature/stale owners', async () => {
    const fixture = createStateFixture('oma-supervisor-');
    try {
      const store = new TeamStateStore(fixture.root, 'repo', 'workspace', 'team');
      const created = await store.create(aggregate('agy_headless').manifest, 'owner');
      if (!created.ok) throw new Error(created.error.message);
      const first = new PersistentTeamSupervisor({
        store, ownerToken: 'supervisor-1', process: { pid: 100, startMarker: 'first' }, leaseMs: 50,
      });
      const acquired = await first.acquire(created.value.revision, 100);
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      const premature = new PersistentTeamSupervisor({
        store, ownerToken: 'supervisor-2', process: { pid: 101, startMarker: 'second' }, leaseMs: 50,
      });
      expect((await premature.acquire(acquired.value.revision, 120)).ok).toBe(false);
      const adopted = await premature.acquire(acquired.value.revision, 151);
      expect(adopted.ok).toBe(true);
      if (!adopted.ok) return;
      expect(adopted.value.value.supervisor?.generation).toBe(2);
      expect((await first.progress(adopted.value.revision, 1, 160)).ok).toBe(false);
      expect((await premature.progress(adopted.value.revision, 2, 160)).ok).toBe(true);
    } finally { fixture.cleanup(); }
  });
});
