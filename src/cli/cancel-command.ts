/**
 * 設計概念映射：OMC `skills/cancel`、OMX `omx cancel`、OMG `omg cancel`
 * 的 top-level 取消入口。OMA 以既有 SessionAggregateStore / Team StateStore
 * 的 CAS（expected-revision）圍籬停用目標，禁止手改權威狀態檔。
 *
 * `oma autopilot cancel` 仍為低階帳本 verb，本檔為較高層便利入口。
 * 本命令不刪除 worktree、不執行破壞性 git 還原或強制清潔。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AutopilotRuntime } from '../autopilot/runtime';
import {
  AutopilotPhase,
  SessionAggregateStore,
  sessionAggregatePath,
} from '../continuation/session-aggregate';
import { listWorkspaceSessionInventory } from '../continuation/state';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { StateStore } from '../runtime/state-store';
import { resolveStateRoot, resolveWorkspaceIdentity } from '../runtime/state-root';
import { Result, err, ok } from '../runtime/types';
import { TeamStateStore } from '../team/state';
import { TeamAggregateV1, TeamTaskRuntimeV1, TeamTaskStatus } from '../team/types';

export const CANCEL_USAGE =
  'Usage: oma cancel [--session <id> --workspace-key <key>] [--team <id>] [--all] [--reason <text>] [--json]';
export const CANCEL_NO_TARGET_MESSAGE = 'No active OMA session or team to cancel.';
export const CANCEL_DEFAULT_REASON = 'operator cancel';

const TEAM_TERMINAL_STATUSES = new Set<TeamTaskStatus>([
  'completed',
  'blocked_permission',
  'failed',
  'cancelled',
  'fenced_superseded',
]);

export interface CancelOptionsV1 {
  readonly asJson: boolean;
  readonly sessionId: string | undefined;
  readonly workspaceKey: string | undefined;
  readonly teamId: string | undefined;
  readonly all: boolean;
  readonly reason: string;
}

export type ParsedCancelCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'run'; readonly options: CancelOptionsV1 };

export interface CancelCommandContext {
  readonly cwd: string;
  readonly stateRoot?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface CancelledSessionV1 {
  readonly session_id: string;
  readonly workspace_key: string;
  readonly revision: number;
  readonly phase: string;
  readonly reason: string;
  readonly cancelled_at: string;
}

export interface CancelledTeamV1 {
  readonly team_id: string;
  readonly repo_key: string | null;
  readonly workspace_key: string;
  readonly revision: number;
  readonly reason: string;
  readonly cancelled_at: string;
  readonly cancelled_task_ids: readonly string[];
}

export interface CancelResultV1 {
  readonly ok: true;
  readonly kind: 'oma-cancelled';
  readonly schema_version: 1;
  readonly noop: boolean;
  readonly reason: string | null;
  readonly cancelled_at: string | null;
  readonly message: string | null;
  readonly sessions: readonly CancelledSessionV1[];
  readonly teams: readonly CancelledTeamV1[];
}

interface TeamInventoryEntryV1 {
  readonly repoKey: string | null;
  readonly workspaceKey: string;
  readonly teamId: string;
  readonly revision: number;
  readonly active: boolean;
}

interface TeamCancelRecordV1 {
  readonly schemaVersion: 1;
  readonly teamId: string;
  readonly reason: string;
  readonly cancelledAt: string;
  readonly actor: 'operator';
}

export function parseCancelArgv(
  argv: readonly string[],
): Result<ParsedCancelCommand, RuntimeError> {
  let asJson = false;
  let sessionId: string | undefined;
  let workspaceKey: string | undefined;
  let teamId: string | undefined;
  let all = false;
  let reason: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') {
      if (asJson) return validatorRejected('duplicate option --json');
      asJson = true;
      continue;
    }
    if (token === '--all') {
      if (all) return validatorRejected('duplicate option --all');
      all = true;
      continue;
    }
    if (token === '--session') {
      if (sessionId !== undefined) return validatorRejected('--session may appear only once');
      const value = takeFlagValue(argv, index, '--session');
      if (!value.ok) return value;
      sessionId = value.value;
      index += 1;
      continue;
    }
    if (token === '--workspace-key') {
      if (workspaceKey !== undefined) return validatorRejected('--workspace-key may appear only once');
      const value = takeFlagValue(argv, index, '--workspace-key');
      if (!value.ok) return value;
      workspaceKey = value.value;
      index += 1;
      continue;
    }
    if (token === '--team') {
      if (teamId !== undefined) return validatorRejected('--team may appear only once');
      const value = takeFlagValue(argv, index, '--team');
      if (!value.ok) return value;
      teamId = value.value;
      index += 1;
      continue;
    }
    if (token === '--reason') {
      if (reason !== undefined) return validatorRejected('--reason may appear only once');
      const value = takeFlagValue(argv, index, '--reason');
      if (!value.ok) return value;
      reason = value.value;
      index += 1;
      continue;
    }
    if (token === '--help' || token === '-h' || token === 'help') {
      return ok({ kind: 'help' });
    }
    return validatorRejected(CANCEL_USAGE);
  }
  if ((sessionId === undefined) !== (workspaceKey === undefined)) {
    return validatorRejected('--session and --workspace-key must be supplied together');
  }
  if (all && (sessionId !== undefined || teamId !== undefined)) {
    return validatorRejected('--all cannot be combined with --session or --team');
  }
  return ok({
    kind: 'run',
    options: {
      asJson,
      sessionId,
      workspaceKey,
      teamId,
      all,
      reason: reason ?? CANCEL_DEFAULT_REASON,
    },
  });
}

export async function cancelManagedSession(input: Readonly<{
  stateRoot: string;
  workspaceKey: string;
  sessionId: string;
  expectedRevision: number;
  reason: string;
  now?: Date;
}>): Promise<Result<CancelledSessionV1, RuntimeError>> {
  const now = input.now ?? new Date();
  const runtime = AutopilotRuntime.create({
    stateRoot: input.stateRoot,
    workspaceKey: input.workspaceKey,
    now: () => now,
  });
  if (!runtime.ok) return runtime;
  const cancelled = await runtime.value.cancel(input.sessionId, input.expectedRevision, input.reason);
  if (!cancelled.ok) return cancelled;
  return ok({
    session_id: cancelled.value.sessionId,
    workspace_key: input.workspaceKey,
    revision: cancelled.value.revision,
    phase: cancelled.value.phase,
    reason: cancelled.value.terminal?.reason ?? input.reason,
    cancelled_at: cancelled.value.terminal?.at ?? now.toISOString(),
  });
}

export async function cancelManagedTeam(input: Readonly<{
  stateRoot: string;
  repoKey: string | null;
  workspaceKey: string;
  teamId: string;
  expectedRevision: number;
  reason: string;
  now?: Date;
}>): Promise<Result<CancelledTeamV1, RuntimeError>> {
  const now = (input.now ?? new Date()).toISOString();
  const teamStore = new TeamStateStore(
    input.stateRoot,
    input.repoKey,
    input.workspaceKey,
    input.teamId,
  );
  const backing = new StateStore<TeamAggregateV1>(input.stateRoot);
  const updated = await backing.compareAndSwap(
    teamStore.key,
    input.expectedRevision,
    (current) => deactivateTeamAggregate(current),
  );
  if (!updated.ok) return updated;
  const cancelledTaskIds = Object.values(updated.value.value.tasks)
    .filter((task) => task.status === 'cancelled')
    .map((task) => task.id)
    .sort((left, right) => compareUtf8(left, right));
  const recordStore = new StateStore<TeamCancelRecordV1>(input.stateRoot);
  const recordKey = `${path.posix.dirname(teamStore.key)}/cancel-record`;
  const record: TeamCancelRecordV1 = {
    schemaVersion: 1,
    teamId: input.teamId,
    reason: input.reason,
    cancelledAt: now,
    actor: 'operator',
  };
  const created = await recordStore.create(recordKey, record);
  if (!created.ok && created.error.code === 'E_ALREADY_EXISTS') {
    const current = recordStore.read(recordKey);
    if (current.ok) {
      await recordStore.compareAndSwap(recordKey, current.value.revision, () => record);
    }
  } else if (!created.ok) {
    return created;
  }
  return ok({
    team_id: input.teamId,
    repo_key: input.repoKey,
    workspace_key: input.workspaceKey,
    revision: updated.value.revision,
    reason: input.reason,
    cancelled_at: now,
    cancelled_task_ids: cancelledTaskIds,
  });
}

export async function runCancelCommand(
  argv: readonly string[],
  context: Readonly<CancelCommandContext>,
): Promise<number> {
  const parsed = parseCancelArgv(argv);
  if (!parsed.ok) {
    context.stderr(`${parsed.error.code}: ${parsed.error.message}\n`);
    return 2;
  }
  if (parsed.value.kind === 'help') {
    context.stdout(`${CANCEL_USAGE}\n`);
    return 0;
  }
  const options = parsed.value.options;
  const stateRoot = resolveCancelStateRoot(context);
  if (!stateRoot.ok) {
    context.stderr(`${stateRoot.error.code}: ${stateRoot.error.message}\n`);
    return 1;
  }
  const clock = context.now ?? (() => new Date());
  const targets = resolveCancelTargets(stateRoot.value, context.cwd, options);
  if (!targets.ok) {
    context.stderr(`${targets.error.code}: ${targets.error.message}\n`);
    return targets.error.code === 'E_VALIDATOR_REJECTED' ? 2 : 1;
  }
  if (targets.value.sessions.length === 0 && targets.value.teams.length === 0) {
    const noop = renderCancelResult({
      ok: true,
      kind: 'oma-cancelled',
      schema_version: 1,
      noop: true,
      reason: null,
      cancelled_at: null,
      message: CANCEL_NO_TARGET_MESSAGE,
      sessions: [],
      teams: [],
    }, options.asJson);
    context.stdout(`${noop}\n`);
    return 0;
  }

  const sessions: CancelledSessionV1[] = [];
  const teams: CancelledTeamV1[] = [];
  const now = clock();
  for (const session of targets.value.sessions) {
    const cancelled = await cancelManagedSession({
      stateRoot: stateRoot.value,
      workspaceKey: session.workspaceKey,
      sessionId: session.sessionId,
      expectedRevision: session.revision,
      reason: options.reason,
      now,
    });
    if (!cancelled.ok) {
      context.stderr(`${cancelled.error.code}: ${cancelled.error.message}\n`);
      return cancelled.error.code === 'E_VALIDATOR_REJECTED' ? 2 : 1;
    }
    sessions.push(cancelled.value);
  }
  for (const team of targets.value.teams) {
    const cancelled = await cancelManagedTeam({
      stateRoot: stateRoot.value,
      repoKey: team.repoKey,
      workspaceKey: team.workspaceKey,
      teamId: team.teamId,
      expectedRevision: team.revision,
      reason: options.reason,
      now,
    });
    if (!cancelled.ok) {
      context.stderr(`${cancelled.error.code}: ${cancelled.error.message}\n`);
      return cancelled.error.code === 'E_VALIDATOR_REJECTED' ? 2 : 1;
    }
    teams.push(cancelled.value);
  }
  const rendered = renderCancelResult({
    ok: true,
    kind: 'oma-cancelled',
    schema_version: 1,
    noop: false,
    reason: options.reason,
    cancelled_at: now.toISOString(),
    message: null,
    sessions,
    teams,
  }, options.asJson);
  context.stdout(`${rendered}\n`);
  return 0;
}

function resolveCancelTargets(
  stateRoot: string,
  cwd: string,
  options: Readonly<CancelOptionsV1>,
): Result<{
  sessions: readonly { sessionId: string; workspaceKey: string; revision: number }[];
  teams: readonly TeamInventoryEntryV1[];
}, RuntimeError> {
  if (options.all) {
    const sessions = listActiveSessions(stateRoot);
    if (!sessions.ok) return sessions;
    const teams = listActiveTeams(stateRoot);
    if (!teams.ok) return teams;
    return ok({ sessions: sessions.value, teams: teams.value });
  }
  if (options.sessionId !== undefined || options.teamId !== undefined) {
    const sessions: { sessionId: string; workspaceKey: string; revision: number }[] = [];
    const teams: TeamInventoryEntryV1[] = [];
    if (options.sessionId !== undefined && options.workspaceKey !== undefined) {
      const explicit = readExplicitSession(stateRoot, options.workspaceKey, options.sessionId);
      if (!explicit.ok) return explicit;
      if (explicit.value !== null) sessions.push(explicit.value);
    }
    if (options.teamId !== undefined) {
      const explicit = findExplicitTeam(stateRoot, options.teamId);
      if (!explicit.ok) return explicit;
      if (explicit.value !== null) teams.push(explicit.value);
    }
    return ok({ sessions, teams });
  }
  const identity = resolveWorkspaceIdentity(cwd);
  if (!identity.ok) return identity;
  const sessions = listActiveSessions(stateRoot, identity.value.workspaceKey);
  if (!sessions.ok) return sessions;
  return ok({ sessions: sessions.value, teams: [] });
}

function readExplicitSession(
  stateRoot: string,
  workspaceKey: string,
  sessionId: string,
): Result<{ sessionId: string; workspaceKey: string; revision: number } | null, RuntimeError> {
  const store = new SessionAggregateStore(sessionAggregatePath(stateRoot, workspaceKey, sessionId));
  const current = store.read();
  if (!current.ok) return current;
  if (isSessionTerminal(current.value.autopilot.phase) && current.value.autopilot.phase !== 'cancelled') {
    return err(runtimeError('E_TERMINAL_STATE', 'Session is already terminal'));
  }
  if (current.value.autopilot.phase === 'cancelled') return ok(null);
  return ok({
    sessionId: current.value.sessionId,
    workspaceKey: current.value.workspaceKey !== '' ? current.value.workspaceKey : workspaceKey,
    revision: current.value.revision,
  });
}

function findExplicitTeam(
  stateRoot: string,
  teamId: string,
): Result<TeamInventoryEntryV1 | null, RuntimeError> {
  const listed = listTeamInventory(stateRoot);
  if (!listed.ok) return listed;
  const matches = listed.value.filter((entry) => entry.teamId === teamId);
  if (matches.length === 0) {
    return err(runtimeError('E_NOT_FOUND', 'Team aggregate does not exist', { teamId }));
  }
  if (matches.length > 1) {
    return err(runtimeError('E_WORKSPACE_AMBIGUOUS', 'Team id matches more than one aggregate', {
      teamId,
    }));
  }
  const match = matches[0]!;
  return ok(match.active ? match : null);
}

function listActiveSessions(
  stateRoot: string,
  workspaceKey?: string,
): Result<readonly { sessionId: string; workspaceKey: string; revision: number }[], RuntimeError> {
  const inventory = listWorkspaceSessionInventory(stateRoot, workspaceKey);
  if (!inventory.ok) return inventory;
  const active: { sessionId: string; workspaceKey: string; revision: number }[] = [];
  for (const entry of inventory.value) {
    const read = new SessionAggregateStore(entry.aggregatePath).read();
    if (!read.ok) continue;
    if (isSessionTerminal(read.value.autopilot.phase)) continue;
    active.push({
      sessionId: read.value.sessionId,
      workspaceKey: read.value.workspaceKey !== '' ? read.value.workspaceKey : entry.workspacePathKey,
      revision: read.value.revision,
    });
  }
  return ok(active);
}

function listActiveTeams(
  stateRoot: string,
): Result<readonly TeamInventoryEntryV1[], RuntimeError> {
  const listed = listTeamInventory(stateRoot);
  if (!listed.ok) return listed;
  return ok(listed.value.filter((entry) => entry.active));
}

function listTeamInventory(stateRoot: string): Result<readonly TeamInventoryEntryV1[], RuntimeError> {
  const root = path.resolve(stateRoot);
  if (!fs.existsSync(root)) return ok([]);
  const repositories = listTeamPartition(root, 'repositories', 'teams', 'repo');
  if (!repositories.ok) return repositories;
  const readonlyTeams = listTeamPartition(root, 'workspaces', 'teams-readonly', 'workspace');
  if (!readonlyTeams.ok) return readonlyTeams;
  return ok([...repositories.value, ...readonlyTeams.value]);
}

function listTeamPartition(
  stateRoot: string,
  parentName: 'repositories' | 'workspaces',
  teamsDirName: 'teams' | 'teams-readonly',
  ownerKind: 'repo' | 'workspace',
): Result<readonly TeamInventoryEntryV1[], RuntimeError> {
  const parent = path.join(stateRoot, parentName);
  const owners = listChildDirectories(parent);
  if (!owners.ok) return owners;
  const entries: TeamInventoryEntryV1[] = [];
  for (const owner of owners.value) {
    const teamsRoot = path.join(parent, owner, teamsDirName);
    const teams = listChildDirectories(teamsRoot);
    if (!teams.ok) return teams;
    for (const teamId of teams.value) {
      const store = new TeamStateStore(
        stateRoot,
        ownerKind === 'repo' ? owner : null,
        ownerKind === 'workspace' ? owner : 'unknown',
        teamId,
      );
      const snapshot = store.read();
      if (!snapshot.ok) continue;
      const workspaceKey = ownerKind === 'workspace'
        ? owner
        : snapshot.value.value.leaderWorkspaceKey;
      const repoKey = ownerKind === 'repo' ? owner : snapshot.value.value.repoKey;
      entries.push({
        repoKey,
        workspaceKey,
        teamId: snapshot.value.value.teamId,
        revision: snapshot.value.revision,
        active: teamIsActive(snapshot.value.value),
      });
    }
  }
  return ok(entries);
}

function teamIsActive(aggregate: Readonly<TeamAggregateV1>): boolean {
  return Object.values(aggregate.tasks).some((task) => !TEAM_TERMINAL_STATUSES.has(task.status));
}

function deactivateTeamAggregate(current: Readonly<TeamAggregateV1>): TeamAggregateV1 {
  const tasks: Record<string, TeamTaskRuntimeV1> = {};
  for (const [taskId, task] of Object.entries(current.tasks)) {
    if (TEAM_TERMINAL_STATUSES.has(task.status)) {
      tasks[taskId] = task;
      continue;
    }
    tasks[taskId] = {
      ...task,
      revision: task.revision + 1,
      status: 'cancelled',
      claim: undefined,
    };
  }
  return { ...current, tasks };
}

function isSessionTerminal(phase: AutopilotPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'tripped' || phase === 'cancelled';
}

function resolveCancelStateRoot(
  context: Readonly<CancelCommandContext>,
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

function renderCancelResult(result: Readonly<CancelResultV1>, asJson: boolean): string {
  if (asJson) return canonicalBytesV1(result).toString('utf8');
  if (result.noop) return result.message ?? CANCEL_NO_TARGET_MESSAGE;
  const lines: string[] = [];
  for (const session of result.sessions) {
    lines.push(
      `Cancelled session ${session.session_id} (${session.workspace_key}) revision ${session.revision}.`,
    );
  }
  for (const team of result.teams) {
    lines.push(`Cancelled team ${team.team_id} revision ${team.revision}.`);
  }
  return lines.join('\n');
}

function takeFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
): Result<string, RuntimeError> {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--') || value.includes('\0') || value.trim() === '') {
    return validatorRejected(`${flag} requires one non-empty value`);
  }
  return ok(value);
}

function listChildDirectories(parent: string): Result<readonly string[], RuntimeError> {
  if (!fs.existsSync(parent)) return ok([]);
  try {
    const stat = fs.lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return err(runtimeError('E_CORRUPT_STATE', 'Inventory parent is not a real directory', {
        parent,
      }));
    }
    const names: string[] = [];
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.includes('/') || entry.name.includes('\\') || entry.name.includes('\0')) continue;
      names.push(entry.name);
    }
    names.sort((left, right) => compareUtf8(left, right));
    return ok(names);
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'Inventory parent could not be read', {
      parent,
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function validatorRejected(message: string): Result<never, RuntimeError> {
  return err(runtimeError('E_VALIDATOR_REJECTED', message));
}
