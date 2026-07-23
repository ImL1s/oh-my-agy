import * as fs from 'fs';
import * as path from 'path';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import {
  locateRunManifest,
  verifyRunManifestAtPath,
} from '../contracts/run-manifest';
import { RecoveryManifestV1, validateRecoveryManifest } from '../contracts/resume';
import { sha256Hex } from '../contracts/writer-chain';
import { writeImmutableFile } from '../runtime/atomic';
import { TeamStateStore } from '../team/state';
import { indexRepositoryWiki, searchWikiIndex } from '../wiki';

export const MCP_OPERATION_NAMES_V1 = [
  'run_status.read',
  'recovery_manifest.read',
  'wiki.search',
  'team_status.read',
  'mailbox.list',
  'proposal.create',
] as const;

export type McpOperationNameV1 = typeof MCP_OPERATION_NAMES_V1[number];

export interface McpOperationContextV1 {
  repositoryRoot: string;
  stateRoot: string;
  wikiRoots?: readonly string[];
}

export interface McpToolDefinitionV1 {
  name: McpOperationNameV1;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: false;
    idempotentHint: true;
  };
}

type JsonObject = Record<string, unknown>;

const READ_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false as const,
  idempotentHint: true,
});

const PROPOSAL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false as const,
  idempotentHint: true,
});

export const MCP_TOOLS_V1: readonly McpToolDefinitionV1[] = Object.freeze([
  {
    name: 'run_status.read',
    description: 'Read and cryptographically verify one authoritative OMA run manifest.',
    inputSchema: objectSchema({ run_id: { type: 'string', minLength: 1, maxLength: 512 } }, ['run_id']),
    annotations: READ_ANNOTATIONS,
  },
  {
    name: 'recovery_manifest.read',
    description: 'Read a confined recovery manifest and verify its immutable transcript copy.',
    inputSchema: objectSchema({ manifest_path: { type: 'string', minLength: 1, maxLength: 2048 } }, ['manifest_path']),
    annotations: READ_ANNOTATIONS,
  },
  {
    name: 'wiki.search',
    description: 'Search the deterministic repository wiki, decision, and provenance index.',
    inputSchema: objectSchema({
      query: { type: 'string', minLength: 1, maxLength: 512 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }, ['query']),
    annotations: READ_ANNOTATIONS,
  },
  {
    name: 'team_status.read',
    description: 'Read a redacted projection of the authoritative OMA team aggregate.',
    inputSchema: teamSchema(false),
    annotations: READ_ANNOTATIONS,
  },
  {
    name: 'mailbox.list',
    description: 'List generation-fenced ordered mailbox metadata for one claimed worker.',
    inputSchema: teamSchema(true),
    annotations: READ_ANNOTATIONS,
  },
  {
    name: 'proposal.create',
    description: 'Create an immutable proposal-only artifact; never mutate authoritative state.',
    inputSchema: objectSchema({
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
      category: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', minLength: 1, maxLength: 65536 },
      evidence: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 2048 } },
    }, ['run_id', 'category', 'title', 'body']),
    annotations: PROPOSAL_ANNOTATIONS,
  },
]);

export function listMcpTools(): readonly McpToolDefinitionV1[] {
  return MCP_TOOLS_V1.map((tool) => ({
    ...tool,
    inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as Record<string, unknown>,
    annotations: { ...tool.annotations },
  }));
}

export async function invokeMcpOperation(
  name: string,
  rawArguments: unknown,
  context: Readonly<McpOperationContextV1>,
): Promise<unknown> {
  if (!(MCP_OPERATION_NAMES_V1 as readonly string[]).includes(name)) {
    throw new Error(`E_MCP_TOOL_NOT_FOUND: ${name}`);
  }
  const args = plainObject(rawArguments, 'arguments');
  const repositoryRoot = fs.realpathSync(path.resolve(context.repositoryRoot));
  switch (name as McpOperationNameV1) {
    case 'run_status.read':
      return readRunStatus(repositoryRoot, args);
    case 'recovery_manifest.read':
      return readRecoveryManifest(repositoryRoot, args);
    case 'wiki.search':
      return searchWiki(repositoryRoot, context.wikiRoots, args);
    case 'team_status.read':
      return readTeamStatus(context.stateRoot, args);
    case 'mailbox.list':
      return listMailbox(context.stateRoot, args);
    case 'proposal.create':
      return createProposal(repositoryRoot, args);
  }
}

function readRunStatus(repositoryRoot: string, args: JsonObject): unknown {
  exactKeys(args, ['run_id']);
  const runId = boundedString(args.run_id, 'run_id', 512);
  const location = locateRunManifest(repositoryRoot, runId);
  const manifest = verifyRunManifestAtPath(location.manifest_path);
  return {
    store_kind: 'oma_mcp_run_status',
    schema_version: 1,
    repository_id: manifest.repository_id,
    run_id: manifest.run_id,
    run_key: manifest.run_key,
    revision: manifest.revision,
    state: manifest.state,
    lease_generation: manifest.lease_generation,
    frozen_base_commit: manifest.frozen_base_commit,
    frozen_base_tree: manifest.frozen_base_tree,
    manifest_sha256: sha256Hex(canonicalBytesV1(manifest)),
    writer_authority: manifest.writer_authority,
  };
}

function readRecoveryManifest(repositoryRoot: string, args: JsonObject): unknown {
  exactKeys(args, ['manifest_path']);
  const relative = confinedRelativePath(boundedString(args.manifest_path, 'manifest_path', 2048));
  const manifestPath = resolveRegularFile(repositoryRoot, relative, 2_097_152);
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  validateRecoveryManifest(parsed as RecoveryManifestV1);
  const manifest = parsed as RecoveryManifestV1;
  const copyRelative = confinedRelativePath(manifest.immutable_copy_path);
  const copyPath = resolveRegularFile(repositoryRoot, copyRelative, 16_777_216);
  const copyBytes = fs.readFileSync(copyPath);
  if (sha256Hex(copyBytes) !== manifest.immutable_copy_sha256) {
    throw new Error('E_RECOVERY_COPY_DIGEST: immutable recovery copy does not match manifest');
  }
  const copyMode = fs.statSync(copyPath).mode & 0o777;
  if (copyMode !== 0o400) throw new Error('E_RECOVERY_COPY_MODE: immutable recovery copy is not 0400');
  return {
    manifest,
    manifest_sha256: sha256Hex(canonicalBytesV1(manifest)),
    immutable_copy_verified: true,
    immutable_copy_bytes: copyBytes.length,
  };
}

function searchWiki(
  repositoryRoot: string,
  roots: readonly string[] | undefined,
  args: JsonObject,
): unknown {
  exactKeys(args, ['query'], ['limit']);
  const query = boundedString(args.query, 'query', 512);
  const limit = args.limit === undefined ? 20 : boundedInteger(args.limit, 'limit', 1, 50);
  const index = indexRepositoryWiki({ repositoryRoot, roots });
  return searchWikiIndex(index, query, limit);
}

function readTeamStatus(stateRoot: string, args: JsonObject): unknown {
  exactKeys(args, ['team_id', 'repo_key', 'workspace_key']);
  const fields = teamFields(args);
  const store = new TeamStateStore(stateRoot, fields.repoKey, fields.workspaceKey, fields.teamId);
  const snapshot = store.read();
  if (!snapshot.ok) throw new Error(`${snapshot.error.code}: ${snapshot.error.message}`);
  const aggregate = snapshot.value.value;
  const tasks = Object.values(aggregate.tasks)
    .sort((left, right) => compareUtf8(left.id, right.id))
    .map((task) => ({
      task_id: task.id,
      revision: task.revision,
      status: task.status,
      generation: task.claim?.generation ?? task.lastClaimGeneration ?? null,
      result_hash: task.resultHash ?? null,
      artifact_roots: [...(task.artifactRoots ?? [])],
    }));
  const blockers = tasks.filter((task) => task.status !== 'completed').map((task) => task.task_id);
  return {
    store_kind: 'oma_mcp_team_status',
    schema_version: 1,
    team_id: aggregate.teamId,
    revision: snapshot.value.revision,
    manifest_revision: aggregate.manifest.revision,
    complete: blockers.length === 0,
    blockers,
    tasks,
    mailbox_message_count: Object.keys(aggregate.mailbox).length,
    worker_binding_count: Object.keys(aggregate.workerBindings ?? {}).length,
  };
}

function listMailbox(stateRoot: string, args: JsonObject): unknown {
  exactKeys(args, [
    'team_id', 'repo_key', 'workspace_key', 'task_id', 'claim_token', 'generation', 'after_cursor',
  ]);
  const fields = teamFields(args);
  const taskId = boundedString(args.task_id, 'task_id', 512);
  const claimToken = boundedString(args.claim_token, 'claim_token', 4096);
  const generation = boundedInteger(args.generation, 'generation', 1, Number.MAX_SAFE_INTEGER);
  const afterCursor = boundedInteger(args.after_cursor, 'after_cursor', 0, Number.MAX_SAFE_INTEGER);
  const store = new TeamStateStore(stateRoot, fields.repoKey, fields.workspaceKey, fields.teamId);
  const result = store.listOrderedMailbox({ taskId, claimToken, generation, afterCursor });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return {
    store_kind: 'oma_mcp_mailbox_page',
    schema_version: 1,
    team_id: fields.teamId,
    task_id: taskId,
    generation,
    after_cursor: afterCursor,
    cursor: result.value.cursor,
    messages: result.value.messages.map((message) => ({
      id: message.id,
      sender: message.sender,
      body_digest: message.bodyDigest,
      sequence: message.sequence,
      created_at_ms: message.createdAtMs,
      delivered_at_ms: message.deliveredAtMs ?? null,
      acknowledged_at_ms: message.acknowledgedAtMs ?? null,
    })),
  };
}

function createProposal(repositoryRoot: string, args: JsonObject): unknown {
  exactKeys(args, ['run_id', 'category', 'title', 'body'], ['evidence']);
  const runId = boundedString(args.run_id, 'run_id', 512);
  const category = boundedString(args.category, 'category', 64);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(category)) {
    throw new Error('E_MCP_ARGUMENT: category must be canonical kebab-case');
  }
  const title = boundedString(args.title, 'title', 200);
  const body = boundedString(args.body, 'body', 65_536);
  const evidence = stringArray(args.evidence ?? [], 'evidence', 100, 2048);
  const material = {
    store_kind: 'oma_mcp_proposal',
    schema_version: 1,
    repository_id: 'OMA',
    authority: 'proposal_only',
    created_by: 'oma_mcp',
    run_id: runId,
    category,
    title,
    body,
    evidence,
  } as const;
  const proposalDigest = sha256Hex(canonicalBytesV1(material));
  const proposal = { ...material, proposal_digest: proposalDigest };
  const relativePath = `.agy/artifacts/mcp-proposals/${proposalDigest}.json`;
  const targetPath = path.resolve(repositoryRoot, ...relativePath.split('/'));
  if (!contained(repositoryRoot, targetPath)) throw new Error('E_MCP_PATH: proposal path escaped root');
  writeImmutableFile(targetPath, canonicalBytesV1(proposal));
  return {
    proposal_id: proposalDigest,
    proposal_digest: proposalDigest,
    proposal_path: relativePath,
    authority: 'proposal_only',
    immutable: true,
  };
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function teamSchema(mailbox: boolean): Readonly<Record<string, unknown>> {
  const properties: Record<string, unknown> = {
    team_id: { type: 'string', minLength: 1, maxLength: 512 },
    repo_key: { type: ['string', 'null'], maxLength: 512 },
    workspace_key: { type: 'string', minLength: 1, maxLength: 512 },
  };
  const required = ['team_id', 'repo_key', 'workspace_key'];
  if (mailbox) {
    Object.assign(properties, {
      task_id: { type: 'string', minLength: 1, maxLength: 512 },
      claim_token: { type: 'string', minLength: 1, maxLength: 4096 },
      generation: { type: 'integer', minimum: 1 },
      after_cursor: { type: 'integer', minimum: 0 },
    });
    required.push('task_id', 'claim_token', 'generation', 'after_cursor');
  }
  return objectSchema(properties, required);
}

function teamFields(args: JsonObject): { teamId: string; repoKey: string | null; workspaceKey: string } {
  return {
    teamId: boundedString(args.team_id, 'team_id', 512),
    repoKey: args.repo_key === null ? null : boundedString(args.repo_key, 'repo_key', 512),
    workspaceKey: boundedString(args.workspace_key, 'workspace_key', 512),
  };
}

function plainObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`E_MCP_ARGUMENT: ${label} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`E_MCP_ARGUMENT: unexpected/missing keys (${unknown.join(',')};${missing.join(',')})`);
  }
}

function boundedString(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new Error(`E_MCP_ARGUMENT: ${label} is invalid or exceeds its bound`);
  }
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`E_MCP_ARGUMENT: ${label} is outside its bound`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string, maxItems: number, maxBytes: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`E_MCP_ARGUMENT: ${label} is not a bounded array`);
  }
  const output = value.map((entry) => boundedString(entry, label, maxBytes));
  if (new Set(output).size !== output.length) throw new Error(`E_MCP_ARGUMENT: ${label} contains duplicates`);
  return output;
}

function confinedRelativePath(value: string): string {
  if (path.isAbsolute(value) || value.includes('\0') || value.includes('\\')) {
    throw new Error('E_MCP_PATH: path must be a confined relative POSIX path');
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('E_MCP_PATH: path escapes repository');
  }
  return normalized;
}

function resolveRegularFile(root: string, relative: string, maximumBytes: number): string {
  const candidate = path.resolve(root, ...relative.split('/'));
  if (!contained(root, candidate)) throw new Error('E_MCP_PATH: path escapes repository');
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new Error('E_MCP_PATH: target must be a bounded regular non-symlink file');
  }
  const resolved = fs.realpathSync(candidate);
  if (!contained(root, resolved)) throw new Error('E_MCP_PATH: target resolves outside repository');
  return resolved;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
