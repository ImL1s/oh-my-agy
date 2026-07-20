import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';

export type ParsedAutopilotCommand =
  | { readonly kind: 'start'; readonly goal: string }
  | { readonly kind: 'status'; readonly sessionId: string }
  | { readonly kind: 'doctor'; readonly sessionId: string }
  | {
      readonly kind: 'checkpoint' | 'advance' | 'review' | 'qa';
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
    }
  | {
      readonly kind: 'handoff';
      readonly sessionId: string;
      readonly expectedRevision: number;
      readonly key: 'deepInterview' | 'ralplan' | 'ultragoal' | 'codeReview' | 'ultraqa';
      readonly path: string;
    }
  | {
      readonly kind: 'consensus';
      readonly sessionId: string;
      readonly expectedRevision: number;
      readonly role: 'architect' | 'critic';
      readonly verdict: 'approve' | 'revise';
      readonly note: string;
    }
  | {
      readonly kind: 'return-ralplan';
      readonly sessionId: string;
      readonly expectedRevision: number;
      readonly reason: string;
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
    'status', 'doctor', 'checkpoint', 'advance', 'review', 'qa',
    'resume', 'drive', 'cancel', 'reset-breaker',
    'handoff', 'consensus', 'return-ralplan',
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
    advance: ['--session', '--expected-revision', '--evidence'],
    review: ['--session', '--expected-revision', '--evidence'],
    qa: ['--session', '--expected-revision', '--evidence'],
    resume: ['--session', '--conversation', '--expected-revision'],
    drive: ['--session', '--conversation', '--expected-revision'],
    cancel: ['--session', '--expected-revision', '--reason'],
    'reset-breaker': ['--session', '--expected-revision'],
    handoff: ['--session', '--expected-revision', '--key', '--path'],
    consensus: ['--session', '--expected-revision', '--role', '--verdict', '--note'],
    'return-ralplan': ['--session', '--expected-revision', '--reason'],
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
  if (
    subcommand === 'checkpoint'
    || subcommand === 'advance'
    || subcommand === 'review'
    || subcommand === 'qa'
  ) {
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
  if (subcommand === 'handoff') {
    const key = flags.value.get('--key')!;
    const path = flags.value.get('--path')!;
    const allowed = new Set(['deepInterview', 'ralplan', 'ultragoal', 'codeReview', 'ultraqa']);
    if (!allowed.has(key)) return rejected('handoff --key must be deepInterview|ralplan|ultragoal|codeReview|ultraqa');
    if (path.trim() === '') return rejected('handoff --path must not be empty');
    return ok({
      kind: 'handoff',
      sessionId,
      expectedRevision,
      key: key as 'deepInterview' | 'ralplan' | 'ultragoal' | 'codeReview' | 'ultraqa',
      path,
    });
  }
  if (subcommand === 'consensus') {
    const role = flags.value.get('--role')!;
    const verdict = flags.value.get('--verdict')!;
    const note = flags.value.get('--note')!;
    if (role !== 'architect' && role !== 'critic') {
      return rejected('consensus --role must be architect|critic');
    }
    if (verdict !== 'approve' && verdict !== 'revise') {
      return rejected('consensus --verdict must be approve|revise');
    }
    if (note.trim() === '') return rejected('consensus --note must not be empty');
    return ok({ kind: 'consensus', sessionId, expectedRevision, role, verdict, note });
  }
  if (subcommand === 'return-ralplan') {
    const reason = flags.value.get('--reason')!;
    if (reason.trim() === '') return rejected('return-ralplan --reason must not be empty');
    return ok({ kind: 'return-ralplan', sessionId, expectedRevision, reason });
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
