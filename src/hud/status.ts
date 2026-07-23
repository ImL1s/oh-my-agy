import * as fs from 'fs';
import * as path from 'path';
import {
  SessionAggregateStore,
  sessionAggregateHash,
  sessionAggregateRelativePath,
} from '../continuation/session-aggregate';
import { sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { redactDiagnostic } from '../runtime/redaction';
import { ensureContainedPath } from '../runtime/state-root';
import { Result, err, ok } from '../runtime/types';
import { TeamStateStore } from '../team/state';
import { TeamTaskStatus } from '../team/types';

export interface HudSessionQueryV1 {
  workspace_key: string;
  session_id: string;
}

export interface HudTeamQueryV1 {
  repo_key: string | null;
  workspace_key: string;
  team_id: string;
}

export interface HudAdapterViewV1 {
  adapter: 'antigravity_public' | 'host_lsp' | 'private_sidecar' | 'notifications';
  status: string;
  observed: boolean;
  enabled: boolean;
  detail_code: string;
}

export interface HudQueryV1 {
  state_root: string;
  session?: HudSessionQueryV1;
  team?: HudTeamQueryV1;
  adapters?: readonly HudAdapterViewV1[];
  collected_at?: string;
}

export interface HudUnavailableViewV1 {
  status: 'unavailable' | 'corrupt';
  code: string;
  detail: string;
}

export interface HudSessionViewV1 {
  status: 'available';
  session_id_sha256: string;
  aggregate_id: string;
  aggregate_sha256: string;
  revision: number;
  phase: string;
  terminal_phase: string | null;
  terminal_reason_sha256: string | null;
  conversation_bound: boolean;
  binding_state: string;
  generation: number;
  owner_present: boolean;
  retryable_blocker_kind: string | null;
  interaction_blocked: boolean;
  no_progress_streak: number;
  iteration: number;
  review_cycle: number;
  accepted_evidence_count: number;
  verified_artifact_count: number;
}

export interface HudTeamTaskViewV1 {
  task_id: string;
  revision: number;
  status: TeamTaskStatus;
  generation: number | null;
  lease_expired: boolean | null;
  has_progress: boolean;
  command_evidence_count: number;
  worker_provider: string | null;
  worker_state: string | null;
}

export interface HudTeamViewV1 {
  status: 'available';
  team_id: string;
  revision: number;
  manifest_revision: number;
  task_count: number;
  completed_count: number;
  terminal_count: number;
  active_count: number;
  blocker_count: number;
  blockers: string[];
  mailbox_message_count: number;
  worker_binding_count: number;
  supervisor_present: boolean;
  tasks: HudTeamTaskViewV1[];
}

export interface HudSnapshotV1 {
  store_kind: 'oma_hud_snapshot';
  schema_version: 1;
  repository_id: 'OMA';
  collected_at: string;
  session: HudSessionViewV1 | HudUnavailableViewV1 | null;
  team: HudTeamViewV1 | HudUnavailableViewV1 | null;
  adapters: HudAdapterViewV1[];
  core_available: boolean;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,512}$/u;
const TERMINAL_TEAM_STATUSES = new Set<TeamTaskStatus>([
  'completed',
  'blocked_permission',
  'failed',
  'cancelled',
  'fenced_superseded',
]);
const BLOCKED_TEAM_STATUSES = new Set<TeamTaskStatus>([
  'awaiting_interaction',
  'orphan_identity_unproven',
  'recovery_fork_unresolved',
  'integration_blocked',
  'blocked_permission',
  'failed',
]);

export function collectHudSnapshot(
  input: Readonly<HudQueryV1>,
): Result<HudSnapshotV1, RuntimeError> {
  const timestamp = input.collected_at ?? new Date().toISOString();
  if (!canonicalTimestamp(timestamp)) {
    return err(runtimeError('E_CORRUPT_STATE', 'HUD collected_at must be canonical UTC'));
  }
  const stateRoot = validateStateRoot(input.state_root);
  if (!stateRoot.ok) return stateRoot;
  const session = input.session === undefined
    ? null
    : readSessionHud(stateRoot.value, input.session);
  const team = input.team === undefined
    ? null
    : readTeamHud(stateRoot.value, input.team, Date.parse(timestamp));
  const adapters = normalizeAdapters(input.adapters ?? []);
  return ok({
    store_kind: 'oma_hud_snapshot',
    schema_version: 1,
    repository_id: 'OMA',
    collected_at: timestamp,
    session,
    team,
    adapters,
    core_available: session?.status === 'available' || team?.status === 'available',
  });
}

function readSessionHud(
  stateRoot: string,
  query: Readonly<HudSessionQueryV1>,
): HudSessionViewV1 | HudUnavailableViewV1 {
  if (!safeIdentifier(query.workspace_key) || !safeIdentifier(query.session_id)) {
    return unavailable('corrupt', 'E_UNSAFE_IDENTIFIER', 'Session HUD identity is invalid');
  }
  const relative = sessionAggregateRelativePath(query.workspace_key, query.session_id);
  const target = ensureContainedPath(stateRoot, relative);
  if (!target.ok) return fromError(target.error);
  if (fs.existsSync(target.value) && fs.lstatSync(target.value).isSymbolicLink()) {
    return unavailable('corrupt', 'E_PATH_OUTSIDE_ROOT', 'Session aggregate path is a symlink');
  }
  const read = new SessionAggregateStore(target.value).read();
  if (!read.ok) return fromError(read.error);
  const aggregate = read.value;
  return {
    status: 'available',
    session_id_sha256: sha256(aggregate.sessionId),
    aggregate_id: aggregate.aggregate_id,
    aggregate_sha256: sessionAggregateHash(aggregate),
    revision: aggregate.revision,
    phase: aggregate.autopilot.phase,
    terminal_phase: aggregate.autopilot.terminal?.phase ?? null,
    terminal_reason_sha256: aggregate.autopilot.terminal === null
      ? null : sha256(aggregate.autopilot.terminal.reason),
    conversation_bound: aggregate.binding.conversationId !== null,
    binding_state: aggregate.binding.state,
    generation: aggregate.binding.activeInvocationGeneration,
    owner_present: aggregate.binding.owner !== null,
    retryable_blocker_kind: aggregate.autopilot.retryableBlocker?.kind ?? null,
    interaction_blocked: aggregate.autopilot.interactionBlocker !== null,
    no_progress_streak: aggregate.autopilot.noProgressStreak,
    iteration: aggregate.autopilot.iteration,
    review_cycle: aggregate.autopilot.reviewCycle,
    accepted_evidence_count: aggregate.autopilot.acceptedEvidence.length,
    verified_artifact_count: aggregate.autopilot.verifiedArtifacts.length,
  };
}

function readTeamHud(
  stateRoot: string,
  query: Readonly<HudTeamQueryV1>,
  nowMs: number,
): HudTeamViewV1 | HudUnavailableViewV1 {
  if (!safeIdentifier(query.workspace_key) || !safeIdentifier(query.team_id)
    || (query.repo_key !== null && !safeIdentifier(query.repo_key))) {
    return unavailable('corrupt', 'E_UNSAFE_IDENTIFIER', 'Team HUD identity is invalid');
  }
  const partition = query.repo_key === null
    ? path.join('workspaces', query.workspace_key, 'teams-readonly')
    : path.join('repositories', query.repo_key, 'teams');
  const relative = path.join(partition, query.team_id, 'aggregate.json');
  const target = ensureContainedPath(stateRoot, relative);
  if (!target.ok) return fromError(target.error);
  if (fs.existsSync(target.value) && fs.lstatSync(target.value).isSymbolicLink()) {
    return unavailable('corrupt', 'E_PATH_OUTSIDE_ROOT', 'Team aggregate path is a symlink');
  }
  const read = new TeamStateStore(
    stateRoot,
    query.repo_key,
    query.workspace_key,
    query.team_id,
  ).read();
  if (!read.ok) return fromError(read.error);
  const aggregate = read.value.value;
  const tasks = Object.values(aggregate.tasks)
    .sort((left, right) => compareUtf8(left.id, right.id))
    .map((task): HudTeamTaskViewV1 => {
      const binding = aggregate.workerBindings?.[task.id];
      return {
        task_id: task.id,
        revision: task.revision,
        status: task.status,
        generation: task.claim?.generation ?? task.lastClaimGeneration ?? null,
        lease_expired: task.claim === undefined ? null : task.claim.leasedUntilMs <= nowMs,
        has_progress: task.lastProgress !== undefined,
        command_evidence_count: Object.keys(task.commandEvidence).length,
        worker_provider: binding?.provider ?? null,
        worker_state: binding?.state ?? null,
      };
    });
  const blockers = tasks
    .filter((task) => BLOCKED_TEAM_STATUSES.has(task.status))
    .map((task) => task.task_id);
  return {
    status: 'available',
    team_id: aggregate.teamId,
    revision: read.value.revision,
    manifest_revision: aggregate.manifest.revision,
    task_count: tasks.length,
    completed_count: tasks.filter((task) => task.status === 'completed').length,
    terminal_count: tasks.filter((task) => TERMINAL_TEAM_STATUSES.has(task.status)).length,
    active_count: tasks.filter((task) => ['in_progress', 'awaiting_interaction'].includes(task.status)).length,
    blocker_count: blockers.length,
    blockers,
    mailbox_message_count: Object.keys(aggregate.mailbox).length,
    worker_binding_count: Object.keys(aggregate.workerBindings ?? {}).length,
    supervisor_present: aggregate.supervisor !== undefined,
    tasks,
  };
}

function validateStateRoot(value: string): Result<string, RuntimeError> {
  if (typeof value !== 'string' || value.trim() === '') {
    return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'HUD state root must be non-empty'));
  }
  const absolute = path.resolve(value);
  try {
    if (!fs.existsSync(absolute)) {
      return err(runtimeError('E_NOT_FOUND', 'HUD state root does not exist', { stateRoot: absolute }));
    }
    if (fs.lstatSync(absolute).isSymbolicLink() || !fs.statSync(absolute).isDirectory()) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'HUD state root must be a real directory'));
    }
    return ok(fs.realpathSync(absolute));
  } catch (error) {
    return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'HUD state root could not be read', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

function normalizeAdapters(adapters: readonly HudAdapterViewV1[]): HudAdapterViewV1[] {
  const seen = new Set<string>();
  return [...adapters]
    .sort((left, right) => compareUtf8(left.adapter, right.adapter))
    .filter((adapter) => {
      if (seen.has(adapter.adapter)) return false;
      seen.add(adapter.adapter);
      return true;
    })
    .map((adapter) => ({
      adapter: adapter.adapter,
      status: boundedText(redactDiagnostic(adapter.status, 128), 128),
      observed: adapter.observed === true,
      enabled: adapter.enabled === true,
      detail_code: boundedText(redactDiagnostic(adapter.detail_code, 128), 128),
    }));
}

function fromError(error: RuntimeError): HudUnavailableViewV1 {
  return unavailable(
    error.code === 'E_NOT_FOUND' ? 'unavailable' : 'corrupt',
    error.code,
    error.message,
  );
}

function unavailable(
  status: HudUnavailableViewV1['status'],
  code: string,
  detail: string,
): HudUnavailableViewV1 {
  return { status, code: boundedText(code, 128), detail: boundedText(detail, 512) };
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value)
    && !value.includes('/') && !value.includes('\\');
}

function canonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function boundedText(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}
