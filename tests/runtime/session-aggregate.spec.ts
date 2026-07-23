import * as fs from 'fs';
import { AtomicFaultPoint, FaultInjector, sha256 } from '../../src/runtime/atomic';
import {
  SessionAggregateStore,
  createInitialSessionAggregate,
} from '../../src/continuation/session-aggregate';
import { ProgressOracleV1 } from '../../src/continuation/progress-oracle';
import { StopEventIdentity } from '../../src/continuation/event-identity';
import { createStateFixture } from '../helpers/state-fixture';

class OneShotFault implements FaultInjector {
  armed = true;

  constructor(readonly point: AtomicFaultPoint) {}

  inject(point: AtomicFaultPoint): void {
    if (this.armed && point === this.point) throw new Error(`fault:${point}`);
  }
}

const eligibility = {
  fullyIdle: true,
  terminationReason: 'model_stop',
  hasRetryableBlocker: false,
  hasInteractionBlocker: false,
  hasLiveCommand: false,
};

describe('SessionAggregateV1 atomic Stop contract', () => {
  test('duplicate Stop replays byte-identical decision and conflicting input is rejected', async () => {
    const fixture = createStateFixture('oma-aggregate-');
    const store = new SessionAggregateStore(fixture.path('aggregate.json'));
    const oracle = new ProgressOracleV1();
    const identity: StopEventIdentity = {
      conversationId: 'conversation-1',
      invocationGeneration: 1,
      executionNum: 0,
    };
    const fingerprint = oracle.fingerprint({
      acceptedGateRevisions: [],
      acceptedTaskProgressRevisions: [],
      acceptedEvidenceRevisionsAndDigests: [],
      verifiedArtifactDigests: [],
    });
    try {
      await store.initialize(createInitialSessionAggregate({
        sessionId: 'session-1',
        repoKey: null,
        workspaceKey: 'workspace-A',
        launchNonceDigest: sha256('nonce'),
      }));
      expect(fs.readFileSync(fixture.path('aggregate.json')).at(-1)).not.toBe(0x0a);
      const inputDigest = sha256('stop-input');
      const applied = await store.commitStop(
        identity,
        inputDigest,
        (snapshot) => oracle.reduceStop(snapshot, identity, fingerprint, eligibility),
      );
      expect(applied).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ kind: 'Applied' }),
      }));
      if (!applied.ok) return;

      const replayed = await store.commitStop(
        identity,
        inputDigest,
        (snapshot) => oracle.reduceStop(snapshot, identity, fingerprint, eligibility),
      );
      expect(replayed).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          kind: 'Replayed',
          decisionJson: applied.value.decisionJson,
        }),
      }));
      const conflict = await store.commitStop(
        identity,
        sha256('different-input'),
        (snapshot) => oracle.reduceStop(snapshot, identity, fingerprint, eligibility),
      );
      expect(conflict).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'E_STOP_EVENT_CONFLICT' }),
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test('non-Stop CAS advances the same aggregate and cannot rewrite processed Stop history', async () => {
    const fixture = createStateFixture('oma-aggregate-cas-');
    const store = new SessionAggregateStore(fixture.path('aggregate.json'));
    try {
      await store.initialize(createInitialSessionAggregate({
        sessionId: 's', repoKey: null, workspaceKey: 'w', launchNonceDigest: sha256('n'),
      }));
      const advanced = await store.compareAndSwap(0, (snapshot) => ({
        ...snapshot,
        revision: snapshot.revision + 1,
        autopilot: {
          ...snapshot.autopilot,
          acceptedGateRevisions: [1],
          progressFingerprint: sha256('gate-1'),
          noProgressStreak: 0,
        },
      }));
      expect(advanced).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ revision: 1 }),
      }));
      const stale = await store.compareAndSwap(0, (snapshot) => ({
        ...snapshot,
        revision: 1,
      }));
      expect(stale).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'E_REVISION_CONFLICT' }),
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test('concurrent duplicate commits converge once and the third no-progress event trips', async () => {
    const fixture = createStateFixture('oma-aggregate-concurrent-');
    const store = new SessionAggregateStore(fixture.path('aggregate.json'));
    const oracle = new ProgressOracleV1();
    const fingerprint = sha256('same-progress');
    const firstIdentity = { conversationId: 'c', invocationGeneration: 1, executionNum: 0 };
    try {
      await store.initialize(createInitialSessionAggregate({
        sessionId: 's', repoKey: null, workspaceKey: 'w', launchNonceDigest: sha256('n'),
      }));
      const concurrent = await Promise.all(Array.from({ length: 20 }, () => store.commitStop(
        firstIdentity,
        sha256('same-input'),
        (snapshot) => oracle.reduceStop(snapshot, firstIdentity, fingerprint, eligibility),
      )));
      expect(concurrent.filter((result) => result.ok && result.value.kind === 'Applied')).toHaveLength(1);
      expect(concurrent.filter((result) => result.ok && result.value.kind === 'Replayed')).toHaveLength(19);
      expect(store.read()).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          revision: 1,
          autopilot: expect.objectContaining({ noProgressStreak: 1 }),
        }),
      }));

      for (const executionNum of [1, 2]) {
        const identity = { conversationId: 'c', invocationGeneration: 1, executionNum };
        const committed = await store.commitStop(
          identity,
          sha256(`input-${executionNum}`),
          (snapshot) => oracle.reduceStop(snapshot, identity, fingerprint, eligibility),
        );
        expect(committed.ok).toBe(true);
      }
      expect(store.read()).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          revision: 3,
          autopilot: expect.objectContaining({ phase: 'tripped', noProgressStreak: 3 }),
        }),
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test.each<AtomicFaultPoint>([
    'record-only-candidate',
    'state-only-candidate',
    'temp-fsync-before-rename',
  ])('%s leaves the authoritative aggregate at the complete preimage', async (point) => {
    const fixture = createStateFixture(`oma-cut-${point}-`);
    const fault = new OneShotFault(point);
    // 初始化路徑也走 atomic write；故障注入只應命中 commitStop 的 cut point。
    fault.armed = false;
    const store = new SessionAggregateStore(fixture.path('aggregate.json'), { faultInjector: fault });
    const oracle = new ProgressOracleV1();
    const identity = { conversationId: 'c', invocationGeneration: 1, executionNum: 0 };
    const fingerprint = sha256('progress');
    try {
      await store.initialize(createInitialSessionAggregate({
        sessionId: 's', repoKey: null, workspaceKey: 'w', launchNonceDigest: sha256('n'),
      }));
      fault.armed = true;
      await expect(store.commitStop(
        identity,
        sha256('input'),
        (snapshot) => oracle.reduceStop(snapshot, identity, fingerprint, eligibility),
      )).rejects.toThrow(`fault:${point}`);
      const readback = store.read();
      expect(readback).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ revision: 0, processedStops: {} }),
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test('rename-before-reply makes the complete revision replayable', async () => {
    const fixture = createStateFixture('oma-cut-rename-');
    const fault = new OneShotFault('rename-before-reply');
    // 初始化完成後才武裝，避免 atomic initialize 先觸發 rename cut。
    fault.armed = false;
    const store = new SessionAggregateStore(fixture.path('aggregate.json'), { faultInjector: fault });
    const oracle = new ProgressOracleV1();
    const identity = { conversationId: 'c', invocationGeneration: 1, executionNum: 0 };
    const inputDigest = sha256('input');
    const fingerprint = sha256('progress');
    try {
      await store.initialize(createInitialSessionAggregate({
        sessionId: 's', repoKey: null, workspaceKey: 'w', launchNonceDigest: sha256('n'),
      }));
      fault.armed = true;
      await expect(store.commitStop(
        identity,
        inputDigest,
        (snapshot) => oracle.reduceStop(snapshot, identity, fingerprint, eligibility),
      )).rejects.toThrow('fault:rename-before-reply');
      const readback = store.read();
      expect(readback).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ revision: 1 }),
      }));
      if (!readback.ok) return;
      expect(Object.keys(readback.value.processedStops)).toHaveLength(1);

      fault.armed = false;
      const replay = await store.commitStop(
        identity,
        inputDigest,
        (snapshot) => oracle.reduceStop(snapshot, identity, fingerprint, eligibility),
      );
      expect(replay).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ kind: 'Replayed' }),
      }));
      expect(store.read()).toEqual(readback);
    } finally {
      fixture.cleanup();
    }
  });
});
