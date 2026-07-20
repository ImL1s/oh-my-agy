import { canonicalJson } from '../runtime/atomic';
import { StopHookDecision } from '../continuation/decision';

export function serializeHookDecision(decision: Readonly<StopHookDecision>): string {
  if (decision.decision === 'continue' && decision.reason.trim() === '') {
    return canonicalJson({ decision: 'allow' });
  }
  return canonicalJson(decision);
}

