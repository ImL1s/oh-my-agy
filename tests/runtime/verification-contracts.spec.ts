import { sha256 } from '../../src/runtime/atomic';
import { createInitialSessionAggregate } from '../../src/continuation/session-aggregate';
import { GateEvidenceV1, GateValidator } from '../../src/verification/evidence';
import {
  CausalTracePayloadV1,
  CausalTraceValidatorV1,
  appendCausalTraceEvent,
} from '../../src/verification/causal-trace';

describe('verification contract skeletons', () => {
  test('GateValidator binds accepted evidence to workspace and runner kind', () => {
    const snapshot = createInitialSessionAggregate({
      sessionId: 'session',
      repoKey: 'repo',
      workspaceKey: 'workspace',
      launchNonceDigest: sha256('nonce'),
    });
    const evidence: GateEvidenceV1 = {
      schemaVersion: 1,
      kind: 'review',
      actor: 'independent-reviewer',
      validator: { id: 'oma.review/v1', version: '1' },
      command: {
        argvDigest: sha256('argv'),
        exitCode: 0,
        startedAt: '2026-07-20T00:00:00.000Z',
        finishedAt: '2026-07-20T00:00:01.000Z',
      },
      artifact: { path: 'review.json', digest: sha256('artifact') },
      repoKey: 'repo',
      workspaceKey: 'workspace',
      gitHead: null,
      invocationNonce: 'nonce',
    };
    expect(new GateValidator().validate('review', evidence, snapshot)).toEqual({
      kind: 'Accepted',
      evidence,
    });
    expect(new GateValidator().validate('qa', evidence, snapshot)).toEqual(expect.objectContaining({
      kind: 'Rejected',
    }));
  });

  test('CausalTraceValidatorV1 accepts only same-invocation continue then final allow', () => {
    const common: CausalTracePayloadV1 = {
      launchTransactionId: 'launch-1',
      wrapperPid: 10,
      wrapperStartMarker: 'wrapper-start',
      childPid: 11,
      childStartMarker: 'child-start',
      sessionId: 'session-1',
      conversationId: null,
      invocationGeneration: 1,
      workspaceKey: 'workspace-1',
      launchNonceDigest: sha256('nonce'),
    };
    const trace = [] as ReturnType<typeof appendCausalTraceEvent>[];
    const push = (type: Parameters<typeof appendCausalTraceEvent>[1], payload: CausalTracePayloadV1) => {
      trace.push(appendCausalTraceEvent(trace, type, trace.length + 1, payload));
    };
    push('launch_prepared', common);
    push('child_spawned', common);
    const bound = { ...common, conversationId: 'conversation-1' };
    push('preinvocation_bound', { ...bound, bindingRoute: 'exact_env' });
    push('stop_processed', { ...bound, executionNum: 0, decision: 'continue' });
    push('process_alive', bound);
    push('stop_processed', { ...bound, executionNum: 1, decision: 'allow' });
    push('child_exit', { ...bound, exitCode: 0, signal: null });

    expect(new CausalTraceValidatorV1().validate(trace)).toEqual(expect.objectContaining({
      kind: 'SameInvocationContinueProof',
      firstExecutionNum: 0,
      finalExecutionNum: 1,
    }));

    const tampered = structuredClone(trace);
    tampered[4].payload.childPid = 99;
    expect(new CausalTraceValidatorV1().validate(tampered)).toEqual(expect.objectContaining({
      kind: 'Rejected',
      error: expect.objectContaining({ code: 'E_CAUSAL_TRACE_INVALID' }),
    }));
  });
});

