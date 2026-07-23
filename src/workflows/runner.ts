import * as path from 'path';
import {
  RepositoryWorkflowV1,
  validateRepositoryWorkflow,
} from '../contracts/repository-workflow';
import {
  WorkflowPermissionContextV1,
} from './permissions';
import {
  appendWorkflowJournalEvent,
  initializeWorkflowRun,
  readWorkflowJournal,
  replayWorkflowEvents,
} from './replay';
import {
  WorkflowDispatchAdapterV1,
  WorkflowPlanV1,
  WorkflowRunSnapshotV1,
} from './schema';

export interface ExecuteRepositoryWorkflowInputV1 {
  definition: RepositoryWorkflowV1;
  plan: WorkflowPlanV1;
  journal_path: string;
  adapter: WorkflowDispatchAdapterV1;
  permission_context(taskId: string, attempt: number): WorkflowPermissionContextV1;
}

export const WORKFLOW_PRODUCT_AUTHORITY_ERROR =
  'E_WORKFLOW_PRODUCT_AUTHORITY_UNAVAILABLE' as const;

export async function executeRepositoryWorkflow(
  input: ExecuteRepositoryWorkflowInputV1,
): Promise<WorkflowRunSnapshotV1> {
  const definition = validateRepositoryWorkflow(input.definition);
  if (input.plan.definition_digest !== definition.definition_digest
    || input.plan.workflow_name !== definition.name
    || input.plan.workflow_version !== definition.workflow_version) {
    throw new Error('E_WORKFLOW_RUN: plan does not bind the supplied definition');
  }
  const journalPath = path.resolve(input.journal_path);
  let events = readWorkflowJournal(journalPath);
  if (events.length === 0) {
    appendWorkflowJournalEvent({
      journal_path: journalPath,
      run_id: input.plan.run_id,
      kind: 'run_started',
      task_id: null,
      payload: { plan_digest: input.plan.plan_digest },
    });
    events = readWorkflowJournal(journalPath);
  }
  const snapshot = replayWorkflowEvents(input.plan, events, { allow_reconciliation: true });
  if (snapshot.terminal !== null) return snapshot;

  // The importable runner is permanently advisory. It never calls the supplied
  // adapter or permission callback. Product execution exists only in the
  // non-exported CLI closure in runtime-adapter.ts.
  appendWorkflowJournalEvent({
    journal_path: journalPath,
    run_id: input.plan.run_id,
    kind: 'run_terminal',
    task_id: null,
    payload: {
      terminal: 'no_ship',
      evidence: {
        product_authority_available: false,
        authority_error: WORKFLOW_PRODUCT_AUTHORITY_ERROR,
      },
    },
  });
  return replayWorkflowEvents(input.plan, readWorkflowJournal(journalPath));
}

export function freshWorkflowRun(plan: WorkflowPlanV1): WorkflowRunSnapshotV1 {
  return initializeWorkflowRun(plan);
}
