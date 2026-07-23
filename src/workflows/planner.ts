import {
  RepositoryWorkflowV1,
  deterministicWorkflowOrder,
  validateRepositoryWorkflow,
  workflowReplayId,
  workflowTaskId,
} from '../contracts/repository-workflow';
import {
  WorkflowPlanV1,
  WorkflowPlannedTaskV1,
  WorkflowTaskRuntimeV1,
  workflowPlanDigest,
} from './schema';

export function planRepositoryWorkflow(input: {
  definition: RepositoryWorkflowV1;
  run_id: string;
  input_digest: string;
  generation: number;
}): WorkflowPlanV1 {
  const definition = validateRepositoryWorkflow(input.definition);
  if (input.run_id.trim() === '' || !/^[a-f0-9]{64}$/.test(input.input_digest)
    || !Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error('E_WORKFLOW_PLAN: invalid run/input/generation identity');
  }
  const stageOrder = deterministicWorkflowOrder(definition.stages);
  const tasks: WorkflowPlannedTaskV1[] = [];
  const byStage = new Map<string, WorkflowPlannedTaskV1[]>();
  for (const stageId of stageOrder) {
    const stage = definition.stages.find((entry) => entry.stage_id === stageId)!;
    const dependencies = stage.depends_on.flatMap((dependency) => byStage.get(dependency) ?? []);
    const stageTasks: WorkflowPlannedTaskV1[] = [];
    for (let matrixIndex = 0; matrixIndex < stage.matrix_count; matrixIndex += 1) {
      const identity = {
        repository_id: 'OMA' as const,
        workflow_name: definition.name,
        workflow_version: definition.workflow_version,
        definition_digest: definition.definition_digest,
        input_digest: input.input_digest,
        stage_id: stage.stage_id,
        matrix_index: matrixIndex,
        generation: input.generation,
      };
      stageTasks.push({
        task_id: workflowTaskId(identity),
        replay_id: workflowReplayId(identity),
        stage_id: stage.stage_id,
        stage_kind: stage.kind,
        stage_identity: stage.identity,
        declaration_index: stage.declaration_index,
        matrix_index: matrixIndex,
        generation: input.generation,
        requested_agent_count: stage.agent_count,
        dependency_task_ids: dependencies.map((dependency) => dependency.task_id),
      });
    }
    byStage.set(stage.stage_id, stageTasks);
    tasks.push(...stageTasks);
  }
  const material = {
    store_kind: 'oma_repository_workflow_plan',
    schema_version: 1,
    contract: 'oma.repository-workflow-run/v1',
    repository_id: 'OMA',
    run_id: input.run_id,
    workflow_name: definition.name,
    workflow_version: definition.workflow_version,
    definition_digest: definition.definition_digest,
    input_digest: input.input_digest,
    generation: input.generation,
    stage_order: stageOrder,
    tasks,
  } as const;
  return { ...material, plan_digest: workflowPlanDigest(material) };
}

export function readyWorkflowTasks(
  plan: Readonly<WorkflowPlanV1>,
  runtime: Readonly<Record<string, WorkflowTaskRuntimeV1>>,
): WorkflowPlannedTaskV1[] {
  return plan.tasks.filter((task) => {
    const state = runtime[task.task_id];
    return state?.status === 'pending'
      && task.dependency_task_ids.every((dependency) => runtime[dependency]?.status === 'passed');
  }).sort((left, right) => left.declaration_index - right.declaration_index
    || left.matrix_index - right.matrix_index
    || compareUtf8(left.task_id, right.task_id));
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
