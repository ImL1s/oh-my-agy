import * as path from 'path';
import { appendHookLifecycleEvent } from './common';

export interface OptionalLifecycleInput { conversationId?: string }
export interface OptionalLifecycleResult {
  decision: 'allow';
  ok: false;
  claimed: false;
}

/** Evidence-gated candidate only; hooks.json intentionally does not register it. */
export function handleSessionStart(
  input: Readonly<OptionalLifecycleInput>,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): OptionalLifecycleResult {
  appendOptional('session_started', input, env);
  return { decision: 'allow', ok: false, claimed: false };
}

function appendOptional(
  eventType: 'session_started',
  input: Readonly<OptionalLifecycleInput>,
  env: Readonly<NodeJS.ProcessEnv>,
): void {
  const root = env.OMA_STATE_ROOT?.trim();
  if (!root) return;
  try {
    appendHookLifecycleEvent(path.join(root, 'lifecycle', 'optional-hooks.jsonl'), {
      eventType,
      runId: env.OMA_SESSION_ID?.trim() || 'optional-unclaimed',
      generation: positiveGeneration(env.OMA_INVOCATION_GENERATION),
      parentId: null,
      nativeIdentity: input.conversationId?.trim() || null,
      payload: { claimed: false },
      source: 'optional_antigravity_hook',
    });
  } catch { /* fail-open */ }
}

function positiveGeneration(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}
