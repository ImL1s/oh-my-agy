export const RUNTIME_ERROR_CODES = [
  'E_ALREADY_EXISTS',
  'E_NOT_FOUND',
  'E_LOCK_TIMEOUT',
  'E_LOCK_NOT_OWNER',
  'E_REVISION_CONFLICT',
  'E_CORRUPT_STATE',
  'E_FUTURE_SCHEMA',
  'E_PATH_OUTSIDE_ROOT',
  'E_WORKSPACE_AMBIGUOUS',
  'E_WORKSPACE_MISMATCH',
  'E_BINDING_ENV_MISSING',
  'E_CONVERSATION_UNBOUND',
  'E_BINDING_PENDING_EXPIRED',
  'E_INVOCATION_GENERATION_MISMATCH',
  'E_PENDING_LAUNCH_EXISTS',
  'E_BINDING_CONFLICT',
  'E_STOP_EVENT_CONFLICT',
  'E_DIRECTIVE_INVALID',
  'E_PLUGIN_NOT_ACTIVE',
  'E_PROCESS_IDENTITY_UNPROVEN',
  'E_GIT_REQUIRED',
  'E_STATE_ROOT_TRACKED',
  'E_TMUX_OWNER_MISMATCH',
  'E_RECLAIM_IDENTITY_UNPROVEN',
  'E_TEAM_LEADER_REQUIRED',
  'E_RECOVERY_FORK_UNRESOLVED',
  'E_RECOVERY_FORK_ALREADY_RESOLVED',
  'E_RECOVERY_FORK_FENCED',
  'E_MANIFEST_INVALID',
  'E_TASK_SCOPE_OVERLAP',
  'E_TASK_DEPENDENCY_BLOCKED',
  'E_DELIVERY_SCOPE_VIOLATION',
  'E_DELIVERY_NONLINEAR',
  'E_LEADER_HEAD_CHANGED',
  'E_LEADER_WORKTREE_CHANGED',
  'E_TARGET_REF_CHANGED',
  'E_DELIVERY_UNINTEGRATED',
  'E_RETRYABLE_BLOCKER',
  'E_STALE_ACTIVE_POINTER',
  'E_VALIDATOR_REJECTED',
  'E_CAUSAL_TRACE_INVALID',
  'E_TERMINAL_STATE',
  'E_TRACKER_GENERATION_FENCED',
  'E_TRACKER_CURSOR_CONFLICT',
  'E_TRACKER_MISSING_CHILD',
  'E_TRACKER_LEASE_STALLED',
  'E_RESUME_SELECTOR_CONFLICT',
  'E_RESUME_AMBIGUOUS',
  'E_RESUME_NOT_FOUND',
  'E_RESUME_SOURCE_NOT_REGULAR',
  'E_RESUME_SOURCE_CHANGED_DURING_COPY',
  'E_RESUME_NO_COMPLETE_TURNS',
  'E_RESUME_CONTEXT_OVER_CAP',
  'E_CAPABILITY_UNPROVEN',
  'E_REDACTION_UNSAFE',
  'E_COMPACTION_INVALID',
  'E_PROJECTION_STALE',
  'E_PROJECTION_HASH_MISMATCH',
] as const;

export type RuntimeErrorCode = typeof RUNTIME_ERROR_CODES[number];

export interface RuntimeError {
  code: RuntimeErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export function runtimeError(
  code: RuntimeErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): RuntimeError {
  if (details === undefined) return { code, message };
  const redacted = redactValue(details);
  return {
    code,
    message,
    details: typeof redacted === 'object' && redacted !== null && !Array.isArray(redacted)
      ? redacted as Readonly<Record<string, unknown>>
      : { diagnostic: redacted },
  };
}

export class RuntimeContractError extends Error {
  readonly code: RuntimeErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(error: RuntimeError) {
    super(error.message);
    this.name = 'RuntimeContractError';
    this.code = error.code;
    this.details = error.details;
  }
}
import { redactValue } from './redaction';
