import { canonicalJson, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';

export interface StopEventIdentity {
  conversationId: string;
  invocationGeneration: number;
  executionNum: number;
}

export function validateStopEventIdentity(
  identity: Readonly<StopEventIdentity>,
): Result<StopEventIdentity, RuntimeError> {
  if (
    identity.conversationId.trim() === ''
    || !Number.isSafeInteger(identity.invocationGeneration)
    || identity.invocationGeneration < 1
    || !Number.isSafeInteger(identity.executionNum)
    || identity.executionNum < 0
  ) {
    return err(runtimeError('E_CORRUPT_STATE', 'Stop event identity is invalid', {
      identity,
    }));
  }
  return ok({ ...identity });
}

export function stopEventKey(identity: Readonly<StopEventIdentity>): string {
  return sha256(canonicalJson(identity));
}

export interface LifecycleEventIdentityInput {
  source: string;
  sourceSequence: number;
  generation: number;
  nativeIdentity: string | null;
}

export function lifecycleEventIdentity(input: Readonly<LifecycleEventIdentityInput>): string {
  if (input.source.trim() === '' || !Number.isSafeInteger(input.sourceSequence)
    || input.sourceSequence < 0 || !Number.isSafeInteger(input.generation)
    || input.generation < 1 || (input.nativeIdentity !== null && input.nativeIdentity.trim() === '')) {
    throw new Error('E_CORRUPT_STATE: lifecycle event identity is invalid');
  }
  return sha256(canonicalJson({
    source: input.source,
    source_sequence: input.sourceSequence,
    generation: input.generation,
    native_identity: input.nativeIdentity,
  }));
}
