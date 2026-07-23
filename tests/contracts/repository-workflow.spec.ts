import * as fs from 'fs';
import * as path from 'path';
import {
  RepositoryWorkflowV1,
  WORKFLOW_CAPABILITY_TIERS_V1,
  WORKFLOW_TERMINALS_V1,
  assertWorkflowHistory,
  deterministicWorkflowOrder,
  repositoryWorkflowDigest,
  validateRepositoryWorkflow,
  validateWorkflowCapability,
  workflowReplayId,
  workflowTaskId,
  workflowTerminalFromEvidence,
} from '../../src/contracts';

const fixture = (name: string): any => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'workflow', name), 'utf8',
));

function redigest(definition: RepositoryWorkflowV1): RepositoryWorkflowV1 {
  const next = JSON.parse(JSON.stringify(definition)) as RepositoryWorkflowV1;
  next.definition_digest = repositoryWorkflowDigest(next);
  return next;
}

describe('OMA W0 repository-workflow/v1 contract', () => {
  test('production safety review freezes four parallel authors then skeptic, verifier, and ship gate', () => {
    const workflow = fixture('production-safety-review-v1.json') as RepositoryWorkflowV1;
    expect(() => validateRepositoryWorkflow(workflow)).not.toThrow();
    expect(deterministicWorkflowOrder(workflow.stages)).toEqual([
      'secrets-review', 'deployment-gate-review', 'cron-r2-review', 'api-ops-docs-review',
      'skeptic-review', 'independent-verification', 'ship-gate',
    ]);
    expect(workflow.stages.slice(0, 4).every((stage) => stage.depends_on.length === 0)).toBe(true);
    expect(workflow.stages.find((stage) => stage.kind === 'skeptic')?.identity).toBe('independent-skeptic');
    expect(workflow.stages.find((stage) => stage.kind === 'verifier')?.identity).toBe('independent-verifier');
  });

  test('task/replay IDs bind repo, workflow version/digest, input, stage, matrix, and generation', () => {
    const workflow = fixture('production-safety-review-v1.json') as RepositoryWorkflowV1;
    const input = {
      repository_id: 'OMA' as const, workflow_name: workflow.name,
      workflow_version: workflow.workflow_version, definition_digest: workflow.definition_digest,
      input_digest: 'a'.repeat(64), stage_id: 'secrets-review', matrix_index: 0, generation: 1,
    };
    const task = workflowTaskId(input);
    expect(task).toMatch(/^[0-9a-f]{64}$/);
    expect(workflowTaskId(input)).toBe(task);
    expect(workflowTaskId({ ...input, generation: 2 })).not.toBe(task);
    expect(workflowReplayId(input)).not.toBe(task);
  });

  test('cycles, duplicates/stale IDs, unbounded fan-out, identity reuse and missing gates fail', () => {
    const workflow = fixture('production-safety-review-v1.json') as RepositoryWorkflowV1;
    const cycle = JSON.parse(JSON.stringify(workflow)) as RepositoryWorkflowV1;
    cycle.stages[0].depends_on = ['ship-gate'];
    expect(() => validateRepositoryWorkflow(redigest(cycle))).toThrow('cycle');

    const duplicate = JSON.parse(JSON.stringify(workflow)) as RepositoryWorkflowV1;
    duplicate.stages[1].stage_id = duplicate.stages[0].stage_id;
    expect(() => validateRepositoryWorkflow(redigest(duplicate))).toThrow('duplicate');

    const unbounded = { ...workflow, max_agent_count: 33 };
    expect(() => validateRepositoryWorkflow(redigest(unbounded))).toThrow('bounds');

    const reused = JSON.parse(JSON.stringify(workflow)) as RepositoryWorkflowV1;
    (reused.stages.find((stage) => stage.kind === 'verifier') as any).identity = 'secrets-reviewer';
    expect(() => validateRepositoryWorkflow(redigest(reused))).toThrow('independent');

    const noSkeptic = { ...workflow, stages: workflow.stages.filter((stage) => stage.kind !== 'skeptic') };
    expect(() => validateRepositoryWorkflow(redigest(noSkeptic))).toThrow();
  });

  test('read-only defaults, declared paths, argv, nesting and canonical release privilege are fail-closed', () => {
    const workflow = fixture('production-safety-review-v1.json') as RepositoryWorkflowV1;
    const write = JSON.parse(JSON.stringify(workflow)) as RepositoryWorkflowV1;
    write.stages[0].write_paths = ['src/**'];
    expect(() => validateRepositoryWorkflow(redigest(write))).toThrow('Read-only');

    const traversal = JSON.parse(JSON.stringify(workflow)) as RepositoryWorkflowV1;
    traversal.stages[0].capability_mode = 'read-write';
    traversal.stages[0].write_paths = ['../outside'];
    expect(() => validateRepositoryWorkflow(redigest(traversal))).toThrow('escapes');

    const interpolation = JSON.parse(JSON.stringify(workflow)) as RepositoryWorkflowV1;
    interpolation.stages[0].verification_argv = [['sh', '-c', 'echo $(secret)']];
    expect(() => validateRepositoryWorkflow(redigest(interpolation))).toThrow('shell');

    const nested = JSON.parse(JSON.stringify(workflow)) as RepositoryWorkflowV1;
    nested.stages[0].native_role = 'supervisor';
    expect(() => validateRepositoryWorkflow(redigest(nested))).toThrow('Nested');

    const release = JSON.parse(JSON.stringify(workflow)) as RepositoryWorkflowV1;
    release.stages[0].permissions = ['release:publish'];
    expect(() => validateRepositoryWorkflow(redigest(release))).toThrow('release');

    const execute = JSON.parse(JSON.stringify(workflow)) as RepositoryWorkflowV1;
    (execute.stages[0] as any).capability_mode = 'execute';
    expect(() => validateRepositoryWorkflow(redigest(execute))).toThrow();

    const guidance = JSON.parse(JSON.stringify(workflow)) as RepositoryWorkflowV1;
    guidance.stages[0].capability_mode = 'read-write';
    guidance.stages[0].write_paths = ['AGENTS.md'];
    expect(() => validateRepositoryWorkflow(redigest(guidance))).toThrow();

    const bogusPredicate = JSON.parse(JSON.stringify(workflow)) as RepositoryWorkflowV1;
    (bogusPredicate.ship_predicate as any).all_required_passed = false;
    expect(() => validateRepositoryWorkflow(redigest(bogusPredicate))).toThrow();

    const extra = { ...workflow, extra: true } as any;
    expect(() => validateRepositoryWorkflow(redigest(extra))).toThrow('keys');
  });

  test('history is immutable per version and changed fixed stages require reviewed supersedes metadata', () => {
    const workflow = fixture('production-safety-review-v1.json') as RepositoryWorkflowV1;
    expect(() => assertWorkflowHistory(workflow, workflow)).not.toThrow();
    const mutable = redigest({ ...workflow, output_schema: { type: 'string' } });
    expect(() => assertWorkflowHistory(workflow, mutable)).toThrow('Same workflow version');
    const next = redigest({
      ...workflow,
      workflow_version: '1.1.0',
      migration: {
        supersedes_version: workflow.workflow_version,
        supersedes_digest: workflow.definition_digest,
        reviewed_by: 'independent-reviewer',
        review_digest: 'd'.repeat(64),
      },
    });
    expect(() => assertWorkflowHistory(workflow, next)).not.toThrow();
    expect(() => assertWorkflowHistory(workflow, redigest({
      ...next, migration: { ...next.migration, supersedes_digest: null },
    }))).toThrow();
  });

  test('native projections remain evidence-gated and capability tiers/terminals are exact', () => {
    const workflow = fixture('production-safety-review-v1.json') as RepositoryWorkflowV1;
    expect(WORKFLOW_TERMINALS_V1).toEqual([
      'ship', 'no_ship', 'blocked', 'cancelled', 'failed', 'interrupted', 'effect_unknown',
    ]);
    expect(WORKFLOW_CAPABILITY_TIERS_V1).toEqual({
      T0: 'unavailable', T1: 'saved_prompt', T2: 'validated_runner',
      T3: 'durable_journal', T4: 'enforced_gate', T5: 'recoverable_effects',
    });
    expect(workflow.native_projections).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'antigravity_saved_prompt', maximum_claimed_tier: 'T1' }),
      expect.objectContaining({ provider: 'antigravity_native_team', classification: 'optional_unclaimed', maximum_claimed_tier: 'T0' }),
    ]));
    const falseClaim = JSON.parse(JSON.stringify(workflow)) as RepositoryWorkflowV1;
    falseClaim.native_projections[1].maximum_claimed_tier = 'T5';
    expect(() => validateRepositoryWorkflow(redigest(falseClaim))).toThrow('native team');
    expect(() => validateWorkflowCapability({
      provider: 'oma', run_id: 'run', tier: 'T5', configured: true, installed: true, enabled: true,
      loadable: true, observed: true, healthy: true, verified: true, reconciled_effect_types: [],
    })).toThrow('effect');
  });

  test('ship/no-ship/effect_unknown decisions are distinct and fail closed', () => {
    const pass = {
      required_stage_failed: false, required_stage_skipped: false, permission_denied: false,
      ambiguous_receipt: false, verifier_approved: true, skeptic_approved: true,
      ship_proof_present: true, external_effect_without_receipt: false,
    };
    expect(workflowTerminalFromEvidence(pass)).toBe('ship');
    expect(workflowTerminalFromEvidence({ ...pass, skeptic_approved: false })).toBe('no_ship');
    expect(workflowTerminalFromEvidence({ ...pass, permission_denied: true })).toBe('blocked');
    expect(workflowTerminalFromEvidence({ ...pass, external_effect_without_receipt: true }))
      .toBe('effect_unknown');
  });
});
