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
  return details === undefined ? { code, message } : { code, message, details };
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
