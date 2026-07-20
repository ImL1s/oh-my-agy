import * as crypto from 'crypto';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';

export type ManagedMode = 'ralph' | 'ultrawork' | 'search';
export type ModeDirectiveSpecId = `oma.${ManagedMode}/v1`;

export interface DirectiveClause {
  readonly id: string;
  readonly value: string;
}

export interface DirectiveSpec {
  readonly id: ModeDirectiveSpecId;
  readonly clauses: readonly DirectiveClause[];
  readonly argvPrefix: readonly string[];
}

export interface RenderedModeDirective {
  readonly specId: ModeDirectiveSpecId;
  readonly nonce: string;
  readonly taskLength: number;
  readonly taskDigest: string;
  readonly directive: string;
  readonly argv: readonly string[];
}

export const MODE_DIRECTIVE_SPECS: Readonly<Record<ModeDirectiveSpecId, DirectiveSpec>> =
  Object.freeze({
    'oma.ralph/v1': Object.freeze({
      id: 'oma.ralph/v1',
      clauses: Object.freeze([
        Object.freeze({ id: 'persistence', value: 'until-complete-or-explicit-blocker' }),
        Object.freeze({ id: 'verification', value: 'required-before-complete' }),
        Object.freeze({ id: 'safety', value: 'preserve-user-work' }),
        Object.freeze({ id: 'team', value: 'single-session-no-implicit-team' }),
      ]),
      argvPrefix: Object.freeze(['-i']),
    }),
    'oma.ultrawork/v1': Object.freeze({
      id: 'oma.ultrawork/v1',
      clauses: Object.freeze([
        Object.freeze({ id: 'orchestration', value: 'native-subagents-for-independent-bounded-work' }),
        Object.freeze({ id: 'leader', value: 'integrate-and-verify' }),
        Object.freeze({ id: 'safety', value: 'preserve-user-work' }),
        Object.freeze({ id: 'team', value: 'oma-team-requires-explicit-command-and-manifest' }),
      ]),
      argvPrefix: Object.freeze(['-i']),
    }),
    'oma.search/v1': Object.freeze({
      id: 'oma.search/v1',
      clauses: Object.freeze([
        Object.freeze({ id: 'policy', value: 'read-only' }),
        Object.freeze({ id: 'mutation', value: 'forbidden' }),
        Object.freeze({ id: 'output', value: 'source-path-and-line-evidence' }),
        Object.freeze({ id: 'team', value: 'forbidden' }),
      ]),
      argvPrefix: Object.freeze(['--mode', 'plan', '--sandbox', '-i']),
    }),
  });

const NONCE_PATTERN = /^[a-f0-9]{32}$/;

export class ModeDirectiveRenderer {
  constructor(private readonly nonceFactory: () => string = () => crypto.randomBytes(16).toString('hex')) {}

  render(
    specId: ModeDirectiveSpecId,
    taskBytes: Readonly<Buffer>,
    nonce?: string,
  ): Result<RenderedModeDirective, RuntimeError> {
    const spec = MODE_DIRECTIVE_SPECS[specId];
    if (spec === undefined || !isRoundTripUtf8(taskBytes)) {
      return invalid('Directive spec or task encoding is invalid', { specId });
    }

    const task = taskBytes.toString('utf8');
    let selectedNonce = nonce;
    if (selectedNonce === undefined) {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const candidate = this.nonceFactory();
        if (NONCE_PATTERN.test(candidate) && !task.includes(candidate)) {
          selectedNonce = candidate;
          break;
        }
      }
    }
    if (
      selectedNonce === undefined
      || !NONCE_PATTERN.test(selectedNonce)
      || task.includes(selectedNonce)
    ) {
      return invalid('Directive nonce is invalid or collides with task bytes');
    }

    const digest = digestBytes(taskBytes);
    const lines = [
      `OMA-DIRECTIVE ${spec.id}`,
      ...spec.clauses.map((clause) => `CLAUSE ${clause.id}=${clause.value}`),
      `<<<OMA_TASK nonce=${selectedNonce} bytes=${taskBytes.length} sha256=${digest}>>>`,
      task,
      `<<<OMA_TASK_END nonce=${selectedNonce}>>>`,
    ];
    const directive = lines.join('\n');
    const argv = Object.freeze([...spec.argvPrefix, directive]);
    return ok(Object.freeze({
      specId,
      nonce: selectedNonce,
      taskLength: taskBytes.length,
      taskDigest: digest,
      directive,
      argv,
    }));
  }

  validate(
    specId: ModeDirectiveSpecId,
    taskBytes: Readonly<Buffer>,
    directive: string,
    argv: readonly string[],
  ): Result<RenderedModeDirective, RuntimeError> {
    const parsed = this.parse(specId, directive);
    if (!parsed.ok) return parsed;
    const spec = MODE_DIRECTIVE_SPECS[specId];
    if (
      !parsed.value.task.equals(taskBytes)
      || argv.length !== spec.argvPrefix.length + 1
      || spec.argvPrefix.some((value, index) => argv[index] !== value)
      || argv[argv.length - 1] !== directive
    ) {
      return invalid('Directive task bytes or full argv do not match the versioned contract');
    }
    return ok(Object.freeze({
      specId,
      nonce: parsed.value.nonce,
      taskLength: taskBytes.length,
      taskDigest: digestBytes(taskBytes),
      directive,
      argv: Object.freeze([...argv]),
    }));
  }

  extractTask(
    specId: ModeDirectiveSpecId,
    directive: string,
  ): Result<Buffer, RuntimeError> {
    const parsed = this.parse(specId, directive);
    return parsed.ok ? ok(Buffer.from(parsed.value.task)) : parsed;
  }

  private parse(
    specId: ModeDirectiveSpecId,
    directive: string,
  ): Result<{ nonce: string; task: Buffer }, RuntimeError> {
    const spec = MODE_DIRECTIVE_SPECS[specId];
    if (spec === undefined || typeof directive !== 'string') {
      return invalid('Directive spec is unknown');
    }
    const prefix = [
      `OMA-DIRECTIVE ${spec.id}`,
      ...spec.clauses.map((clause) => `CLAUSE ${clause.id}=${clause.value}`),
    ].join('\n');
    if (!directive.startsWith(`${prefix}\n`)) {
      return invalid('Directive header, version, clauses, or clause order is invalid');
    }
    const rest = directive.slice(prefix.length + 1);
    const firstNewline = rest.indexOf('\n');
    if (firstNewline < 0) return invalid('Directive start delimiter is missing');
    const start = rest.slice(0, firstNewline);
    const match = start.match(/^<<<OMA_TASK nonce=([a-f0-9]{32}) bytes=(\d+) sha256=([a-f0-9]{64})>>>$/);
    if (match === null) return invalid('Directive start delimiter is invalid');
    const [, nonce, byteLengthText, expectedDigest] = match;
    // 允許 TASK_END 之後附加 skill protocol（OMA_SKILL_PROTOCOL）；不要求整段 endsWith
    const endMarker = `\n<<<OMA_TASK_END nonce=${nonce}>>>`;
    const endAt = rest.indexOf(endMarker, firstNewline);
    if (endAt < 0) return invalid('Directive end delimiter is missing or mismatched');
    const task = Buffer.from(rest.slice(firstNewline + 1, endAt), 'utf8');
    if (
      task.includes(Buffer.from(nonce))
      || task.length !== Number(byteLengthText)
      || digestBytes(task) !== expectedDigest
    ) {
      return invalid('Directive task length, digest, or delimiter safety check failed');
    }
    return ok({ nonce, task });
  }
}

export function specIdForMode(mode: ManagedMode): ModeDirectiveSpecId {
  return `oma.${mode}/v1`;
}

function digestBytes(value: Readonly<Buffer>): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isRoundTripUtf8(value: Readonly<Buffer>): boolean {
  return Buffer.from(value.toString('utf8'), 'utf8').equals(value);
}

function invalid(message: string, details?: Readonly<Record<string, unknown>>): Result<never, RuntimeError> {
  return err(runtimeError('E_DIRECTIVE_INVALID', message, details));
}
