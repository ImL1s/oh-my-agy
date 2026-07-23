import {
  RepositoryWorkflowV1,
  WorkflowTerminalV1,
  validateRepositoryWorkflow,
  workflowTerminalFromEvidence,
} from '../contracts/repository-workflow';
import { WorkflowPlanV1, WorkflowTaskRuntimeV1 } from './schema';
import { validateWorkflowProductAuthority } from './authority';
import { canonicalBytesV1 } from '../contracts/state-schemas';

export interface WorkflowReviewDecisionV1 {
  terminal: WorkflowTerminalV1;
  evidence: {
    product_authority_available: boolean;
    authority_error: 'E_WORKFLOW_PRODUCT_AUTHORITY_UNAVAILABLE' | null;
    required_stage_failed: boolean;
    required_stage_skipped: boolean;
    permission_denied: boolean;
    ambiguous_receipt: boolean;
    verifier_approved: boolean;
    skeptic_approved: boolean;
    ship_proof_present: boolean;
    external_effect_without_receipt: boolean;
  };
  verifier_task_ids: string[];
  skeptic_task_ids: string[];
  ship_gate_task_ids: string[];
}

export function evaluateWorkflowReview(input: {
  definition: RepositoryWorkflowV1;
  plan: WorkflowPlanV1;
  tasks: Readonly<Record<string, WorkflowTaskRuntimeV1>>;
  authority_state_root?: string;
  repository_root?: string;
}): WorkflowReviewDecisionV1 {
  const definition = validateRepositoryWorkflow(input.definition);
  const verifierTaskIds: string[] = [];
  const skepticTaskIds: string[] = [];
  const shipGateTaskIds: string[] = [];
  let requiredStageFailed = false;
  let requiredStageSkipped = false;
  let permissionDenied = false;
  let ambiguousReceipt = false;
  let externalEffectWithoutReceipt = false;
  let productAuthorityAvailable = true;
  const launchIdentities: string[] = [];
  for (const planned of input.plan.tasks) {
    const stage = definition.stages.find((entry) => entry.stage_id === planned.stage_id)!;
    const runtime = input.tasks[planned.task_id];
    if (runtime === undefined || runtime.receipt === null) {
      if (stage.required) requiredStageSkipped = true;
      continue;
    }
    const receipt = runtime.receipt;
    if (stage.kind === 'verifier') verifierTaskIds.push(planned.task_id);
    if (stage.kind === 'skeptic') skepticTaskIds.push(planned.task_id);
    if (stage.kind === 'ship_gate') shipGateTaskIds.push(planned.task_id);
    if (stage.required && receipt.status === 'failed') requiredStageFailed = true;
    if (stage.required && receipt.status === 'skipped') requiredStageSkipped = true;
    if (receipt.status === 'blocked' || receipt.permission_denied) permissionDenied = true;
    if (receipt.status === 'effect_unknown') externalEffectWithoutReceipt = true;
    if (receipt.result_hash !== null && !/^[a-f0-9]{64}$/.test(receipt.result_hash)) ambiguousReceipt = true;
    if (receipt.external_effect_types.length > receipt.effect_receipt_digests.length) {
      externalEffectWithoutReceipt = true;
    }
    const authority = receipt.product_authority;
    const authorityValid = runtime.envelope_digest !== null
      && validateWorkflowProductAuthority({
        authority,
        definition_digest: definition.definition_digest,
        plan_digest: input.plan.plan_digest,
        envelope_digest: runtime.envelope_digest,
        task_id: planned.task_id,
        stage_id: planned.stage_id,
        stage_kind: stage.kind,
        attempt: runtime.attempts,
        generation: planned.generation,
        authority_state_root: input.authority_state_root,
        repository_root: input.repository_root,
        receipt,
      })
      && authority !== undefined
      && canonicalBytesV1(authority.verifications.map((entry) => entry.argv))
        .equals(canonicalBytesV1(stage.verification_argv))
      && authority.verifications.every((entry) => entry.exit_code === 0);
    if (!authorityValid) productAuthorityAvailable = false;
    if (authority !== undefined) {
      launchIdentities.push(`${authority.launch.pid}:${authority.launch.start_marker}`);
    }
  }
  if (new Set(launchIdentities).size !== input.plan.tasks.length) {
    productAuthorityAvailable = false;
  }
  const approved = (taskIds: readonly string[]): boolean => taskIds.length > 0
    && taskIds.every((taskId) => input.tasks[taskId]?.receipt?.status === 'passed'
      && input.tasks[taskId]?.receipt?.approval === true);
  const shipProofPresent = shipGateTaskIds.length > 0
    && shipGateTaskIds.every((taskId) => input.tasks[taskId]?.receipt?.status === 'passed'
      && /^[a-f0-9]{64}$/.test(input.tasks[taskId]?.receipt?.ship_proof_digest ?? ''));
  const evidence = {
    product_authority_available: productAuthorityAvailable,
    authority_error: productAuthorityAvailable ? null
      : 'E_WORKFLOW_PRODUCT_AUTHORITY_UNAVAILABLE' as const,
    required_stage_failed: requiredStageFailed,
    required_stage_skipped: requiredStageSkipped,
    permission_denied: permissionDenied,
    ambiguous_receipt: ambiguousReceipt,
    verifier_approved: approved(verifierTaskIds),
    skeptic_approved: approved(skepticTaskIds),
    ship_proof_present: shipProofPresent,
    external_effect_without_receipt: externalEffectWithoutReceipt,
  };
  return {
    terminal: workflowTerminalFromEvidence({
      ...evidence,
      ship_proof_present: evidence.ship_proof_present && productAuthorityAvailable,
    }),
    evidence,
    verifier_task_ids: verifierTaskIds,
    skeptic_task_ids: skepticTaskIds,
    ship_gate_task_ids: shipGateTaskIds,
  };
}
