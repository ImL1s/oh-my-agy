import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';

export const AGY_WORKER_VERSION = '1.1.5' as const;
export const AGY_DEFAULT_HEADLESS_TIMEOUT = '5m0s' as const;
export const AGY_MAX_HEADLESS_TIMEOUT_MS = 300_000;
// Pin an explicit model: relying on agy's ambient default is fragile — a stale
// default (e.g. a retired gemini-2.5-pro) makes every worker fail with
// "Agent execution terminated due to error". Must be a current `agy models` id.
export const AGY_WORKER_MODEL = 'gemini-3.6-flash-high' as const;
export const AGY_MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export const AGY_REQUIRED_HELP_FLAGS = Object.freeze([
  '--add-dir',
  '--conversation',
  '--mode',
  '--model',
  '--print',
  '--print-timeout',
  '--prompt-interactive',
  '--sandbox',
] as const);

export interface AgyLaunchArgvInputV1 {
  launchMode: 'headless' | 'interactive';
  capabilityMode: 'read-only' | 'read-write';
  prompt: string;
  conversationId?: string;
  boundedDuration?: string;
  /** Directories mounted into the worker workspace via repeatable --add-dir.
   * Headless agy binds its own workspace, not the process cwd, so a worker
   * cannot see the repository unless it is added explicitly. */
  workspaceDirectories?: readonly string[];
  /** Pinned model id (defaults to AGY_WORKER_MODEL). Must be a current
   * `agy models` dash-id; an invalid or retired id fails the whole session. */
  model?: string;
}

/**
 * Antigravity CLI 1.1.5 launch grammar frozen by OMA-W3.  The prompt is
 * returned as exactly one final argv element; callers must use spawn(), never
 * a shell command string.
 */
export function buildAgy115Argv(
  input: Readonly<AgyLaunchArgvInputV1>,
): Result<readonly string[], RuntimeError> {
  const prompt = validatePrompt(input.prompt);
  if (!prompt.ok) return prompt;
  const prefix: string[] = [];
  if (input.conversationId !== undefined) {
    if (!safeConversationId(input.conversationId)) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'Antigravity conversation ID is invalid'));
    }
    prefix.push('--conversation', input.conversationId);
  }
  for (const directory of input.workspaceDirectories ?? []) {
    if (directory.trim() === '' || directory.includes('\0')
      || directory.includes('\n') || directory.startsWith('-')) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'Workspace directory is invalid'));
    }
    prefix.push('--add-dir', directory);
  }
  const model = input.model ?? AGY_WORKER_MODEL;
  if (!AGY_MODEL_ID.test(model)) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'Antigravity model id is invalid'));
  }
  prefix.push('--model', model);

  const mode = input.capabilityMode === 'read-only' ? 'plan' : 'accept-edits';
  if (input.launchMode === 'headless') {
    const duration = input.boundedDuration ?? AGY_DEFAULT_HEADLESS_TIMEOUT;
    const durationMs = parseGoDurationMs(duration);
    if (durationMs === null || durationMs <= 0 || durationMs > AGY_MAX_HEADLESS_TIMEOUT_MS) {
      return err(runtimeError(
        'E_VALIDATOR_REJECTED',
        'Headless print timeout must be a positive Go duration no greater than 5m0s',
      ));
    }
    // Antigravity 1.1.5 parses --print/--prompt-interactive as taking the
    // prompt as their immediate value; trailing prompts swallow later flags
    // into the prompt text (verified against the live CLI).
    const argv = [
      ...prefix,
      '--print',
      prompt.value,
      '--print-timeout',
      duration,
      '--mode',
      mode,
      ...(input.capabilityMode === 'read-only' ? ['--sandbox'] : []),
    ];
    return validateFrozenArgv(argv, prompt.value);
  }

  const argv = [
    ...prefix,
    '--prompt-interactive',
    prompt.value,
    '--mode',
    mode,
    ...(input.capabilityMode === 'read-only' ? ['--sandbox'] : []),
  ];
  return validateFrozenArgv(argv, prompt.value);
}

export function validateAgy115Help(versionOutput: string, helpOutput: string): Result<void, RuntimeError> {
  if (versionOutput.trim() !== AGY_WORKER_VERSION) {
    return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Antigravity CLI version is not the frozen 1.1.5 worker version', {
      expected: AGY_WORKER_VERSION,
      actual: versionOutput.trim(),
    }));
  }
  const missing = AGY_REQUIRED_HELP_FLAGS.filter((flag) => !helpOutput.includes(flag));
  if (missing.length > 0) {
    return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Antigravity CLI help is missing required worker flags', {
      missing,
    }));
  }
  return ok(undefined);
}

function validateFrozenArgv(argv: string[], prompt: string): Result<readonly string[], RuntimeError> {
  if (argv.includes('--dangerously-skip-permissions')) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'Dangerous permission bypass is forbidden'));
  }
  const promptIndex = argv.indexOf(prompt);
  if (
    argv.filter((entry) => entry === prompt).length !== 1
    || promptIndex < 1
    || !['--print', '--prompt-interactive'].includes(argv[promptIndex - 1])
  ) {
    return err(runtimeError(
      'E_CORRUPT_STATE',
      'Worker prompt must be the single value of --print/--prompt-interactive',
    ));
  }
  if (argv.some((entry) => entry.includes('\0'))) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'Worker argv contains a NUL byte'));
  }
  return ok(Object.freeze([...argv]));
}

function validatePrompt(value: string): Result<string, RuntimeError> {
  if (value.trim() === '' || value.includes('\0')) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'Worker prompt must be non-empty and NUL-free'));
  }
  // Go flag parsing treats a leading dash as another flag.  Failing closed is
  // safer than silently changing the frozen argv table with an undocumented --.
  if (value.startsWith('-')) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'Worker prompt cannot begin with a flag prefix'));
  }
  return ok(value);
}

function safeConversationId(value: string): boolean {
  return value.trim() !== '' && !value.includes('\0') && !value.includes('\n') && !value.startsWith('-');
}

/** Minimal Go duration parser for the bounded CLI policy (h/m/s/ms units). */
export function parseGoDurationMs(value: string): number | null {
  if (!/^(?:\d+h)?(?:\d+m)?(?:\d+s)?(?:\d+ms)?$/.test(value) || value === '') return null;
  const matcher = /(\d+)(ms|h|m|s)/g;
  let total = 0;
  let consumed = '';
  for (let match = matcher.exec(value); match !== null; match = matcher.exec(value)) {
    consumed += match[0];
    const amount = Number(match[1]);
    const multiplier = match[2] === 'h' ? 3_600_000
      : match[2] === 'm' ? 60_000
        : match[2] === 's' ? 1_000 : 1;
    total += amount * multiplier;
  }
  return consumed === value && Number.isSafeInteger(total) ? total : null;
}
