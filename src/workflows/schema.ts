import { canonicalBytesV1 } from '../contracts/state-schemas';
import {
  RepositoryWorkflowV1,
  WorkflowStageV1,
  WorkflowTerminalV1,
} from '../contracts/repository-workflow';
import { WorkerDependencyResultV1, WorkerEnvelopeV1 } from '../contracts/worker-envelope';
import { sha256Hex } from '../contracts/writer-chain';

export const WORKFLOW_RUN_SCHEMA_V1 = 'oma.repository-workflow-run/v1' as const;
export const WORKFLOW_JOURNAL_SCHEMA_V1 = 'oma.repository-workflow-journal/v1' as const;

export type WorkflowTaskStatusV1 =
  | 'pending'
  | 'dispatched'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'effect_unknown';

export interface WorkflowPlannedTaskV1 {
  task_id: string;
  replay_id: string;
  stage_id: string;
  stage_kind: WorkflowStageV1['kind'];
  stage_identity: string;
  declaration_index: number;
  matrix_index: number;
  generation: number;
  requested_agent_count: number;
  dependency_task_ids: string[];
}

export interface WorkflowPlanV1 {
  store_kind: 'oma_repository_workflow_plan';
  schema_version: 1;
  contract: typeof WORKFLOW_RUN_SCHEMA_V1;
  repository_id: 'OMA';
  run_id: string;
  workflow_name: string;
  workflow_version: string;
  definition_digest: string;
  input_digest: string;
  generation: number;
  stage_order: string[];
  tasks: WorkflowPlannedTaskV1[];
  plan_digest: string;
}

export interface WorkflowTaskReceiptV1 {
  task_id: string;
  attempt: number;
  status: Exclude<WorkflowTaskStatusV1, 'pending' | 'dispatched'>;
  result_hash: string | null;
  artifact_roots: string[];
  approval: boolean | null;
  ship_proof_digest: string | null;
  external_effect_types: string[];
  effect_receipt_digests: string[];
  permission_denied: boolean;
  product_authority?: WorkflowProductAuthorityV1;
}

export interface WorkflowObservedProcessV1 {
  pid: number;
  start_marker: string;
  operation_id: string;
  argv: string[];
  argv_sha256: string;
}

export interface WorkflowProductAuthorityV1 {
  authority_kind: 'oma_product_executor_v1';
  agy_executable_realpath: string;
  agy_executable_sha256: string;
  agy_executable_byte_length: number;
  candidate_oid: string;
  definition_digest: string;
  plan_digest: string;
  envelope_digest: string;
  task_id: string;
  stage_id: string;
  attempt: number;
  generation: number;
  decision_status: 'passed' | 'failed';
  verdict: {
    decision: 'pass' | 'approve' | 'ship' | 'reject' | 'no_ship' | 'failed';
    findings: Array<{
      code: string;
      severity: 'info' | 'warning' | 'error';
      message: string;
    }>;
  };
  result_hash: string | null;
  approval: boolean | null;
  ship_proof_digest: string | null;
  launch: WorkflowObservedProcessV1;
  verifications: Array<WorkflowObservedProcessV1 & {
    exit_code: number;
    stdout_sha256: string;
    stderr_sha256: string;
    stdout_path: string;
    stderr_path: string;
  }>;
  artifacts: Array<{
    path: string;
    byte_length: number;
    sha256: string;
  }>;
  authority_digest: string;
  authority_mac: string;
}
export interface WorkflowTaskRuntimeV1 {
  task: WorkflowPlannedTaskV1;
  status: WorkflowTaskStatusV1;
  attempts: number;
  envelope_digest: string | null;
  receipt: WorkflowTaskReceiptV1 | null;
}

export interface WorkflowRunSnapshotV1 {
  store_kind: 'oma_repository_workflow_run';
  schema_version: 1;
  contract: typeof WORKFLOW_RUN_SCHEMA_V1;
  repository_id: 'OMA';
  run_id: string;
  plan_digest: string;
  revision: number;
  journal_head: string | null;
  tasks: Record<string, WorkflowTaskRuntimeV1>;
  terminal: WorkflowTerminalV1 | null;
  warnings: string[];
}

export type WorkflowJournalEventKindV1 =
  | 'run_started'
  | 'task_dispatched'
  | 'task_requeued'
  | 'task_receipt'
  | 'run_terminal';

export interface WorkflowJournalEventV1 {
  store_kind: 'oma_repository_workflow_event';
  schema_version: 1;
  contract: typeof WORKFLOW_JOURNAL_SCHEMA_V1;
  repository_id: 'OMA';
  run_id: string;
  sequence: number;
  previous_event_hash: string | null;
  kind: WorkflowJournalEventKindV1;
  task_id: string | null;
  payload: Readonly<Record<string, unknown>>;
  event_hash: string;
}

export interface WorkflowPermissionBundleV1 {
  stage_id: string;
  task_id: string;
  permissions: string[];
  mcp_allowlist: string[];
  envelope: WorkerEnvelopeV1;
  envelope_digest: string;
}

export interface WorkflowDispatchInputV1 {
  definition: RepositoryWorkflowV1;
  plan_digest: string;
  stage: WorkflowStageV1;
  task: WorkflowPlannedTaskV1;
  permission: WorkflowPermissionBundleV1;
  dependency_results: WorkerDependencyResultV1[];
  attempt: number;
}

export interface WorkflowDispatchAdapterV1 {
  dispatch(input: Readonly<WorkflowDispatchInputV1>): Promise<WorkflowTaskReceiptV1>;
  reconcile?(input: Readonly<WorkflowDispatchInputV1>): Promise<WorkflowTaskReceiptV1 | null>;
}

export function workflowPlanDigest(
  plan: Omit<WorkflowPlanV1, 'plan_digest'>,
): string {
  return sha256Hex(canonicalBytesV1(plan));
}

export function workflowEnvelopeDigest(envelope: WorkerEnvelopeV1): string {
  return sha256Hex(canonicalBytesV1(envelope));
}

export function workflowJournalEventHash(
  event: Omit<WorkflowJournalEventV1, 'event_hash'>,
): string {
  return sha256Hex(canonicalBytesV1(event));
}

export function createWorkflowJournalEvent(input: {
  run_id: string;
  sequence: number;
  previous_event_hash: string | null;
  kind: WorkflowJournalEventKindV1;
  task_id: string | null;
  payload: Readonly<Record<string, unknown>>;
}): WorkflowJournalEventV1 {
  if (input.run_id.trim() === '' || !Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new Error('E_WORKFLOW_JOURNAL: invalid run identity or sequence');
  }
  if (input.previous_event_hash !== null && !/^[a-f0-9]{64}$/.test(input.previous_event_hash)) {
    throw new Error('E_WORKFLOW_JOURNAL: invalid predecessor hash');
  }
  const material = {
    store_kind: 'oma_repository_workflow_event',
    schema_version: 1,
    contract: WORKFLOW_JOURNAL_SCHEMA_V1,
    repository_id: 'OMA',
    run_id: input.run_id,
    sequence: input.sequence,
    previous_event_hash: input.previous_event_hash,
    kind: input.kind,
    task_id: input.task_id,
    payload: input.payload,
  } as const;
  return { ...material, event_hash: workflowJournalEventHash(material) };
}

export function dependencyResultsFromReceipts(
  task: WorkflowPlannedTaskV1,
  runtime: Readonly<Record<string, WorkflowTaskRuntimeV1>>,
): WorkerDependencyResultV1[] {
  return task.dependency_task_ids.map((dependencyId) => {
    const receipt = runtime[dependencyId]?.receipt;
    if (receipt?.status !== 'passed' || receipt.result_hash === null) {
      throw new Error(`E_WORKFLOW_DEPENDENCY: ${dependencyId} lacks a passing receipt`);
    }
    return {
      task_id: dependencyId,
      result_hash: receipt.result_hash,
      artifact_roots: [...receipt.artifact_roots],
    };
  });
}
