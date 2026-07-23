import { lifecycleEventIdentity, stopEventKey } from '../../src/continuation/event-identity';

describe('event identities', () => {
  test('same lifecycle receipt is idempotent and source/generation changes fence replay', () => {
    const base = { source: 'hook', sourceSequence: 1, generation: 2, nativeIdentity: 'conv' };
    expect(lifecycleEventIdentity(base)).toBe(lifecycleEventIdentity({ ...base }));
    expect(lifecycleEventIdentity(base)).not.toBe(lifecycleEventIdentity({ ...base, generation: 3 }));
  });

  test('Stop event key remains deterministic', () => {
    const identity = { conversationId: 'c', invocationGeneration: 1, executionNum: 2 };
    expect(stopEventKey(identity)).toBe(stopEventKey({ ...identity }));
  });
});
