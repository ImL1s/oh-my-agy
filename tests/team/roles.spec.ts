import * as fs from 'fs';
import * as path from 'path';
import {
  ContractViolation,
  RepositoryWorkflowV1,
  repositoryWorkflowDigest,
  validateRepositoryWorkflow,
} from '../../src/contracts';
import { GitFixture } from '../helpers/git-fixture';
import { validateTeamManifest } from '../../src/team/manifest';
import {
  OMA_ROLES_V1,
  OMA_ROLE_NAMES_V1,
  inspectOmaRolePosture,
  isOmaRole,
  unknownOmaRoleMessage,
} from '../../src/team/roles';

const workflowFixture = (): RepositoryWorkflowV1 => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'workflow', 'production-safety-review-v1.json'),
  'utf8',
)) as RepositoryWorkflowV1;

function redigest(definition: RepositoryWorkflowV1): RepositoryWorkflowV1 {
  const next = JSON.parse(JSON.stringify(definition)) as RepositoryWorkflowV1;
  next.definition_digest = repositoryWorkflowDigest(next);
  return next;
}

function capturedWorkflowCode(operation: () => unknown): string {
  let captured: unknown;
  try {
    operation();
  } catch (error: unknown) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(ContractViolation);
  return (captured as ContractViolation).code;
}

function manifest(tasks: unknown[]) {
  return { schema: 'oma.team-manifest/v1', teamId: 'alpha', revision: 1, tasks };
}

function task(id: string, dependencies: string[], writeScope: unknown, extra: Record<string, unknown> = {}) {
  return {
    id,
    dependencies,
    write_scope: writeScope,
    mode: writeScope === 'none' ? 'read_only' : 'headless',
    verification: { version: 1, commands: [], requiredArtifacts: [] },
    ...extra,
  };
}

describe('OMA role capability floors (OMG roles.py posture-from-role)', () => {
  test('frozen map lists issue-named read-only floors and leader-only orchestrator', () => {
    expect(Object.isFrozen(OMA_ROLES_V1)).toBe(true);
    for (const role of ['reviewer', 'critic', 'verifier', 'security-reviewer', 'analyst'] as const) {
      expect(OMA_ROLES_V1[role]).toEqual({
        capabilityFloor: 'read-only',
        writeScopeAllowed: false,
        childAllowed: true,
      });
    }
    expect(OMA_ROLES_V1.orchestrator).toEqual({
      capabilityFloor: 'read-write',
      writeScopeAllowed: true,
      childAllowed: false,
    });
    expect(OMA_ROLES_V1.executor).toEqual({
      capabilityFloor: 'read-write',
      writeScopeAllowed: true,
      childAllowed: true,
    });
    expect([...OMA_ROLE_NAMES_V1]).toEqual([...OMA_ROLE_NAMES_V1].sort((left, right) => left.localeCompare(right, 'en')));
  });

  test('role×posture matrix: read-only floors reject elevation; read-write children may tighten', () => {
    for (const role of OMA_ROLE_NAMES_V1) {
      const policy = OMA_ROLES_V1[role];
      const asChild = true;
      if (!policy.childAllowed) {
        expect(inspectOmaRolePosture({
          role, capabilityMode: 'read-write', writeScopeNone: false, asChild,
        }).ok).toBe(false);
        continue;
      }
      if (policy.capabilityFloor === 'read-only') {
        expect(inspectOmaRolePosture({
          role, capabilityMode: 'read-only', writeScopeNone: true, asChild,
        })).toEqual({ ok: true, role, policy });
        const elevated = inspectOmaRolePosture({
          role, capabilityMode: 'read-write', writeScopeNone: true, asChild,
        });
        expect(elevated.ok).toBe(false);
        if (!elevated.ok) expect(elevated.code).toBe('capability-floor');
        const scoped = inspectOmaRolePosture({
          role, capabilityMode: 'read-only', writeScopeNone: false, asChild,
        });
        expect(scoped.ok).toBe(false);
        if (!scoped.ok) expect(scoped.code).toBe('write-scope');
      } else {
        expect(inspectOmaRolePosture({
          role, capabilityMode: 'read-write', writeScopeNone: false, asChild,
        }).ok).toBe(true);
        expect(inspectOmaRolePosture({
          role, capabilityMode: 'read-only', writeScopeNone: true, asChild,
        }).ok).toBe(true);
      }
    }
  });

  test('unknown role wizard fail-closes and lists the legal role set', () => {
    expect(isOmaRole('wizard')).toBe(false);
    const result = inspectOmaRolePosture({
      role: 'wizard',
      capabilityMode: 'read-only',
      writeScopeNone: true,
      asChild: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unknown-role');
    expect(result.message).toBe(unknownOmaRoleMessage('wizard'));
    for (const role of OMA_ROLE_NAMES_V1) {
      expect(result.message).toContain(role);
    }
  });

  test('native_role verifier + capability_mode read-write is E_WORKFLOW_PERMISSION', () => {
    const workflow = JSON.parse(JSON.stringify(workflowFixture())) as RepositoryWorkflowV1;
    const verifier = workflow.stages.find((stage) => stage.kind === 'verifier');
    expect(verifier).toBeDefined();
    if (verifier === undefined) return;
    verifier.native_role = 'verifier';
    verifier.capability_mode = 'read-write';
    const error = (() => {
      try {
        validateRepositoryWorkflow(redigest(workflow));
        return null;
      } catch (caught: unknown) {
        return caught as ContractViolation;
      }
    })();
    expect(error).toBeInstanceOf(ContractViolation);
    expect(error?.code).toBe('E_WORKFLOW_PERMISSION');
    expect(error?.message).toMatch(/read-only role floor/);
  });

  test('native_role verifier + capability_mode read-only passes', () => {
    const workflow = JSON.parse(JSON.stringify(workflowFixture())) as RepositoryWorkflowV1;
    const verifier = workflow.stages.find((stage) => stage.kind === 'verifier');
    expect(verifier?.native_role).toBe('verifier');
    expect(verifier?.capability_mode).toBe('read-only');
    expect(() => validateRepositoryWorkflow(workflow)).not.toThrow();
  });

  test('unknown workflow native_role lists legal roles and uses E_WORKFLOW_PERMISSION', () => {
    const workflow = JSON.parse(JSON.stringify(workflowFixture())) as RepositoryWorkflowV1;
    workflow.stages[0].native_role = 'wizard' as never;
    expect(capturedWorkflowCode(() => validateRepositoryWorkflow(redigest(workflow))))
      .toBe('E_WORKFLOW_PERMISSION');
    expect(() => validateRepositoryWorkflow(redigest(workflow))).toThrow(unknownOmaRoleMessage('wizard'));
  });

  test('workflow verifier/skeptic identity independence is unchanged', () => {
    const reused = JSON.parse(JSON.stringify(workflowFixture())) as RepositoryWorkflowV1;
    const verifier = reused.stages.find((stage) => stage.kind === 'verifier');
    expect(verifier).toBeDefined();
    if (verifier === undefined) return;
    verifier.identity = 'secrets-reviewer';
    expect(() => validateRepositoryWorkflow(redigest(reused))).toThrow('independent');
  });
});

describe('Team manifest optional role floors', () => {
  let fixture: GitFixture;

  beforeEach(() => { fixture = GitFixture.create(); });
  afterEach(() => fixture.cleanup());

  test('role is optional: existing manifests without role still pass', () => {
    const result = validateTeamManifest(manifest([
      task('implement', [], [{ kind: 'dir', path: 'src' }]),
      task('review', ['implement'], 'none'),
    ]), fixture.repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tasks.every((entry) => entry.role === undefined)).toBe(true);
  });

  test("role critic with a non-none write_scope is E_VALIDATOR_REJECTED", () => {
    const result = validateTeamManifest(manifest([
      task('review', [], [{ kind: 'file', path: 'README.md' }], { role: 'critic', mode: 'read_only' }),
    ]), fixture.repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_VALIDATOR_REJECTED');
    expect(result.error.message).toMatch(/write_scope none/);
  });

  test("role orchestrator on a child task is E_VALIDATOR_REJECTED", () => {
    const result = validateTeamManifest(manifest([
      task('lead', [], [{ kind: 'dir', path: 'src' }], { role: 'orchestrator' }),
    ]), fixture.repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_VALIDATOR_REJECTED');
    expect(result.error.message).toMatch(/leader-only/);
  });

  test('unknown manifest role fail-closes with the legal set', () => {
    const result = validateTeamManifest(manifest([
      task('cast', [], 'none', { role: 'wizard' }),
    ]), fixture.repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_VALIDATOR_REJECTED');
    expect(result.error.message).toBe(unknownOmaRoleMessage('wizard'));
  });

  test('read-only floor role with read_only + none is accepted', () => {
    const result = validateTeamManifest(manifest([
      task('review', [], 'none', { role: 'verifier' }),
    ]), fixture.repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tasks[0].role).toBe('verifier');
  });
});
