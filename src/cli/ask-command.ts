/**
 * `oma ask <codex|claude|grok|agy|cursor-agent> "<question>" [--file] [--dry-run] [--json]`
 *
 * 設計概念映射：OMG `omg ask` CLI wrapper、OMC/OMX `ask` verb。
 * 本命令只做 outbound broker；不得注入回覆、不得寫 gate 狀態。
 */
import * as path from 'path';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import {
  ASK_ADVISORY_BANNER,
  AskBrokerResult,
  AskResolveExecutableV1,
  AskSpawnSyncV1,
  runAskBroker,
} from '../ask/broker';
import { formatCliError } from '../runtime/error-catalog';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { ordinaryEnvironment } from './managed-invocation';
import { Result, err, ok } from '../runtime/types';

export const ASK_USAGE =
  'Usage: oma ask <codex|claude|grok|agy|cursor-agent> "<question>" [--file <path>] [--dry-run] [--json]';
export const ASK_RESULT_SCHEMA = 'oma.ask-result/v1';

export interface AskCommandContext {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  spawnSync?: AskSpawnSyncV1;
  resolveExecutable?: AskResolveExecutableV1;
  stdout(value: string): void;
  stderr(value: string): void;
}

export type ParsedAskCommand =
  | { readonly kind: 'help' }
  | {
    readonly kind: 'run';
    readonly tool: string;
    readonly question: string;
    readonly filePath: string | undefined;
    readonly dryRun: boolean;
    readonly asJson: boolean;
  };

export function parseAskArgv(
  argv: readonly string[],
): Result<ParsedAskCommand, RuntimeError> {
  let asJson = false;
  let dryRun = false;
  let filePath: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--help' || token === '-h') {
      return ok({ kind: 'help' });
    }
    if (token === '--json') {
      if (asJson) return validatorRejected('oma ask: duplicate option --json');
      asJson = true;
      continue;
    }
    if (token === '--dry-run') {
      if (dryRun) return validatorRejected('oma ask: duplicate option --dry-run');
      dryRun = true;
      continue;
    }
    if (token === '--file') {
      if (filePath !== undefined) return validatorRejected('oma ask: duplicate option --file');
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--') || value.includes('\0') || value.trim() === '') {
        return validatorRejected('--file requires one non-empty path');
      }
      filePath = value;
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      return validatorRejected(`oma ask: unexpected option ${token}`);
    }
    positionals.push(token);
  }
  if (positionals.length !== 2) {
    return validatorRejected(ASK_USAGE);
  }
  const tool = positionals[0]!;
  const question = positionals[1]!;
  if (question.includes('\0') || question.trim() === '') {
    return validatorRejected('oma ask requires a non-empty question');
  }
  return ok({
    kind: 'run',
    tool,
    question,
    filePath,
    dryRun,
    asJson,
  });
}

export function runAskCommand(
  argv: readonly string[],
  context: Readonly<AskCommandContext>,
): number {
  const parsed = parseAskArgv(argv);
  if (!parsed.ok) return writeAskFailure(argv, parsed.error, context);
  if (parsed.value.kind === 'help') {
    context.stdout(`${ASK_USAGE}\n`);
    return 0;
  }
  const options = parsed.value;
  const result = runAskBroker({
    tool: options.tool,
    question: options.question,
    cwd: context.cwd,
    filePath: options.filePath,
    dryRun: options.dryRun,
    environment: ordinaryEnvironment(context.environment),
    now: context.now,
    spawnSync: context.spawnSync,
    resolveExecutable: context.resolveExecutable,
  });
  if (!result.ok) return writeAskFailure(argv, result.error, context);
  writeAskSuccess(result.value, options.asJson, context);
  if (options.dryRun) return 0;
  return result.value.exitCode === 0 ? 0 : 1;
}

function writeAskSuccess(
  result: Readonly<AskBrokerResult>,
  asJson: boolean,
  context: Readonly<AskCommandContext>,
): void {
  const artifact = posixRelative(context.cwd, result.artifactPath);
  if (asJson) {
    context.stdout(`${canonicalBytesV1({
      advisory: true,
      artifact,
      argv: [...result.argv],
      dry_run: result.dryRun,
      exit_code: result.exitCode,
      inbound_reply_injection: result.inboundReplyInjection,
      ok: true,
      schema: ASK_RESULT_SCHEMA,
      spawned: result.spawned,
      tool: result.tool,
      truncated: result.truncated,
    }).toString('utf8')}\n`);
    return;
  }
  if (result.dryRun) {
    context.stdout([
      `oma ask dry-run tool=${result.tool}`,
      `argv: ${JSON.stringify(result.argv)}`,
      `artifact: ${artifact}`,
      ASK_ADVISORY_BANNER,
      '',
    ].join('\n'));
    return;
  }
  context.stdout([
    `oma ask: tool=${result.tool} exit=${result.exitCode} artifact=${artifact}`,
    ASK_ADVISORY_BANNER,
    '',
  ].join('\n'));
}

function writeAskFailure(
  argv: readonly string[],
  error: RuntimeError,
  context: Readonly<AskCommandContext>,
): number {
  const exitCode = error.code === 'E_VALIDATOR_REJECTED' ? 2 : 1;
  if (argv.filter((token) => token === '--json').length === 1) {
    context.stdout(`${canonicalBytesV1({
      advisory: true,
      code: error.code,
      exitCode,
      inbound_reply_injection: 'forbidden',
      message: error.message,
      ok: false,
      schema: ASK_RESULT_SCHEMA,
    }).toString('utf8')}\n`);
  } else {
    context.stderr(formatCliError(error.code, error.message));
  }
  return exitCode;
}

function posixRelative(cwd: string, target: string): string {
  const relative = path.relative(path.resolve(cwd), target).split(path.sep).join('/');
  return relative === '' ? target : relative;
}

function validatorRejected(message: string): Result<never, RuntimeError> {
  return err(runtimeError('E_VALIDATOR_REJECTED', message));
}
