import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';

export type ParsedAutopilotCommand =
  | { readonly kind: 'start'; readonly goal: string }
  | { readonly kind: 'status'; readonly sessionId: string }
  | { readonly kind: 'doctor'; readonly sessionId: string }
  | {
      readonly kind: 'checkpoint' | 'review' | 'qa';
      readonly sessionId: string;
      readonly expectedRevision: number;
      readonly evidencePath: string;
    }
  | {
      readonly kind: 'resume';
      readonly sessionId: string;
      readonly conversationId: string;
      readonly expectedRevision: number;
    }
  | {
      /** ledger bind + 由 CLI 觸發 managed spawn（非純記帳） */
      readonly kind: 'drive';
      readonly sessionId: string;
      readonly conversationId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: 'cancel';
      readonly sessionId: string;
      readonly expectedRevision: number;
      readonly reason: string;
    }
  | {
      readonly kind: 'reset-breaker';
      readonly sessionId: string;
      readonly expectedRevision: number;
    };

export function parseAutopilotCommand(
  argv: readonly string[],
): Result<ParsedAutopilotCommand, RuntimeError> {
  const subcommand = argv[0];
  if (subcommand === 'start') {
    const delimiter = argv.indexOf('--', 1);
    if (delimiter !== 1 || argv.slice(2).join(' ').trim() === '') {
      return rejected('autopilot start requires a non-empty goal after --');
    }
    return ok({ kind: 'start', goal: argv.slice(2).join(' ') });
  }

  const supported = new Set([
    'status', 'doctor', 'checkpoint', 'review', 'qa', 'resume', 'drive', 'cancel', 'reset-breaker',
  ]);
  if (subcommand === undefined || !supported.has(subcommand)) {
    return rejected('Unknown Autopilot command');
  }
  const flags = parseStrictFlags(argv.slice(1));
  if (!flags.ok) return flags;
  const allowedByCommand: Readonly<Record<string, readonly string[]>> = {
    status: ['--session'],
    doctor: ['--session'],
    checkpoint: ['--session', '--expected-revision', '--evidence'],
    review: ['--session', '--expected-revision', '--evidence'],
    qa: ['--session', '--expected-revision', '--evidence'],
    resume: ['--session', '--conversation', '--expected-revision'],
    drive: ['--session', '--conversation', '--expected-revision'],
    cancel: ['--session', '--expected-revision', '--reason'],
    'reset-breaker': ['--session', '--expected-revision'],
  };
  const required = allowedByCommand[subcommand];
  if (
    flags.value.size !== required.length
    || required.some((key) => !flags.value.has(key))
    || [...flags.value.keys()].some((key) => !required.includes(key))
  ) {
    return rejected(`Invalid or missing flags for autopilot ${subcommand}`);
  }
  const sessionId = flags.value.get('--session')!;
  if (sessionId.trim() === '') return rejected('Session ID must not be empty');
  if (subcommand === 'status' || subcommand === 'doctor') {
    return ok({ kind: subcommand, sessionId });
  }
  const expectedRevision = parseRevision(flags.value.get('--expected-revision'));
  if (expectedRevision === null) return rejected('Expected revision must be a non-negative integer');
  if (subcommand === 'checkpoint' || subcommand === 'review' || subcommand === 'qa') {
    const evidencePath = flags.value.get('--evidence')!;
    if (evidencePath.trim() === '') return rejected('Evidence path must not be empty');
    return ok({ kind: subcommand, sessionId, expectedRevision, evidencePath });
  }
  if (subcommand === 'resume' || subcommand === 'drive') {
    const conversationId = flags.value.get('--conversation')!;
    if (conversationId.trim() === '') return rejected('Conversation ID must not be empty');
    return ok({ kind: subcommand, sessionId, conversationId, expectedRevision });
  }
  if (subcommand === 'cancel') {
    const reason = flags.value.get('--reason')!;
    if (reason.trim() === '') return rejected('Cancellation reason must not be empty');
    return ok({ kind: 'cancel', sessionId, expectedRevision, reason });
  }
  return ok({ kind: 'reset-breaker', sessionId, expectedRevision });
}

function parseStrictFlags(argv: readonly string[]): Result<Map<string, string>, RuntimeError> {
  if (argv.length % 2 !== 0) return rejected('Every Autopilot flag requires one value');
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--') || value === undefined || value.startsWith('--') || flags.has(key)) {
      return rejected('Autopilot flags must be unique --name value pairs');
    }
    flags.set(key, value);
  }
  return ok(flags);
}

function parseRevision(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

function rejected(message: string): Result<never, RuntimeError> {
  return err(runtimeError('E_VALIDATOR_REJECTED', message));
}
