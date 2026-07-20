import { Clock } from '../runtime/types';

export const TEAM_MANIFEST_SCHEMA = 'oma.team-manifest/v1' as const;

export type TeamTaskMode = 'interactive' | 'headless' | 'read_only';
export type TeamTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'awaiting_interaction'
  | 'orphan_identity_unproven'
  | 'recovery_fork_unresolved'
  | 'delivered_unintegrated'
  | 'integration_blocked'
  | 'completed'
  | 'blocked_permission'
  | 'failed'
  | 'cancelled'
  | 'fenced_superseded';

export interface TeamWriteScopeEntryV1 {
  kind: 'file' | 'dir';
  path: string;
}

export type TeamWriteScopeV1 = 'none' | readonly TeamWriteScopeEntryV1[];

export interface TeamVerificationCommandV1 {
  command: string;
  argv: readonly string[];
  cwd: string;
  deadlineMs: number;
  expectedExit: number;
}

export interface TeamVerificationV1 {
  version: 1;
  commands: readonly TeamVerificationCommandV1[];
  requiredArtifacts: readonly string[];
}

export interface TeamTaskSpecV1 {
  id: string;
  dependencies: readonly string[];
  write_scope: TeamWriteScopeV1;
  mode: TeamTaskMode;
  verification: TeamVerificationV1;
}

export interface TeamManifestV1 {
  schema: typeof TEAM_MANIFEST_SCHEMA;
  teamId: string;
  revision: number;
  tasks: readonly TeamTaskSpecV1[];
}

export interface CanonicalTeamTaskV1 extends Omit<TeamTaskSpecV1, 'write_scope'> {
  write_scope: TeamWriteScopeV1;
}

export interface CanonicalTeamManifestV1 extends Omit<TeamManifestV1, 'tasks'> {
  repoRoot: string;
  tasks: readonly CanonicalTeamTaskV1[];
}

export interface ProcessMarkerV1 {
  pid: number;
  startMarker: string;
}

export interface TmuxPaneIdentityV1 {
  sessionName: string;
  paneId: string;
  ownerNonce: string;
  workerNonce: string;
}

export interface ClaimLeaseV1 {
  ownerId: string;
  token: string;
  generation: number;
  leasedUntilMs: number;
}

export interface SupervisorHeartbeatV1 {
  schemaVersion: 1;
  workerId: string;
  ownerNonce: string;
  workerNonce: string;
  process: ProcessMarkerV1;
  paneId: string;
  recordedAtMs: number;
}

export interface AgentProgressV1 {
  schemaVersion: 1;
  taskId: string;
  taskRevision: number;
  claimToken: string;
  generation: number;
  kind: 'checkpoint' | 'artifact' | 'commit' | 'verification';
  artifactDigest: string;
  child: ProcessMarkerV1;
  recordedAtMs: number;
}

export interface CommandEvidenceV1 {
  schemaVersion: 1;
  commandId: string;
  taskId: string;
  claimToken: string;
  generation: number;
  argvDigest: string;
  process: ProcessMarkerV1;
  startedAtMs: number;
  finishedAtMs: number;
  deadlineMs: number;
  exitCode: number;
  artifactDigest: string;
  outputDigest: string;
}

export interface DeliveryEvidenceV1 {
  schemaVersion: 1;
  taskId: string;
  taskRevision: number;
  manifestRevision: number;
  claimToken: string;
  generation: number;
  baseSha: string;
  orderedCommits: readonly string[];
  headSha: string;
  cleanStatusDigest: string;
  commandEvidenceIds: readonly string[];
  workerWorkspaceKey: string;
  workerWorktreeRealpath: string;
  scopeDiffDigest: string;
}

export interface MailboxMessageV1 {
  schemaVersion: 1;
  id: string;
  sender: string;
  recipient: string;
  bodyDigest: string;
  createdAtMs: number;
  deliveredAtMs?: number;
}

export interface TeamTaskRuntimeV1 {
  id: string;
  revision: number;
  status: TeamTaskStatus;
  claim?: ClaimLeaseV1;
  lastProgress?: AgentProgressV1;
  commandEvidence: Readonly<Record<string, CommandEvidenceV1>>;
  delivery?: DeliveryEvidenceV1;
  recoveryForkId?: string;
}

export interface TeamAggregateV1 {
  schemaVersion: 1;
  teamId: string;
  repoKey: string | null;
  leaderWorkspaceKey: string;
  ownerNonce: string;
  manifest: CanonicalTeamManifestV1;
  tasks: Readonly<Record<string, TeamTaskRuntimeV1>>;
  heartbeats: Readonly<Record<string, SupervisorHeartbeatV1>>;
  mailbox: Readonly<Record<string, MailboxMessageV1>>;
}

export interface LeaderWorktreeIdentityV1 {
  canonicalRealpath: string;
  workspaceKey: string;
  repoKey: string;
  gitCommonDir: string;
  gitWorktreeAdminId: string;
  deviceAndInodeIfAvailable?: string;
}

export interface TeamActorIdentityV1 {
  kind: 'leader' | 'worker';
  teamId: string;
  repoKey: string;
  workspaceKey: string;
  ownerNonce: string;
  worktree: LeaderWorktreeIdentityV1;
}

export interface RuntimeContext {
  stateRoot: string;
  workspaceRoot: string;
  repoKey: string | null;
  workspaceKey: string;
  actor?: TeamActorIdentityV1;
  clock?: Clock;
  tokenFactory?: () => string;
}

export interface TeamDescriptorV1 {
  schemaVersion: 1;
  teamId: string;
  repoKey: string | null;
  leaderWorkspaceKey: string;
  ownerNonce: string;
  workerNonce: string;
  mode: TeamTaskMode;
  statePath: string;
  worktreePath?: string;
  taskIds: readonly string[];
}

