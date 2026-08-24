/**
 * 設計概念映射：OMC `session-search`、OMX `session-search`、OMG `session allocate`
 * 的唯讀枚舉面。OMA 只投影 `src/continuation/state.ts` 既有的
 * `listWorkspaceSessionInventory` / SessionAggregateStore，不做 CAS。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import {
  SessionAggregateStore,
  type SessionAggregateV1,
} from '../continuation/session-aggregate';
import { listWorkspaceSessionInventory } from '../continuation/state';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { resolveStateRoot } from '../runtime/state-root';
import { Result, err, ok } from '../runtime/types';

export const SESSION_LIST_LIMIT_MIN = 1;
export const SESSION_LIST_LIMIT_MAX = 200;
export const SESSION_LIST_LIMIT_DEFAULT = 200;
export const SESSION_LIST_USAGE =
  'Usage: oma session list [--json] [--workspace-key <key>] [--limit <1..200>] (alias: oma resume --list)';

export interface SessionListOptionsV1 {
  readonly asJson: boolean;
  readonly workspaceKey: string | undefined;
  readonly limit: number;
}

export interface SessionListRowV1 {
  readonly available: boolean;
  readonly session_id: string | null;
  readonly workspace_key: string;
  readonly phase: string | null;
  readonly revision: number | null;
  readonly generation: number | null;
  readonly last_event_utc: string | null;
  readonly terminal: boolean | null;
  readonly unavailable_code: string | null;
}

export interface SessionListProjectionV1 {
  readonly store_kind: 'oma_session_list';
  readonly schema_version: 1;
  readonly workspace_key: string | null;
  readonly limit: number;
  readonly sessions: readonly SessionListRowV1[];
}

export interface SessionListCommandContext {
  readonly cwd: string;
  readonly stateRoot?: string;
  readonly environment: NodeJS.ProcessEnv;
  stdout(value: string): void;
  stderr(value: string): void;
}

const SESSION_LIST_COLUMNS = [
  'session_id',
  'workspace_key',
  'phase',
  'revision',
  'generation',
  'last_event_utc',
  'terminal',
] as const;

export function parseSessionListArgv(
  argv: readonly string[],
): Result<SessionListOptionsV1, RuntimeError> {
  const tokens = [...argv];
  let sawList = false;
  if (tokens[0] === 'list') {
    sawList = true;
    tokens.shift();
  }
  let asJson = false;
  let workspaceKey: string | undefined;
  let limit: number | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--list') {
      sawList = true;
      continue;
    }
    if (token === '--json') {
      if (asJson) return validatorRejected('duplicate option --json');
      asJson = true;
      continue;
    }
    if (token === '--workspace-key') {
      if (workspaceKey !== undefined) {
        return validatorRejected('--workspace-key may appear only once');
      }
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith('--') || value.includes('\0')) {
        return validatorRejected('--workspace-key requires one value');
      }
      workspaceKey = value;
      index += 1;
      continue;
    }
    if (token === '--limit') {
      if (limit !== undefined) return validatorRejected('--limit may appear only once');
      const raw = tokens[index + 1];
      const parsed = parseSessionListLimit(raw);
      if (!parsed.ok) return parsed;
      limit = parsed.value;
      index += 1;
      continue;
    }
    return validatorRejected(SESSION_LIST_USAGE);
  }
  if (!sawList) return validatorRejected(SESSION_LIST_USAGE);
  return ok({
    asJson,
    workspaceKey,
    limit: limit ?? SESSION_LIST_LIMIT_DEFAULT,
  });
}

export function parseSessionListLimit(raw: string | undefined): Result<number, RuntimeError> {
  if (raw === undefined || raw.startsWith('--') || raw.includes('\0')) {
    return validatorRejected('--limit must be an integer in 1..200');
  }
  if (!/^-?\d+$/u.test(raw)) {
    return validatorRejected('--limit must be an integer in 1..200');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || String(value) !== raw
    || value < SESSION_LIST_LIMIT_MIN || value > SESSION_LIST_LIMIT_MAX) {
    return validatorRejected('--limit must be an integer in 1..200');
  }
  return ok(value);
}

export function listManagedSessions(input: Readonly<{
  stateRoot: string;
  workspaceKey?: string;
  limit?: number;
}>): Result<SessionListProjectionV1, RuntimeError> {
  const limit = input.limit ?? SESSION_LIST_LIMIT_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < SESSION_LIST_LIMIT_MIN || limit > SESSION_LIST_LIMIT_MAX) {
    return validatorRejected('--limit must be an integer in 1..200');
  }
  const inventory = listWorkspaceSessionInventory(input.stateRoot, input.workspaceKey);
  if (!inventory.ok) return inventory;
  const rows = inventory.value.map((entry) => projectInventoryEntry(entry));
  rows.sort(compareSessionListRows);
  return ok({
    store_kind: 'oma_session_list',
    schema_version: 1,
    workspace_key: input.workspaceKey ?? null,
    limit,
    sessions: rows.slice(0, limit),
  });
}

export function renderSessionList(
  projection: Readonly<SessionListProjectionV1>,
  format: 'json' | 'text',
): string {
  if (format === 'json') return canonicalBytesV1(projection).toString('utf8');
  const lines = [SESSION_LIST_COLUMNS.join('\t')];
  for (const row of projection.sessions) {
    lines.push(SESSION_LIST_COLUMNS.map((column) => textCell(row[column])).join('\t'));
  }
  return lines.join('\n');
}

export function runSessionListCommand(
  argv: readonly string[],
  context: Readonly<SessionListCommandContext>,
): number {
  const parsed = parseSessionListArgv(argv);
  if (!parsed.ok) {
    context.stderr(`${parsed.error.code}: ${parsed.error.message}\n`);
    return 2;
  }
  const stateRoot = resolveListStateRoot(context);
  if (!stateRoot.ok) {
    context.stderr(`${stateRoot.error.code}: ${stateRoot.error.message}\n`);
    return 1;
  }
  const listed = listManagedSessions({
    stateRoot: stateRoot.value,
    workspaceKey: parsed.value.workspaceKey,
    limit: parsed.value.limit,
  });
  if (!listed.ok) {
    context.stderr(`${listed.error.code}: ${listed.error.message}\n`);
    return listed.error.code === 'E_VALIDATOR_REJECTED' ? 2 : 1;
  }
  context.stdout(`${renderSessionList(listed.value, parsed.value.asJson ? 'json' : 'text')}\n`);
  return 0;
}

function resolveListStateRoot(
  context: Readonly<SessionListCommandContext>,
): Result<string, RuntimeError> {
  if (context.stateRoot !== undefined && context.stateRoot.trim() !== '') {
    return ok(path.resolve(context.stateRoot));
  }
  const resolved = resolveStateRoot({
    env: context.environment,
    homeDirectory: context.environment.HOME ?? os.homedir(),
    create: false,
  });
  if (!resolved.ok) return resolved;
  return ok(resolved.value.path);
}

function projectInventoryEntry(
  entry: Readonly<{ workspacePathKey: string; sessionPathKey: string; aggregatePath: string }>,
): SessionListRowV1 {
  if (unsafeAggregatePath(entry.aggregatePath)) {
    return unavailableRow(entry, 'E_PATH_OUTSIDE_ROOT');
  }
  const read = new SessionAggregateStore(entry.aggregatePath).read();
  if (!read.ok) return unavailableRow(entry, read.error.code);
  return projectAggregate(read.value, entry.workspacePathKey);
}

function projectAggregate(
  aggregate: Readonly<SessionAggregateV1>,
  workspacePathKey: string,
): SessionListRowV1 {
  return {
    available: true,
    session_id: aggregate.sessionId,
    workspace_key: aggregate.workspaceKey !== '' ? aggregate.workspaceKey : workspacePathKey,
    phase: aggregate.autopilot.phase,
    revision: aggregate.revision,
    generation: aggregate.binding.activeInvocationGeneration,
    last_event_utc: lastEventUtc(aggregate),
    terminal: aggregate.autopilot.terminal !== null,
    unavailable_code: null,
  };
}

function unavailableRow(
  entry: Readonly<{ workspacePathKey: string; sessionPathKey: string }>,
  code: string,
): SessionListRowV1 {
  return {
    available: false,
    session_id: entry.sessionPathKey,
    workspace_key: entry.workspacePathKey,
    phase: null,
    revision: null,
    generation: null,
    last_event_utc: null,
    terminal: null,
    unavailable_code: code,
  };
}

function lastEventUtc(aggregate: Readonly<SessionAggregateV1>): string | null {
  const times: string[] = [];
  const autopilot = aggregate.autopilot;
  pushTimestamp(times, autopilot.terminal?.at);
  pushTimestamp(times, autopilot.retryableBlocker?.lastSeenAt);
  pushTimestamp(times, autopilot.retryableBlocker?.firstSeenAt);
  pushTimestamp(times, autopilot.reviewVerdict?.at);
  pushTimestamp(times, autopilot.qaVerdict?.at);
  const gate = autopilot.handoffArtifacts?.ralplanConsensusGate;
  pushTimestamp(times, gate?.architectReview?.at);
  pushTimestamp(times, gate?.criticReview?.at);
  if (times.length === 0) return null;
  times.sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
  return times[times.length - 1] ?? null;
}

function pushTimestamp(times: string[], value: string | undefined): void {
  if (value !== undefined && value !== '') times.push(value);
}

function unsafeAggregatePath(aggregatePath: string): boolean {
  try {
    if (!fs.existsSync(aggregatePath)) return false;
    const stat = fs.lstatSync(aggregatePath);
    return stat.isSymbolicLink() || !stat.isFile();
  } catch {
    return true;
  }
}

function compareSessionListRows(left: SessionListRowV1, right: SessionListRowV1): number {
  const workspace = compareUtf8(left.workspace_key, right.workspace_key);
  if (workspace !== 0) return workspace;
  return compareUtf8(left.session_id ?? '', right.session_id ?? '');
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function textCell(value: string | number | boolean | null): string {
  if (value === null) return '-';
  return String(value);
}

function validatorRejected(message: string): Result<never, RuntimeError> {
  return err(runtimeError('E_VALIDATOR_REJECTED', message));
}
