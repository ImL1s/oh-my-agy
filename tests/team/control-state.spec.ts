import { sha256 } from '../../src/runtime/atomic';
import { TeamStateStore } from '../../src/team/state';
import { CanonicalTeamManifestV1, WorkerAuthorityBindingV1 } from '../../src/team/types';
import { createStateFixture } from '../helpers/state-fixture';

const manifest: CanonicalTeamManifestV1 = {
  schema: 'oma.team-manifest/v1',
  teamId: 'team-control',
  revision: 1,
  repoRoot: '/tmp',
  tasks: [{
    id: 'task', dependencies: [], mode: 'headless', write_scope: [{ kind: 'dir', path: 'src/team' }],
    verification: { version: 1, commands: [], requiredArtifacts: [] },
  }],
};

function binding(generation = 1): WorkerAuthorityBindingV1 {
  return {
    schemaVersion: 1,
    taskId: 'task',
    claimTokenDigest: sha256(`claim-${generation}`),
    generation,
    provider: 'agy_headless',
    providerReceiptHash: sha256(`provider-${generation}`),
    process: { pid: 123, startMarker: `start-${generation}` },
    state: 'claimed',
    transitionSequence: 0,
    boundAtMs: 100,
  };
}

async function claimedStore() {
  const fixture = createStateFixture('oma-control-state-');
  const store = new TeamStateStore(fixture.root, 'repo', 'workspace', manifest.teamId);
  const created = await store.create(manifest, 'owner');
  if (!created.ok) throw new Error(created.error.message);
  const claimed = await store.claimTask('task', 'worker', created.value.revision, 100, 50, 'claim-1');
  if (!claimed.ok) throw new Error(claimed.error.message);
  const bound = await store.bindWorkerAuthority(claimed.value.revision, 'claim-1', binding());
  if (!bound.ok) throw new Error(bound.error.message);
  return { fixture, store, revision: bound.value.revision };
}

describe('CLI-CAS worker authority and ordered mailbox', () => {
  test('heartbeat proves liveness but only substantive progress renews claim', async () => {
    const { fixture, store, revision } = await claimedStore();
    try {
      const heartbeat = await store.recordWorkerHeartbeat(revision, {
        schemaVersion: 1,
        taskId: 'task',
        claimTokenDigest: sha256('claim-1'),
        generation: 1,
        provider: 'agy_headless',
        providerReceiptHash: sha256('provider-1'),
        process: { pid: 123, startMarker: 'start-1' },
        recordedAtMs: 140,
      });
      expect(heartbeat.ok).toBe(true);
      if (!heartbeat.ok) return;
      expect(heartbeat.value.value.tasks.task.claim?.leasedUntilMs).toBe(150);
      const progressed = await store.recordProgress(heartbeat.value.revision, {
        schemaVersion: 1,
        taskId: 'task',
        taskRevision: 1,
        claimToken: 'claim-1',
        generation: 1,
        kind: 'checkpoint',
        artifactDigest: sha256('progress'),
        child: { pid: 123, startMarker: 'start-1' },
        providerReceiptHash: sha256('provider-1'),
        recordedAtMs: 160,
      }, 100);
      expect(progressed.ok).toBe(true);
      if (progressed.ok) expect(progressed.value.value.tasks.task.claim?.leasedUntilMs).toBe(260);

      const stale = await store.recordWorkerHeartbeat(
        progressed.ok ? progressed.value.revision : heartbeat.value.revision,
        {
          schemaVersion: 1, taskId: 'task', claimTokenDigest: sha256('claim-1'), generation: 2,
          provider: 'agy_headless', providerReceiptHash: sha256('provider-1'),
          process: { pid: 123, startMarker: 'start-1' }, recordedAtMs: 170,
        },
      );
      expect(stale.ok).toBe(false);
    } finally { fixture.cleanup(); }
  });

  test('mailbox list/read/ack resumes from an exact generation-fenced cursor', async () => {
    const { fixture, store, revision } = await claimedStore();
    try {
      const first = await store.sendOrderedMailbox(revision, 'task', 1, {
        schemaVersion: 1, id: 'm1', sender: 'leader', bodyDigest: sha256('one'), createdAtMs: 110,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const second = await store.sendOrderedMailbox(first.value.revision, 'task', 1, {
        schemaVersion: 1, id: 'm2', sender: 'leader', bodyDigest: sha256('two'), createdAtMs: 120,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      const batch = store.listOrderedMailbox({ taskId: 'task', claimToken: 'claim-1', generation: 1, afterCursor: 0 });
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;
      expect(batch.value.messages.map((message) => [message.id, message.sequence])).toEqual([['m1', 1], ['m2', 2]]);
      const ack = await store.acknowledgeOrderedMailbox({
        expectedRevision: second.value.revision, taskId: 'task', claimToken: 'claim-1', generation: 1,
        expectedCursor: 0, nextCursor: 2, messageIds: ['m1', 'm2'], acknowledgedAtMs: 130,
      });
      expect(ack.ok).toBe(true);
      const resumed = store.listOrderedMailbox({ taskId: 'task', claimToken: 'claim-1', generation: 1, afterCursor: 2 });
      expect(resumed.ok && resumed.value.messages).toEqual([]);
      const stale = await store.acknowledgeOrderedMailbox({
        expectedRevision: ack.ok ? ack.value.revision : second.value.revision,
        taskId: 'task', claimToken: 'claim-1', generation: 1,
        expectedCursor: 0, nextCursor: 1, messageIds: ['m1'], acknowledgedAtMs: 140,
      });
      expect(stale.ok).toBe(false);
    } finally { fixture.cleanup(); }
  });

  test('DeadProof recovery preserves generation and fences stale capability/heartbeat', async () => {
    const { fixture, store, revision } = await claimedStore();
    try {
      const released = await store.releaseClaimAfterDeadProof('task', revision);
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      const reclaimed = await store.claimTask('task', 'worker-2', released.value.revision, 200, 50, 'claim-2');
      expect(reclaimed.ok).toBe(true);
      if (!reclaimed.ok) return;
      expect(reclaimed.value.value.tasks.task.claim?.generation).toBe(2);
      const rebound = await store.bindWorkerAuthority(reclaimed.value.revision, 'claim-2', binding(2));
      expect(rebound.ok).toBe(true);
      if (!rebound.ok) return;
      const stale = await store.recordWorkerHeartbeat(rebound.value.revision, {
        schemaVersion: 1, taskId: 'task', claimTokenDigest: sha256('claim-1'), generation: 1,
        provider: 'agy_headless', providerReceiptHash: sha256('provider-1'),
        process: { pid: 123, startMarker: 'start-1' }, recordedAtMs: 210,
      });
      expect(stale.ok).toBe(false);
    } finally { fixture.cleanup(); }
  });

  test('delivery is accepted only from the active generation in delivery_ready state', async () => {
    const { fixture, store, revision } = await claimedStore();
    try {
      const delivery = {
        schemaVersion: 1 as const,
        taskId: 'task',
        taskRevision: 1,
        manifestRevision: 1,
        claimToken: 'claim-1',
        generation: 1,
        baseSha: sha256('base'),
        orderedCommits: [sha256('commit')],
        headSha: sha256('commit'),
        cleanStatusDigest: sha256('clean'),
        commandEvidenceIds: [],
        workerWorkspaceKey: 'worker-workspace',
        workerWorktreeRealpath: '/tmp/worker-worktree',
        scopeDiffDigest: sha256('scope'),
      };
      const premature = await store.acceptDelivery(revision, delivery);
      expect(premature.ok).toBe(false);

      let currentRevision = revision;
      const steps = [
        ['claimed', 'launched'], ['launched', 'running'], ['running', 'verifying'],
        ['verifying', 'delivery_ready'],
      ] as const;
      for (const [sequence, [expectedState, nextState]] of steps.entries()) {
        const moved = await store.transitionWorkerAuthority({
          expectedRevision: currentRevision, taskId: 'task', claimToken: 'claim-1', generation: 1,
          providerReceiptHash: sha256('provider-1'), expectedState, expectedSequence: sequence, nextState,
        });
        expect(moved.ok).toBe(true);
        if (!moved.ok) return;
        currentRevision = moved.value.revision;
      }

      const stale = await store.acceptDelivery(currentRevision, {
        ...delivery,
        generation: 0,
      });
      expect(stale.ok).toBe(false);
      const accepted = await store.acceptDelivery(currentRevision, delivery);
      expect(accepted.ok).toBe(true);
      if (accepted.ok) expect(accepted.value.value.tasks.task.status).toBe('delivered_unintegrated');
    } finally { fixture.cleanup(); }
  });

  test('terminal receipt is immutable and requires capability cleanup after ordered transitions', async () => {
    const { fixture, store } = await claimedStore();
    try {
      const current = store.read();
      if (!current.ok) throw new Error(current.error.message);
      let revision = current.value.revision;
      const steps = [
        ['claimed', 'launched'], ['launched', 'running'], ['running', 'verifying'],
        ['verifying', 'delivery_ready'], ['delivery_ready', 'integration_requested'],
      ] as const;
      let sequence = 0;
      for (const [expectedState, nextState] of steps) {
        const moved = await store.transitionWorkerAuthority({
          expectedRevision: revision, taskId: 'task', claimToken: 'claim-1', generation: 1,
          providerReceiptHash: sha256('provider-1'), expectedState, expectedSequence: sequence, nextState,
        });
        expect(moved.ok).toBe(true);
        if (!moved.ok) return;
        revision = moved.value.revision;
        sequence += 1;
      }
      const receipt = {
        schemaVersion: 1 as const, taskId: 'task', generation: 1, provider: 'agy_headless' as const,
        providerReceiptHash: sha256('provider-1'), transitionSequence: 6,
        outcome: 'failed' as const, capabilityPlaintextRemoved: true as const, recordedAtMs: 300,
      };
      const terminal = await store.terminalizeWorker({
        expectedRevision: revision, claimToken: 'claim-1', expectedState: 'integration_requested', expectedSequence: 5, receipt,
      });
      expect(terminal.ok).toBe(true);
      if (!terminal.ok) return;
      expect(terminal.value.value.tasks.task.status).toBe('failed');
      expect(terminal.value.value.workerBindings?.task.state).toBe('terminal');
      const replay = await store.terminalizeWorker({
        expectedRevision: terminal.value.revision, expectedState: 'integration_requested', expectedSequence: 5, receipt,
      });
      expect(replay.ok).toBe(true);
      const changed = await store.terminalizeWorker({
        expectedRevision: terminal.value.revision, expectedState: 'integration_requested', expectedSequence: 5,
        receipt: { ...receipt, recordedAtMs: 301 },
      });
      expect(changed.ok).toBe(false);
    } finally { fixture.cleanup(); }
  });
});
