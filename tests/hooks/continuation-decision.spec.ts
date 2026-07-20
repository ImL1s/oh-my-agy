import { continuationResultToHookDecision } from '../../src/continuation/decision';
import { serializeHookDecision } from '../../src/hooks/common';

describe('continuation hook decision regression', () => {
  test('a positive continuation result is returned as a real Stop continue decision', () => {
    const decision = continuationResultToHookDecision({
      shouldContinue: true,
      prompt: 'Continue the verified next step.',
      status: 'continuing',
      remainingRetries: 2,
    });

    expect(decision).toEqual({
      decision: 'continue',
      reason: 'Continue the verified next step.',
    });
    expect(serializeHookDecision(decision)).toBe(
      '{"decision":"continue","reason":"Continue the verified next step."}',
    );
  });

  test('idle results fail open with one JSON object', () => {
    const decision = continuationResultToHookDecision({
      shouldContinue: false,
      status: 'idle',
      remainingRetries: 3,
    });

    expect(decision).toEqual({ decision: 'allow' });
    expect(JSON.parse(serializeHookDecision(decision))).toEqual({ decision: 'allow' });
  });
});

