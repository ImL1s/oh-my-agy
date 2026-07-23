import * as path from 'path';
import { appendHookLifecycleEvent } from './common';

export interface OptionalPostInvocationInput { conversationId?: string }
export interface OptionalPostInvocationResult {
  decision: 'allow';
  ok: false;
  claimed: false;
}

/** Evidence-gated candidate only; hooks.json intentionally does not register it. */
export function handlePostInvocation(
  input: Readonly<OptionalPostInvocationInput>,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): OptionalPostInvocationResult {
  const root = env.OMA_STATE_ROOT?.trim();
  if (root) {
    try {
      const parsed = Number.parseInt(env.OMA_INVOCATION_GENERATION ?? '', 10);
      appendHookLifecycleEvent(path.join(root, 'lifecycle', 'optional-hooks.jsonl'), {
        eventType: 'turn_completed',
        runId: env.OMA_SESSION_ID?.trim() || 'optional-unclaimed',
        generation: Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1,
        parentId: null,
        nativeIdentity: input.conversationId?.trim() || null,
        payload: { claimed: false },
        source: 'optional_antigravity_hook',
      });
    } catch { /* fail-open */ }
  }
  return { decision: 'allow', ok: false, claimed: false };
}
