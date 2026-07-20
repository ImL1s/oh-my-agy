import * as fs from 'fs';
import * as path from 'path';
import { AutopilotRuntime } from '../../src/autopilot/runtime';
import { sha256 } from '../../src/runtime/atomic';
import { createStateFixture } from '../helpers/state-fixture';

function digest(value: string): string {
  return sha256(value);
}

function gateEvidence(
  kind:
    | 'deep-interview' | 'ralplan' | 'ultragoal' | 'code-review' | 'ultraqa'
    | 'requirements' | 'planning' | 'executing' | 'review' | 'qa' | 'production',
  workspaceKey: string,
) {
  const now = new Date().toISOString();
  const omxish = kind === 'code-review' || kind === 'review'
    ? 'oma.review/v1'
    : kind === 'ultraqa' || kind === 'qa'
      ? 'oma.qa/v1'
      : kind === 'production'
        ? 'oma.production-causal-trace/v1'
        : `oma.gate/${kind}`;
  const validatorId = omxish;
  return {
    schemaVersion: 1 as const,
    kind,
    actor: 'fixture-actor',
    validator: { id: validatorId, version: '1' },
    command: {
      argvDigest: digest(`cmd-${kind}`),
      exitCode: 0,
      startedAt: now,
      finishedAt: now,
    },
    artifact: {
      path: `artifacts/${kind}.json`,
      digest: digest(`artifact-${kind}`),
    },
    repoKey: null,
    workspaceKey,
    gitHead: null,
    invocationNonce: digest(`nonce-${kind}-${Math.random()}`),
  };
}

describe('Autopilot durable FSM runtime', () => {
  test('start → checkpoint → status → resume → cancel mutates durable aggregate', async () => {
    const fixture = createStateFixture('oma-ap-runtime-');
    try {
      const runtime = AutopilotRuntime.create({
        stateRoot: fixture.root,
        workspaceKey: 'ws-a',
        repoKey: null,
        sessionIdFactory: () => 'session-fixed',
      });
      expect(runtime.ok).toBe(true);
      if (!runtime.ok) return;

      const started = await runtime.value.dispatch(['start', '--', 'ship production runtime']);
      expect(started).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          sessionId: 'session-fixed',
          revision: 0,
          phase: 'deep-interview',
          goal: 'ship production runtime',
          phaseCycle: expect.arrayContaining(['deep-interview', 'ralplan', 'ultragoal']),
        }),
      }));

      const evidencePath = fixture.path('deep-interview.json');
      fs.writeFileSync(evidencePath, JSON.stringify(gateEvidence('deep-interview', 'ws-a')));
      const checkpoint = await runtime.value.dispatch([
        'advance', '--session', 'session-fixed', '--expected-revision', '0', '--evidence', evidencePath,
      ]);
      expect(checkpoint).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ phase: 'ralplan', revision: 1, acceptedEvidenceCount: 1 }),
      }));

      const status = await runtime.value.dispatch(['status', '--session', 'session-fixed']);
      expect(status).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ phase: 'ralplan', revision: 1 }),
      }));

      const resumed = await runtime.value.dispatch([
        'resume', '--session', 'session-fixed', '--conversation', 'conv-1', '--expected-revision', '1',
      ]);
      expect(resumed).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ conversationId: 'conv-1', revision: 2 }),
      }));

      const doctor = await runtime.value.dispatch(['doctor', '--session', 'session-fixed']);
      expect(doctor.ok).toBe(true);
      if (doctor.ok) {
        expect(doctor.value).toEqual(expect.objectContaining({
          phase: 'ralplan',
          healthy: true,
          aggregatePath: expect.stringContaining(path.join('sessions')),
        }));
      }

      const cancelled = await runtime.value.dispatch([
        'cancel', '--session', 'session-fixed', '--expected-revision', '2', '--reason', 'operator stop',
      ]);
      expect(cancelled).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          phase: 'cancelled',
          revision: 3,
          terminal: expect.objectContaining({ phase: 'cancelled', reason: 'operator stop' }),
        }),
      }));

      const blocked = await runtime.value.dispatch([
        'resume', '--session', 'session-fixed', '--conversation', 'conv-2', '--expected-revision', '3',
      ]);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error.code).toBe('E_TERMINAL_STATE');
    } finally {
      fixture.cleanup();
    }
  });

  test('qa does not complete; production gate is required for completed', async () => {
    const fixture = createStateFixture('oma-ap-gates-');
    try {
      const runtime = AutopilotRuntime.create({
        stateRoot: fixture.root,
        workspaceKey: 'ws-b',
        repoKey: null,
        sessionIdFactory: () => 'session-gates',
      });
      if (!runtime.ok) throw new Error(runtime.error.message);
      await runtime.value.start('finish gates');

      for (const kind of ['deep-interview', 'ralplan', 'ultragoal'] as const) {
        const current = await runtime.value.status('session-gates');
        if (!current.ok) throw new Error(current.error.message);
        const evidencePath = fixture.path(`${kind}.json`);
        fs.writeFileSync(evidencePath, JSON.stringify(gateEvidence(kind, 'ws-b')));
        const step = await runtime.value.acceptGate(
          'checkpoint',
          'session-gates',
          current.value.revision,
          evidencePath,
        );
        if (!step.ok) throw new Error(step.error.message);
      }

      let current = await runtime.value.status('session-gates');
      if (!current.ok) throw new Error(current.error.message);
      expect(current.value.phase).toBe('code-review');

      const reviewPath = fixture.path('review.json');
      fs.writeFileSync(reviewPath, JSON.stringify(gateEvidence('code-review', 'ws-b')));
      const reviewed = await runtime.value.dispatch([
        'review', '--session', 'session-gates',
        '--expected-revision', String(current.value.revision),
        '--evidence', reviewPath,
      ]);
      expect(reviewed).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ phase: 'ultraqa' }),
      }));

      current = await runtime.value.status('session-gates');
      if (!current.ok) throw new Error(current.error.message);
      const qaPath = fixture.path('qa.json');
      fs.writeFileSync(qaPath, JSON.stringify(gateEvidence('ultraqa', 'ws-b')));
      const qad = await runtime.value.dispatch([
        'qa', '--session', 'session-gates',
        '--expected-revision', String(current.value.revision),
        '--evidence', qaPath,
      ]);
      // PRD: qa alone must NOT complete
      expect(qad).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          phase: 'ultraqa',
          terminal: null,
        }),
      }));

      current = await runtime.value.status('session-gates');
      if (!current.ok) throw new Error(current.error.message);
      const prodPath = fixture.path('production.json');
      fs.writeFileSync(prodPath, JSON.stringify(gateEvidence('production', 'ws-b')));
      const completed = await runtime.value.dispatch([
        'checkpoint', '--session', 'session-gates',
        '--expected-revision', String(current.value.revision),
        '--evidence', prodPath,
      ]);
      expect(completed).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          phase: 'completed',
          terminal: expect.objectContaining({ phase: 'completed' }),
        }),
      }));
    } finally {
      fixture.cleanup();
    }
  });
});
