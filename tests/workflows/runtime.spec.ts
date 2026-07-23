import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RepositoryWorkflowV1,
  repositoryWorkflowDigest,
} from '../../src/contracts/repository-workflow';
import { sha256 } from '../../src/runtime/atomic';
import { canonicalBytesV1 } from '../../src/contracts/state-schemas';
import {
  ANTIGRAVITY_WORKFLOW_SURFACES_V1,
  assertAntigravitySavedWorkflowIsThin,
  renderAntigravitySavedWorkflow,
} from '../../src/workflows/antigravity-adapter';
import { compileWorkflowPermissions } from '../../src/workflows/permissions';
import { planRepositoryWorkflow, readyWorkflowTasks } from '../../src/workflows/planner';
import {
  RepositoryWorkflowRegistryV1,
  loadWorkflowRegistryFromDirectory,
} from '../../src/workflows/registry';
import {
  appendWorkflowJournalEvent,
  readWorkflowJournal,
  replayWorkflowEvents,
} from '../../src/workflows/replay';
import { evaluateWorkflowReview } from '../../src/workflows/review';
import { workflowVerdictOutputSchema } from '../../src/workflows/authority';
import { executeRepositoryWorkflow } from '../../src/workflows/runner';
import { WorkflowTaskReceiptV1 } from '../../src/workflows/schema';

const fixturePath = path.resolve(__dirname, '..', 'fixtures', 'workflow', 'production-safety-review-v1.json');
const fixture = (): RepositoryWorkflowV1 => JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as RepositoryWorkflowV1;

function plan(definition = fixture()) {
  return planRepositoryWorkflow({
    definition, run_id: 'workflow-run', input_digest: sha256('input'), generation: 1,
  });
}

function permissionContext(taskId: string, attempt: number) {
  return {
    run_id: 'workflow-run', team_id: 'workflow-team', claim_id: `${taskId}:${attempt}`,
    state_endpoint: '.agy/state/workflows/workflow-run', cancellation_token_hash: sha256('cancel'),
    provider: 'agy_headless' as const, mailbox_cursor: 0, contributor_guidance_hashes: [],
  };
}

describe('repository-workflow/v1 planner, permissions, replay, and review runner', () => {
  test('planner expands the deterministic DAG into stable task and dependency identities', () => {
    const workflowPlan = plan();
    expect(workflowPlan.stage_order).toEqual([
      'secrets-review', 'deployment-gate-review', 'cron-r2-review', 'api-ops-docs-review',
      'skeptic-review', 'independent-verification', 'ship-gate',
    ]);
    expect(workflowPlan.tasks).toHaveLength(7);
    expect(workflowPlan.tasks.every((task) => /^[a-f0-9]{64}$/.test(task.task_id))).toBe(true);
    const initial = Object.fromEntries(workflowPlan.tasks.map((task) => [task.task_id, {
      task, status: 'pending' as const, attempts: 0, envelope_digest: null, receipt: null,
    }]));
    expect(readyWorkflowTasks(workflowPlan, initial).map((task) => task.stage_id)).toEqual([
      'secrets-review', 'deployment-gate-review', 'cron-r2-review', 'api-ops-docs-review',
    ]);
    expect(plan()).toEqual(workflowPlan);
    expect(fixture().stages.every((stage) => canonicalBytesV1(stage.output_schema)
      .equals(canonicalBytesV1(workflowVerdictOutputSchema(stage.kind))))).toBe(true);
  });

  test('permission compilation yields the authoritative frozen worker envelope and exact six-MCP allowlist', () => {
    const definition = fixture();
    const workflowPlan = plan(definition);
    const task = workflowPlan.tasks[0];
    const stage = definition.stages[0];
    const bundle = compileWorkflowPermissions({
      definition, stage, task, dependency_results: [], context: permissionContext(task.task_id, 1),
    });
    expect(bundle.envelope).toEqual(expect.objectContaining({
      store_kind: 'oma_worker_envelope', repository_id: 'OMA', task_id: task.task_id,
      capability_mode: 'read-only', write_scope: [], native_role: 'security-reviewer',
    }));
    expect(bundle.envelope.artifact_contract.proposal_root).toContain(task.task_id);
    expect(bundle.envelope_digest).toMatch(/^[a-f0-9]{64}$/);

    const unregistered = redigest(definition, (copy) => {
      copy.stages[0].mcp_allowlist = ['semantic_lsp.read'];
    });
    expect(() => compileWorkflowPermissions({
      definition: unregistered, stage: unregistered.stages[0], task: plan(unregistered).tasks[0],
      dependency_results: [], context: permissionContext(task.task_id, 1),
    })).toThrow('unregistered');
  });

  test('missing product authority executes zero commands and self-asserted proof cannot ship', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-ship-'));
    try {
      const definition = fixture();
      const workflowPlan = plan(definition);
      const calls: string[][] = [];
      const result = await executeRepositoryWorkflow({
        definition, plan: workflowPlan, journal_path: path.join(root, 'journal.jsonl'),
        permission_context: permissionContext,
        adapter: {
          async dispatch(input) {
            calls.push([input.stage.stage_id, ...input.task.dependency_task_ids]);
            return passingReceipt(input.task.task_id, input.attempt, input.stage.kind);
          },
        },
      });
      expect(result.terminal).toBe('no_ship');
      expect(calls).toEqual([]);
      const events = readWorkflowJournal(path.join(root, 'journal.jsonl'));
      expect(events[0].kind).toBe('run_started');
      expect(events.at(-1)).toEqual(expect.objectContaining({ kind: 'run_terminal' }));
      expect(replayWorkflowEvents(workflowPlan, events)).toEqual(result);
      const resumed = await executeRepositoryWorkflow({
        definition, plan: workflowPlan, journal_path: path.join(root, 'journal.jsonl'),
        permission_context: permissionContext,
        adapter: { async dispatch() { throw new Error('terminal run must not dispatch'); } },
      });
      expect(resumed).toEqual(result);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('reading the real disk key and forging the former structural marker still dispatches zero tasks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-forged-marker-'));
    const previous = process.env.OMA_STATE_ROOT;
    try {
      const stateRoot = path.join(root, 'state');
      const trustRoot = path.join(stateRoot, 'trust');
      fs.mkdirSync(trustRoot, { recursive: true, mode: 0o700 });
      fs.chmodSync(stateRoot, 0o700);
      fs.chmodSync(trustRoot, 0o700);
      const key = crypto.randomBytes(32);
      fs.writeFileSync(path.join(trustRoot, 'workflow-v1.key'), key, { mode: 0o600 });
      process.env.OMA_STATE_ROOT = stateRoot;
      const repositoryRoot = fs.realpathSync(process.cwd());
      const material = {
        binding_kind: 'oma_product_adapter_v1',
        state_root: fs.realpathSync(stateRoot),
        repository_root: repositoryRoot,
        nonce: crypto.randomBytes(32).toString('hex'),
      };
      const calls: string[] = [];
      const forged = {
        async dispatch(input: { task: { task_id: string } }) {
          calls.push(input.task.task_id);
          throw new Error('generic runner must never dispatch');
        },
        __oma_product_authority_binding_v1: {
          ...material,
          binding_mac: crypto.createHmac('sha256', fs.readFileSync(
            path.join(trustRoot, 'workflow-v1.key'),
          )).update(canonicalBytesV1(material)).digest('hex'),
        },
      };
      const definition = fixture();
      const workflowPlan = plan(definition);
      const result = await executeRepositoryWorkflow({
        definition,
        plan: workflowPlan,
        journal_path: path.join(root, 'journal.jsonl'),
        permission_context: permissionContext,
        adapter: forged,
      });
      expect(result.terminal).toBe('no_ship');
      expect(calls).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.OMA_STATE_ROOT;
      else process.env.OMA_STATE_ROOT = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('empty artifacts and caller-minted approvals/digests remain no-ship', () => {
    const definition = fixture();
    const workflowPlan = plan(definition);
    const tasks = Object.fromEntries(workflowPlan.tasks.map((task) => [task.task_id, {
      task,
      status: 'passed' as const,
      attempts: 1,
      envelope_digest: sha256('reused-provider-session-agent-identity'),
      receipt: {
        ...passingReceipt(task.task_id, 1, task.stage_kind),
        artifact_roots: [],
      },
    }]));
    const decision = evaluateWorkflowReview({ definition, plan: workflowPlan, tasks });
    expect(decision.terminal).toBe('no_ship');
    expect(decision.evidence).toMatchObject({
      product_authority_available: false,
      authority_error: 'E_WORKFLOW_PRODUCT_AUTHORITY_UNAVAILABLE',
      verifier_approved: true,
      skeptic_approved: true,
      ship_proof_present: true,
    });
  });

  test('skeptic rejection is no_ship and never translated to success', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-noship-'));
    try {
      const definition = fixture();
      const workflowPlan = plan(definition);
      const result = await executeRepositoryWorkflow({
        definition, plan: workflowPlan, journal_path: path.join(root, 'journal.jsonl'),
        permission_context: permissionContext,
        adapter: {
          async dispatch(input) {
            const receipt = passingReceipt(input.task.task_id, input.attempt, input.stage.kind);
            if (input.stage.kind === 'skeptic') receipt.approval = false;
            return receipt;
          },
        },
      });
      expect(result.terminal).toBe('no_ship');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('unreceipted external effects and corrupt replay both fail closed as effect_unknown', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-effect-'));
    try {
      const definition = redigest(fixture(), (copy) => {
        copy.stages[0].external_effect_types = ['deployment'];
      });
      const workflowPlan = plan(definition);
      const journalPath = path.join(root, 'journal.jsonl');
      const result = await executeRepositoryWorkflow({
        definition, plan: workflowPlan, journal_path: journalPath, permission_context: permissionContext,
        adapter: {
          async dispatch(input) {
            const receipt = passingReceipt(input.task.task_id, input.attempt, input.stage.kind);
            receipt.external_effect_types = [...input.stage.external_effect_types];
            return receipt;
          },
        },
      });
      expect(result.terminal).toBe('no_ship');

      const corrupt = readWorkflowJournal(journalPath).map((event) => ({ ...event }));
      corrupt[0] = { ...corrupt[0], payload: { plan_digest: 'f'.repeat(64) } };
      const replayed = replayWorkflowEvents(workflowPlan, corrupt);
      expect(replayed.terminal).toBe('effect_unknown');
      expect(replayed.warnings[0]).toContain('CORRUPT');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('a dangling effect dispatch is effect_unknown unless a runner reconciles it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-dangling-'));
    try {
      const definition = redigest(fixture(), (copy) => {
        copy.stages[0].external_effect_types = ['deployment'];
      });
      const workflowPlan = plan(definition);
      const journalPath = path.join(root, 'journal.jsonl');
      appendWorkflowJournalEvent({
        journal_path: journalPath, run_id: workflowPlan.run_id, kind: 'run_started', task_id: null,
        payload: { plan_digest: workflowPlan.plan_digest },
      });
      appendWorkflowJournalEvent({
        journal_path: journalPath, run_id: workflowPlan.run_id, kind: 'task_dispatched',
        task_id: workflowPlan.tasks[0].task_id,
        payload: { attempt: 1, envelope_digest: sha256('envelope'), external_effect_types: ['deployment'] },
      });
      expect(replayWorkflowEvents(workflowPlan, readWorkflowJournal(journalPath)).terminal)
        .toBe('effect_unknown');
      expect(replayWorkflowEvents(
        workflowPlan, readWorkflowJournal(journalPath), { allow_reconciliation: true },
      ).terminal).toBeNull();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('an interrupted no-effect dispatch is safely requeued within its retry budget', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-requeue-'));
    try {
      const definition = fixture();
      const workflowPlan = plan(definition);
      const journalPath = path.join(root, 'journal.jsonl');
      appendWorkflowJournalEvent({
        journal_path: journalPath, run_id: workflowPlan.run_id, kind: 'run_started', task_id: null,
        payload: { plan_digest: workflowPlan.plan_digest },
      });
      appendWorkflowJournalEvent({
        journal_path: journalPath, run_id: workflowPlan.run_id, kind: 'task_dispatched',
        task_id: workflowPlan.tasks[0].task_id,
        payload: { attempt: 1, envelope_digest: sha256('envelope'), external_effect_types: [] },
      });
      const attempts: number[] = [];
      const result = await executeRepositoryWorkflow({
        definition, plan: workflowPlan, journal_path: journalPath, permission_context: permissionContext,
        adapter: {
          async dispatch(input) {
            if (input.task.task_id === workflowPlan.tasks[0].task_id) attempts.push(input.attempt);
            return passingReceipt(input.task.task_id, input.attempt, input.stage.kind);
          },
        },
      });
      expect(result.terminal).toBe('no_ship');
      expect(attempts).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('a caller-minted terminal ship event is rejected as corrupt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-forged-ship-'));
    try {
      const workflowPlan = plan();
      const journalPath = path.join(root, 'journal.jsonl');
      appendWorkflowJournalEvent({
        journal_path: journalPath,
        run_id: workflowPlan.run_id,
        kind: 'run_started',
        task_id: null,
        payload: { plan_digest: workflowPlan.plan_digest },
      });
      appendWorkflowJournalEvent({
        journal_path: journalPath,
        run_id: workflowPlan.run_id,
        kind: 'run_terminal',
        task_id: null,
        payload: {
          terminal: 'ship',
          evidence: {
            verifier_approved: true,
            skeptic_approved: true,
            ship_proof_present: true,
          },
        },
      });
      const replayed = replayWorkflowEvents(workflowPlan, readWorkflowJournal(journalPath));
      expect(replayed.terminal).toBe('effect_unknown');
      expect(replayed.warnings).toEqual([
        expect.stringContaining('E_WORKFLOW_JOURNAL_CORRUPT'),
      ]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('registry is immutable by version and directory loading is deterministic', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-registry-'));
    try {
      fs.writeFileSync(path.join(root, 'b.json'), JSON.stringify(fixture()));
      const registry = loadWorkflowRegistryFromDirectory(root);
      expect(registry.list()[0]).toEqual(expect.objectContaining({ name: 'production-safety-review' }));
      const direct = new RepositoryWorkflowRegistryV1();
      direct.register(fixture());
      const changed = { ...fixture(), output_schema: { type: 'string' } } as RepositoryWorkflowV1;
      changed.definition_digest = repositoryWorkflowDigest(changed);
      expect(() => direct.register(changed)).toThrow('Same workflow version');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('Antigravity projection is a generated T1 CLI delegate and all unproved native surfaces stay T0', () => {
    const definition = fixture();
    const rendered = renderAntigravitySavedWorkflow(definition);
    expect(() => assertAntigravitySavedWorkflowIsThin(rendered, definition.name)).not.toThrow();
    expect(fs.readFileSync(path.resolve('.agents/workflows/production-safety-review.md'), 'utf8')).toBe(rendered);
    expect(ANTIGRAVITY_WORKFLOW_SURFACES_V1.filter((surface) => surface.surface !== 'saved_workflow_prompt'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ surface: 'native_team', classification: 'optional_unclaimed', maximum_claimed_tier: 'T0' }),
        expect.objectContaining({ surface: 'semantic_lsp', classification: 'optional_unclaimed', maximum_claimed_tier: 'T0' }),
        expect.objectContaining({ surface: 'private_memory_sidecar', classification: 'optional_unclaimed', maximum_claimed_tier: 'T0' }),
      ]));
  });
});

function passingReceipt(
  taskId: string,
  attempt: number,
  kind: RepositoryWorkflowV1['stages'][number]['kind'],
): WorkflowTaskReceiptV1 {
  return {
    task_id: taskId,
    attempt,
    status: 'passed',
    result_hash: sha256(`${taskId}:result`),
    artifact_roots: [`.agy/artifacts/workflows/${taskId}`],
    approval: kind === 'skeptic' || kind === 'verifier' ? true : null,
    ship_proof_digest: kind === 'ship_gate' ? sha256(`${taskId}:ship-proof`) : null,
    external_effect_types: [],
    effect_receipt_digests: [],
    permission_denied: false,
  };
}

function redigest(
  definition: RepositoryWorkflowV1,
  mutate: (copy: RepositoryWorkflowV1) => void,
): RepositoryWorkflowV1 {
  const copy = JSON.parse(JSON.stringify(definition)) as RepositoryWorkflowV1;
  mutate(copy);
  copy.definition_digest = repositoryWorkflowDigest(copy);
  return copy;
}
