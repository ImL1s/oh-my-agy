import { canonicalJson, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';

export type CausalTraceEventType =
  | 'launch_prepared'
  | 'resume_prepared'
  | 'child_spawned'
  | 'preinvocation_bound'
  | 'stop_processed'
  | 'process_alive'
  | 'child_exit';

export interface CausalTraceIdentityV1 {
  launchTransactionId: string;
  wrapperPid: number;
  wrapperStartMarker: string;
  childPid: number;
  childStartMarker: string;
  sessionId: string;
  conversationId: string | null;
  invocationGeneration: number;
  workspaceKey: string;
  launchNonceDigest: string;
}

export interface CausalTracePayloadV1 extends CausalTraceIdentityV1 {
  [key: string]: unknown;
}

export interface CausalTraceEventV1 {
  seq: number;
  prevDigest: string | null;
  eventDigest: string;
  type: CausalTraceEventType;
  monotonicTime: number;
  payload: CausalTracePayloadV1;
}

export interface SameInvocationContinueProof {
  kind: 'SameInvocationContinueProof';
  launchTransactionId: string;
  sessionId: string;
  conversationId: string;
  invocationGeneration: number;
  firstExecutionNum: number;
  finalExecutionNum: number;
  childPid: number;
  headDigest: string;
}

export interface RejectedCausalTrace {
  kind: 'Rejected';
  error: RuntimeError;
}

export type CausalTraceValidationResult = SameInvocationContinueProof | RejectedCausalTrace;

export function causalEventDigest(event: Omit<CausalTraceEventV1, 'eventDigest'>): string {
  return sha256(canonicalJson(event));
}

export function appendCausalTraceEvent(
  trace: readonly CausalTraceEventV1[],
  type: CausalTraceEventType,
  monotonicTime: number,
  payload: CausalTracePayloadV1,
): CausalTraceEventV1 {
  const eventWithoutDigest = {
    seq: trace.length,
    prevDigest: trace.length === 0 ? null : trace[trace.length - 1].eventDigest,
    type,
    monotonicTime,
    payload,
  };
  return { ...eventWithoutDigest, eventDigest: causalEventDigest(eventWithoutDigest) };
}

export class CausalTraceValidatorV1 {
  validate(trace: readonly CausalTraceEventV1[]): CausalTraceValidationResult {
    if (trace.length < 7) return rejected('Causal trace is incomplete');
    for (let index = 0; index < trace.length; index += 1) {
      const event = trace[index];
      if (
        event.seq !== index
        || event.prevDigest !== (index === 0 ? null : trace[index - 1].eventDigest)
        || event.eventDigest !== causalEventDigest({
          seq: event.seq,
          prevDigest: event.prevDigest,
          type: event.type,
          monotonicTime: event.monotonicTime,
          payload: event.payload,
        })
        || (index > 0 && event.monotonicTime < trace[index - 1].monotonicTime)
      ) {
        return rejected('Causal trace hash chain or ordering is invalid');
      }
    }

    const baseline = trace[0].payload;
    for (const event of trace) {
      const identity = event.payload;
      if (
        identity.launchTransactionId !== baseline.launchTransactionId
        || identity.wrapperPid !== baseline.wrapperPid
        || identity.wrapperStartMarker !== baseline.wrapperStartMarker
        || identity.childPid !== baseline.childPid
        || identity.childStartMarker !== baseline.childStartMarker
        || identity.sessionId !== baseline.sessionId
        || identity.invocationGeneration !== baseline.invocationGeneration
        || identity.workspaceKey !== baseline.workspaceKey
        || identity.launchNonceDigest !== baseline.launchNonceDigest
      ) {
        return rejected('Causal trace combines different invocation identities');
      }
    }

    if (trace[0].type !== 'launch_prepared') return rejected('Trace must begin with launch_prepared');
    const spawnIndex = trace.findIndex((event) => event.type === 'child_spawned');
    const bindIndex = trace.findIndex((event) => event.type === 'preinvocation_bound');
    if (spawnIndex <= 0 || bindIndex <= spawnIndex || trace[bindIndex].payload.bindingRoute !== 'exact_env') {
      return rejected('Trace lacks ordered exact-env binding');
    }
    const conversationId = trace[bindIndex].payload.conversationId;
    if (typeof conversationId !== 'string' || conversationId === '') {
      return rejected('Bound trace lacks a conversation ID');
    }
    for (const event of trace.slice(bindIndex)) {
      if (event.payload.conversationId !== conversationId) {
        return rejected('Conversation identity changed after binding');
      }
    }

    const stopIndexes = trace
      .map((event, index) => event.type === 'stop_processed' ? index : -1)
      .filter((index) => index >= 0);
    if (stopIndexes.length !== 2) return rejected('Trace must contain exactly two processed Stop events');
    const firstStop = trace[stopIndexes[0]];
    const finalStop = trace[stopIndexes[1]];
    const firstExecutionNum = firstStop.payload.executionNum;
    const finalExecutionNum = finalStop.payload.executionNum;
    if (
      firstStop.payload.decision !== 'continue'
      || finalStop.payload.decision !== 'allow'
      || !Number.isSafeInteger(firstExecutionNum)
      || !Number.isSafeInteger(finalExecutionNum)
      || (finalExecutionNum as number) !== (firstExecutionNum as number) + 1
    ) {
      return rejected('Stop continuation/final decision sequence is invalid');
    }
    const between = trace.slice(stopIndexes[0] + 1, stopIndexes[1]);
    if (!between.some((event) => event.type === 'process_alive')) {
      return rejected('Trace lacks same-child liveness after continue');
    }
    if (between.some((event) => ['child_exit', 'launch_prepared', 'resume_prepared'].includes(event.type))) {
      return rejected('Trace relaunched, resumed, or exited between Stop events');
    }
    const exits = trace
      .map((event, index) => event.type === 'child_exit' ? index : -1)
      .filter((index) => index >= 0);
    if (exits.length !== 1 || exits[0] <= stopIndexes[1]) {
      return rejected('Child must exit exactly once after the final allow');
    }
    const exit = trace[exits[0]];
    if (exit.payload.exitCode !== 0 || (exit.payload.signal !== null && exit.payload.signal !== undefined)) {
      return rejected('Child did not exit normally after final allow');
    }

    return {
      kind: 'SameInvocationContinueProof',
      launchTransactionId: baseline.launchTransactionId,
      sessionId: baseline.sessionId,
      conversationId,
      invocationGeneration: baseline.invocationGeneration,
      firstExecutionNum: firstExecutionNum as number,
      finalExecutionNum: finalExecutionNum as number,
      childPid: baseline.childPid,
      headDigest: trace[trace.length - 1].eventDigest,
    };
  }
}

function rejected(message: string): RejectedCausalTrace {
  return {
    kind: 'Rejected',
    error: runtimeError('E_CAUSAL_TRACE_INVALID', message),
  };
}

