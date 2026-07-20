import { ContinuationResult } from '../types';

export type StopHookDecision =
  | { decision: 'allow' }
  | { decision: 'continue'; reason: string };

export function continuationResultToHookDecision(
  result: Readonly<ContinuationResult>,
): StopHookDecision {
  if (!result.shouldContinue) return { decision: 'allow' };
  const reason = result.prompt?.trim();
  if (!reason) return { decision: 'allow' };
  return { decision: 'continue', reason };
}

