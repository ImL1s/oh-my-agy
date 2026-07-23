import {
  RepositoryWorkflowV1,
  WorkflowStageV1,
  validateRepositoryWorkflow,
} from '../contracts/repository-workflow';
import {
  WorkerDependencyResultV1,
  WorkerEnvelopeV1,
  WorkerProvider,
  validateWorkerEnvelope,
} from '../contracts/worker-envelope';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import { sha256Hex } from '../contracts/writer-chain';
import { MCP_OPERATION_NAMES_V1 } from '../mcp/operations';
import {
  WorkflowPermissionBundleV1,
  WorkflowPlannedTaskV1,
  workflowEnvelopeDigest,
} from './schema';

export interface WorkflowPermissionContextV1 {
  run_id: string;
  team_id: string;
  claim_id: string;
  state_endpoint: string;
  cancellation_token_hash: string;
  provider: WorkerProvider;
  mailbox_cursor: number;
  contributor_guidance_hashes: Array<{ path: string; sha256: string }>;
}

const SAFE_STAGE_PERMISSIONS_V1 = new Set([
  'repository:read',
  'repository:write',
  'artifact:proposal',
]);

export function compileWorkflowPermissions(input: {
  definition: RepositoryWorkflowV1;
  stage: WorkflowStageV1;
  task: WorkflowPlannedTaskV1;
  dependency_results: readonly WorkerDependencyResultV1[];
  context: WorkflowPermissionContextV1;
}): WorkflowPermissionBundleV1 {
  const definition = validateRepositoryWorkflow(input.definition);
  const stage = definition.stages.find((entry) => entry.stage_id === input.stage.stage_id);
  if (stage === undefined || canonicalBytesV1(stage).compare(canonicalBytesV1(input.stage)) !== 0
    || input.task.stage_id !== stage.stage_id || input.task.generation < 1) {
    throw new Error('E_WORKFLOW_PERMISSION: stage/task is stale or foreign to definition');
  }
  assertMcpAllowlist(stage.mcp_allowlist);
  assertStagePermissions(stage);
  if (input.dependency_results.length !== input.task.dependency_task_ids.length
    || input.dependency_results.some((result, index) =>
      result.task_id !== input.task.dependency_task_ids[index])) {
    throw new Error('E_WORKFLOW_PERMISSION: dependency results are not exact ordered receipts');
  }
  const proposalRoot = `.agy/artifacts/workflows/${input.task.task_id}`;
  const required = requiredArtifactNames(stage).map((entry) => `${proposalRoot}/${entry}`);
  const taskText = canonicalBytesV1({
    workflow: definition.name,
    workflow_version: definition.workflow_version,
    stage_id: stage.stage_id,
    matrix_index: input.task.matrix_index,
    stage_kind: stage.kind,
    permissions: stage.permissions,
    mcp_allowlist: stage.mcp_allowlist,
  }).toString('utf8');
  const envelope: WorkerEnvelopeV1 = {
    store_kind: 'oma_worker_envelope',
    schema_version: 1,
    repository_id: 'OMA',
    run_id: input.context.run_id,
    team_id: input.context.team_id,
    task_id: input.task.task_id,
    task_text: taskText,
    dependencies: input.dependency_results.map((result) => ({
      task_id: result.task_id,
      result_hash: result.result_hash,
      artifact_roots: [...result.artifact_roots],
    })),
    write_scope: [...stage.write_paths],
    verification_argv: stage.verification_argv.map((argv) => [...argv]),
    artifact_contract: {
      proposal_root: proposalRoot,
      required_files: required,
      terminal_receipt_path: `${proposalRoot}/terminal-receipt.json`,
    },
    contributor_guidance_hashes: input.context.contributor_guidance_hashes.map((entry) => ({ ...entry })),
    mailbox_cursor: input.context.mailbox_cursor,
    claim_id: input.context.claim_id,
    generation: input.task.generation,
    state_endpoint: input.context.state_endpoint,
    cancellation_token_hash: input.context.cancellation_token_hash,
    provider: input.context.provider,
    native_role: stage.native_role,
    capability_mode: stage.capability_mode,
    deadline_ms: stage.timeout_ms,
  };
  validateWorkerEnvelope(envelope);
  return {
    stage_id: stage.stage_id,
    task_id: input.task.task_id,
    permissions: [...stage.permissions],
    mcp_allowlist: [...stage.mcp_allowlist],
    envelope,
    envelope_digest: workflowEnvelopeDigest(envelope),
  };
}

export function assertWorkflowEnvelopeMatchesStage(
  bundle: Readonly<WorkflowPermissionBundleV1>,
  stage: Readonly<WorkflowStageV1>,
): void {
  const envelope = validateWorkerEnvelope(bundle.envelope);
  if (bundle.stage_id !== stage.stage_id || bundle.task_id !== envelope.task_id
    || envelope.native_role !== stage.native_role
    || envelope.capability_mode !== stage.capability_mode
    || canonicalBytesV1(envelope.write_scope).compare(canonicalBytesV1(stage.write_paths)) !== 0
    || canonicalBytesV1(envelope.verification_argv).compare(canonicalBytesV1(stage.verification_argv)) !== 0
    || bundle.envelope_digest !== workflowEnvelopeDigest(envelope)) {
    throw new Error('E_WORKFLOW_PERMISSION: worker envelope drifted from stage authority');
  }
  assertMcpAllowlist(bundle.mcp_allowlist);
  if (canonicalBytesV1(bundle.mcp_allowlist).compare(canonicalBytesV1(stage.mcp_allowlist)) !== 0
    || canonicalBytesV1(bundle.permissions).compare(canonicalBytesV1(stage.permissions)) !== 0) {
    throw new Error('E_WORKFLOW_PERMISSION: stage permission bundle drifted');
  }
}

function assertMcpAllowlist(values: readonly string[]): void {
  const allowed = new Set<string>(MCP_OPERATION_NAMES_V1);
  if (new Set(values).size !== values.length || values.some((value) => !allowed.has(value))) {
    throw new Error('E_WORKFLOW_PERMISSION: MCP allowlist contains an unregistered operation');
  }
}

function assertStagePermissions(stage: WorkflowStageV1): void {
  for (const permission of stage.permissions) {
    const mcpName = permission.startsWith('mcp:') ? permission.slice(4) : null;
    if (!SAFE_STAGE_PERMISSIONS_V1.has(permission)
      && (mcpName === null || !stage.mcp_allowlist.includes(mcpName))) {
      throw new Error(`E_WORKFLOW_PERMISSION: unsupported permission ${permission}`);
    }
  }
  if (stage.capability_mode === 'read-only'
    && (stage.permissions.includes('repository:write') || stage.write_paths.length > 0)) {
    throw new Error('E_WORKFLOW_PERMISSION: read-only stage received write authority');
  }
  if (stage.capability_mode === 'read-write' && !stage.permissions.includes('repository:write')) {
    throw new Error('E_WORKFLOW_PERMISSION: read-write stage lacks explicit repository:write');
  }
}

function requiredArtifactNames(stage: WorkflowStageV1): string[] {
  const value = stage.artifact_contract.required;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100
    || value.some((entry) => typeof entry !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(entry)
      || entry === '..' || entry.startsWith('../') || entry.includes('/../'))
    || new Set(value).size !== value.length) {
    throw new Error('E_WORKFLOW_PERMISSION: artifact contract required paths are unsafe');
  }
  return value as string[];
}

export function workflowPermissionDigest(bundle: WorkflowPermissionBundleV1): string {
  return sha256Hex(canonicalBytesV1(bundle));
}
