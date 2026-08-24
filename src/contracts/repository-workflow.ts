import {
  canonicalBytesV1,
  ContractViolation,
  assertExactObjectKeys,
  assertNonEmptyString,
  assertSafeArgvVector,
  assertSafeRepositoryWritePath,
  assertSha256,
  assertStringArray,
} from './state-schemas';
import { sha256Hex } from './writer-chain';
import { inspectOmaRolePosture, type OmaRoleV1 } from '../team/roles';

export const REPOSITORY_WORKFLOW_CONTRACT_V1 = 'repository-workflow/v1' as const;

export const WORKFLOW_TERMINALS_V1 = [
  'ship',
  'no_ship',
  'blocked',
  'cancelled',
  'failed',
  'interrupted',
  'effect_unknown',
] as const;

export type WorkflowTerminalV1 = typeof WORKFLOW_TERMINALS_V1[number];

export const WORKFLOW_CAPABILITY_TIERS_V1 = Object.freeze({
  T0: 'unavailable',
  T1: 'saved_prompt',
  T2: 'validated_runner',
  T3: 'durable_journal',
  T4: 'enforced_gate',
  T5: 'recoverable_effects',
});

export type WorkflowCapabilityTierV1 = keyof typeof WORKFLOW_CAPABILITY_TIERS_V1;

export const WORKFLOW_STAGE_KINDS_V1 = [
  'author',
  'check',
  'verifier',
  'skeptic',
  'ship_gate',
] as const;

export type WorkflowStageKindV1 = typeof WORKFLOW_STAGE_KINDS_V1[number];

export interface WorkflowStageV1 {
  stage_id: string;
  declaration_index: number;
  kind: WorkflowStageKindV1;
  identity: string;
  depends_on: string[];
  matrix_count: number;
  agent_count: number;
  max_parallel: number;
  native_role: OmaRoleV1;
  capability_mode: 'read-only' | 'read-write';
  mcp_allowlist: string[];
  write_paths: string[];
  output_schema: Readonly<Record<string, unknown>>;
  verification_argv: string[][];
  timeout_ms: number;
  retry_budget: number;
  artifact_contract: Readonly<Record<string, unknown>>;
  permissions: string[];
  external_effect_types: string[];
  required: boolean;
}

export interface RepositoryWorkflowV1 {
  store_kind: 'repository_workflow_definition';
  schema_version: 1;
  contract: typeof REPOSITORY_WORKFLOW_CONTRACT_V1;
  repository_id: 'OMA';
  name: string;
  workflow_version: string;
  definition_digest: string;
  input_schema: Readonly<Record<string, unknown>>;
  stages: WorkflowStageV1[];
  max_agent_count: number;
  max_parallel: number;
  output_schema: Readonly<Record<string, unknown>>;
  ship_predicate: Readonly<Record<string, unknown>>;
  migration: {
    supersedes_version: string | null;
    supersedes_digest: string | null;
    reviewed_by: string;
    review_digest: string;
  };
  native_projections: Array<{
    provider: 'antigravity_saved_prompt' | 'antigravity_native_team';
    classification: 'faithful' | 'optional_unclaimed';
    maximum_claimed_tier: WorkflowCapabilityTierV1;
    fresh_observation_required: true;
  }>;
}

export interface WorkflowTaskIdentityInputV1 {
  repository_id: 'OMA';
  workflow_name: string;
  workflow_version: string;
  definition_digest: string;
  input_digest: string;
  stage_id: string;
  matrix_index: number;
  generation: number;
}

export interface WorkflowCapabilityRecordV1 {
  provider: string;
  run_id: string;
  tier: WorkflowCapabilityTierV1;
  configured: boolean;
  installed: boolean;
  enabled: boolean;
  loadable: boolean;
  observed: boolean;
  healthy: boolean;
  verified: boolean;
  reconciled_effect_types: string[];
}

export const MAX_WORKFLOW_AGENT_COUNT_V1 = 32;
export const MAX_WORKFLOW_PARALLELISM_V1 = 16;
export const MAX_WORKFLOW_MATRIX_COUNT_V1 = 64;
export const MAX_WORKFLOW_TIMEOUT_MS_V1 = 86_400_000;
export const MAX_WORKFLOW_RETRY_BUDGET_V1 = 5;

const WORKFLOW_DEFINITION_KEYS = [
  'store_kind', 'schema_version', 'contract', 'repository_id', 'name', 'workflow_version',
  'definition_digest', 'input_schema', 'stages', 'max_agent_count', 'max_parallel',
  'output_schema', 'ship_predicate', 'migration', 'native_projections',
] as const;

const WORKFLOW_STAGE_KEYS = [
  'stage_id', 'declaration_index', 'kind', 'identity', 'depends_on', 'matrix_count',
  'agent_count', 'max_parallel', 'native_role', 'capability_mode', 'mcp_allowlist',
  'write_paths', 'output_schema', 'verification_argv', 'timeout_ms', 'retry_budget',
  'artifact_contract', 'permissions', 'external_effect_types', 'required',
] as const;

const WORKFLOW_MIGRATION_KEYS = [
  'supersedes_version', 'supersedes_digest', 'reviewed_by', 'review_digest',
] as const;

const WORKFLOW_PROJECTION_KEYS = [
  'provider', 'classification', 'maximum_claimed_tier', 'fresh_observation_required',
] as const;

export const WORKFLOW_SHIP_PREDICATE_KEYS_V1 = [
  'all_required_passed', 'verifier_approved', 'skeptic_approved',
] as const;

function definitionMaterial(definition: RepositoryWorkflowV1): Record<string, unknown> {
  const { definition_digest: ignored, ...material } = definition;
  void ignored;
  return material;
}

export function repositoryWorkflowDigest(definition: RepositoryWorkflowV1): string {
  return sha256Hex(canonicalBytesV1(definitionMaterial(definition)));
}

function assertSemanticVersion(value: string): void {
  if (typeof value !== 'string'
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new ContractViolation('E_WORKFLOW_VERSION', 'workflow_version must be semantic version syntax');
  }
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new ContractViolation('E_WORKFLOW_SCHEMA', `${label} must be a plain object`);
  }
}

function stageOrder(left: WorkflowStageV1, right: WorkflowStageV1): number {
  return left.declaration_index - right.declaration_index
    || left.stage_id.localeCompare(right.stage_id, 'en');
}

export function deterministicWorkflowOrder(stages: readonly WorkflowStageV1[]): string[] {
  const byId = new Map(stages.map((stage) => [stage.stage_id, stage]));
  const indegree = new Map(stages.map((stage) => [stage.stage_id, stage.depends_on.length]));
  const dependents = new Map<string, string[]>();
  for (const stage of stages) {
    for (const dependency of stage.depends_on) {
      const current = dependents.get(dependency) ?? [];
      current.push(stage.stage_id);
      dependents.set(dependency, current);
    }
  }
  const ready = stages.filter((stage) => indegree.get(stage.stage_id) === 0).sort(stageOrder);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const stage = ready.shift() as WorkflowStageV1;
    ordered.push(stage.stage_id);
    for (const child of dependents.get(stage.stage_id) ?? []) {
      const next = (indegree.get(child) as number) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(byId.get(child) as WorkflowStageV1);
        ready.sort(stageOrder);
      }
    }
  }
  if (ordered.length !== stages.length) {
    throw new ContractViolation('E_WORKFLOW_CYCLE', 'Workflow dependency graph contains a cycle');
  }
  return ordered;
}

export function validateRepositoryWorkflow(definition: RepositoryWorkflowV1): RepositoryWorkflowV1 {
  assertPlainObject(definition, 'workflow definition');
  assertExactObjectKeys(
    definition as unknown as Record<string, unknown>,
    WORKFLOW_DEFINITION_KEYS,
    'workflow definition',
  );
  if (definition.store_kind !== 'repository_workflow_definition' || definition.schema_version !== 1
    || definition.contract !== REPOSITORY_WORKFLOW_CONTRACT_V1 || definition.repository_id !== 'OMA') {
    throw new ContractViolation('E_WORKFLOW_SCHEMA', 'Repository workflow schema identity is invalid');
  }
  if (typeof definition.name !== 'string'
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(definition.name)) {
    throw new ContractViolation('E_WORKFLOW_SCHEMA', 'Workflow name must be canonical kebab-case');
  }
  assertSemanticVersion(definition.workflow_version);
  assertSha256(definition.definition_digest, 'definition_digest');
  if (definition.definition_digest !== repositoryWorkflowDigest(definition)) {
    throw new ContractViolation('E_WORKFLOW_DIGEST', 'Workflow definition digest does not match immutable bytes');
  }
  if (!Number.isInteger(definition.max_agent_count) || definition.max_agent_count <= 0
    || definition.max_agent_count > MAX_WORKFLOW_AGENT_COUNT_V1
    || !Number.isInteger(definition.max_parallel) || definition.max_parallel <= 0
    || definition.max_parallel > MAX_WORKFLOW_PARALLELISM_V1
    || definition.max_parallel > definition.max_agent_count) {
    throw new ContractViolation('E_WORKFLOW_BOUNDS', 'Workflow global agent/parallel bounds are invalid');
  }
  if (!Array.isArray(definition.stages) || definition.stages.length === 0) {
    throw new ContractViolation('E_WORKFLOW_SCHEMA', 'Workflow must contain fixed stages');
  }
  assertPlainObject(definition.input_schema, 'input_schema');
  assertPlainObject(definition.output_schema, 'output_schema');
  assertPlainObject(definition.ship_predicate, 'ship_predicate');
  assertExactObjectKeys(
    definition.ship_predicate,
    WORKFLOW_SHIP_PREDICATE_KEYS_V1,
    'ship predicate',
  );
  if (WORKFLOW_SHIP_PREDICATE_KEYS_V1.some((key) => definition.ship_predicate[key] !== true)) {
    throw new ContractViolation('E_WORKFLOW_REVIEW', 'Ship predicate must require all gates explicitly');
  }
  assertPlainObject(definition.migration, 'migration');
  assertExactObjectKeys(
    definition.migration as unknown as Record<string, unknown>,
    WORKFLOW_MIGRATION_KEYS,
    'workflow migration',
  );
  if (!Array.isArray(definition.native_projections)) {
    throw new ContractViolation('E_WORKFLOW_SCHEMA', 'native_projections must be an array');
  }
  const ids = new Set<string>();
  const indices = new Set<number>();
  let totalAgents = 0;
  const authorIdentities = new Set<string>();
  const verifierIdentities = new Set<string>();
  const skepticIdentities = new Set<string>();
  let shipGateCount = 0;
  for (const stage of definition.stages) {
    assertPlainObject(stage, 'workflow stage');
    assertExactObjectKeys(
      stage as unknown as Record<string, unknown>,
      WORKFLOW_STAGE_KEYS,
      'workflow stage',
    );
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(stage.stage_id)
      || ids.has(stage.stage_id)) {
      throw new ContractViolation('E_WORKFLOW_STAGE', 'Workflow stage ID is duplicate or stale');
    }
    ids.add(stage.stage_id);
    if (!Number.isInteger(stage.declaration_index) || stage.declaration_index < 0
      || indices.has(stage.declaration_index)) {
      throw new ContractViolation('E_WORKFLOW_STAGE', 'Stage declaration index is duplicate or invalid');
    }
    indices.add(stage.declaration_index);
    if (!WORKFLOW_STAGE_KINDS_V1.includes(stage.kind)) {
      throw new ContractViolation('E_WORKFLOW_STAGE', 'Unsupported stage kind');
    }
    assertNonEmptyString(stage.identity, 'stage.identity');
    assertNonEmptyString(stage.native_role, 'stage.native_role');
    if (!['read-only', 'read-write'].includes(stage.capability_mode)) {
      throw new ContractViolation('E_WORKFLOW_PERMISSION', 'Unsupported workflow capability mode');
    }
    for (const [label, values] of [
      ['depends_on', stage.depends_on],
      ['mcp_allowlist', stage.mcp_allowlist],
      ['write_paths', stage.write_paths],
      ['permissions', stage.permissions],
      ['external_effect_types', stage.external_effect_types],
    ] as const) assertStringArray(values, `stage.${label}`, { nonEmptyValues: true, unique: true });
    if (!Array.isArray(stage.verification_argv)) {
      throw new ContractViolation('E_WORKFLOW_SYNTAX', 'verification_argv must be an array');
    }
    assertPlainObject(stage.output_schema, 'stage.output_schema');
    assertPlainObject(stage.artifact_contract, 'stage.artifact_contract');
    if (typeof stage.required !== 'boolean') {
      throw new ContractViolation('E_WORKFLOW_STAGE', 'Stage required flag must be boolean');
    }
    if (!Number.isInteger(stage.agent_count) || stage.agent_count <= 0
      || !Number.isInteger(stage.max_parallel) || stage.max_parallel <= 0
      || stage.max_parallel > stage.agent_count
      || !Number.isInteger(stage.matrix_count) || stage.matrix_count <= 0
      || stage.matrix_count > MAX_WORKFLOW_MATRIX_COUNT_V1
      || stage.max_parallel > definition.max_parallel) {
      throw new ContractViolation('E_WORKFLOW_BOUNDS', 'Stage fan-out is invalid or unbounded');
    }
    totalAgents += stage.agent_count * stage.matrix_count;
    if (!Number.isInteger(stage.timeout_ms) || stage.timeout_ms <= 0
      || stage.timeout_ms > MAX_WORKFLOW_TIMEOUT_MS_V1
      || !Number.isInteger(stage.retry_budget) || stage.retry_budget < 0
      || stage.retry_budget > MAX_WORKFLOW_RETRY_BUDGET_V1) {
      throw new ContractViolation('E_WORKFLOW_BOUNDS', 'Stage timeout/retry budget is invalid');
    }
    if (/^(?:supervisor|workflow)$/i.test(stage.native_role)
      || stage.permissions.some((permission) => /workflow|supervisor|release|publish|verified/i.test(permission))) {
      throw new ContractViolation('E_WORKFLOW_PERMISSION', 'Nested supervisors or release privilege are forbidden');
    }
    if (stage.capability_mode === 'read-only' && stage.write_paths.length > 0) {
      throw new ContractViolation('E_WORKFLOW_PERMISSION', 'Read-only stage cannot declare write paths');
    }
    for (const [index, writePath] of stage.write_paths.entries()) {
      assertSafeRepositoryWritePath(writePath, `stage.write_paths[${index}]`);
    }
    // 設計概念映射：OMG role_posture 由 native_role 推導；矛盾組合以 E_WORKFLOW_PERMISSION 拒絕。
    const rolePosture = inspectOmaRolePosture({
      role: stage.native_role,
      capabilityMode: stage.capability_mode,
      writeScopeNone: stage.write_paths.length === 0,
      asChild: true,
    });
    if (!rolePosture.ok) {
      throw new ContractViolation('E_WORKFLOW_PERMISSION', rolePosture.message, rolePosture.details);
    }
    for (const [index, argv] of stage.verification_argv.entries()) {
      assertSafeArgvVector(argv, `stage.verification_argv[${index}]`);
    }
    if (stage.depends_on.includes(stage.stage_id)) {
      throw new ContractViolation('E_WORKFLOW_CYCLE', 'Stage cannot depend on itself');
    }
    if (stage.kind === 'author' || stage.kind === 'check') authorIdentities.add(stage.identity);
    if (stage.kind === 'verifier') verifierIdentities.add(stage.identity);
    if (stage.kind === 'skeptic') skepticIdentities.add(stage.identity);
    if (stage.kind === 'ship_gate') shipGateCount += 1;
  }
  if (totalAgents > definition.max_agent_count) {
    throw new ContractViolation('E_WORKFLOW_BOUNDS', 'Workflow total agent count exceeds the frozen bound');
  }
  if ([...indices].sort((left, right) => left - right)
    .some((declarationIndex, index) => declarationIndex !== index)) {
    throw new ContractViolation('E_WORKFLOW_STAGE', 'Stage declaration indices must be contiguous');
  }
  if (verifierIdentities.size === 0 || skepticIdentities.size === 0 || shipGateCount !== 1) {
    throw new ContractViolation('E_WORKFLOW_REVIEW', 'Workflow needs verifier, skeptic, and one ship gate');
  }
  for (const stage of definition.stages) {
    for (const dependency of stage.depends_on) {
      if (!ids.has(dependency)) {
        throw new ContractViolation('E_WORKFLOW_STAGE', 'Stage depends on an unknown/stale ID');
      }
    }
  }
  deterministicWorkflowOrder(definition.stages);
  for (const identity of verifierIdentities) {
    if (authorIdentities.has(identity) || skepticIdentities.has(identity)) {
      throw new ContractViolation('E_WORKFLOW_REVIEW', 'Verifier identity must be independent');
    }
  }
  for (const identity of skepticIdentities) {
    if (authorIdentities.has(identity)) {
      throw new ContractViolation('E_WORKFLOW_REVIEW', 'Skeptic identity must be independent');
    }
  }
  if (definition.migration.supersedes_version === null
    !== (definition.migration.supersedes_digest === null)) {
    throw new ContractViolation('E_WORKFLOW_VERSION', 'Supersedes version and digest must be paired');
  }
  if (definition.migration.supersedes_version !== null) {
    assertSemanticVersion(definition.migration.supersedes_version);
    assertSha256(definition.migration.supersedes_digest, 'migration.supersedes_digest');
  }
  assertNonEmptyString(definition.migration.reviewed_by, 'migration.reviewed_by');
  assertSha256(definition.migration.review_digest, 'migration.review_digest');
  const projectionProviders = new Set<string>();
  for (const projection of definition.native_projections) {
    assertPlainObject(projection, 'native projection');
    assertExactObjectKeys(
      projection as unknown as Record<string, unknown>,
      WORKFLOW_PROJECTION_KEYS,
      'native projection',
    );
    if (!['antigravity_saved_prompt', 'antigravity_native_team'].includes(projection.provider)
      || !['faithful', 'optional_unclaimed'].includes(projection.classification)
      || !(projection.maximum_claimed_tier in WORKFLOW_CAPABILITY_TIERS_V1)
      || projection.fresh_observation_required !== true
      || projectionProviders.has(projection.provider)) {
      throw new ContractViolation('E_WORKFLOW_NATIVE_UNSUPPORTED', 'Native projection shape is unsupported');
    }
    projectionProviders.add(projection.provider);
    if (projection.provider === 'antigravity_saved_prompt' && projection.maximum_claimed_tier !== 'T1') {
      throw new ContractViolation('E_WORKFLOW_NATIVE_UNSUPPORTED', 'Saved prompt projection cannot exceed T1');
    }
    if (projection.provider === 'antigravity_native_team'
      && (projection.classification !== 'optional_unclaimed' || projection.maximum_claimed_tier !== 'T0')) {
      throw new ContractViolation('E_WORKFLOW_NATIVE_UNSUPPORTED', 'Unproved native team must remain T0 optional-unclaimed');
    }
  }
  if (projectionProviders.size !== 2) {
    throw new ContractViolation('E_WORKFLOW_NATIVE_UNSUPPORTED', 'Both frozen native projections are required');
  }
  return definition;
}

export function assertWorkflowHistory(
  previous: RepositoryWorkflowV1,
  next: RepositoryWorkflowV1,
): void {
  validateRepositoryWorkflow(previous);
  validateRepositoryWorkflow(next);
  if (previous.name !== next.name) {
    throw new ContractViolation('E_WORKFLOW_VERSION', 'Workflow history cannot change canonical name');
  }
  if (previous.workflow_version === next.workflow_version) {
    if (previous.definition_digest !== next.definition_digest
      || canonicalBytesV1(previous).compare(canonicalBytesV1(next)) !== 0) {
      throw new ContractViolation('E_WORKFLOW_VERSION', 'Same workflow version cannot change bytes');
    }
    return;
  }
  if (next.migration.supersedes_version !== previous.workflow_version
    || next.migration.supersedes_digest !== previous.definition_digest
    || next.migration.reviewed_by.trim() === '') {
    throw new ContractViolation('E_WORKFLOW_VERSION', 'New workflow version needs reviewed supersedes metadata');
  }
}

export function workflowTaskId(input: WorkflowTaskIdentityInputV1): string {
  assertSha256(input.definition_digest, 'definition_digest');
  assertSha256(input.input_digest, 'input_digest');
  if (!Number.isInteger(input.matrix_index) || input.matrix_index < 0
    || !Number.isInteger(input.generation) || input.generation <= 0) {
    throw new ContractViolation('E_WORKFLOW_ID', 'Task matrix index/generation is invalid');
  }
  return sha256Hex(canonicalBytesV1([
    input.repository_id,
    input.workflow_name,
    input.workflow_version,
    input.definition_digest,
    input.input_digest,
    input.stage_id,
    input.matrix_index,
    input.generation,
  ]));
}

export function workflowReplayId(input: WorkflowTaskIdentityInputV1): string {
  return sha256Hex(canonicalBytesV1(['workflow-replay', workflowTaskId(input)]));
}

export function validateWorkflowCapability(record: WorkflowCapabilityRecordV1): void {
  if (!(record.tier in WORKFLOW_CAPABILITY_TIERS_V1)) {
    throw new ContractViolation('E_WORKFLOW_CAPABILITY', 'Workflow capability tier is invalid');
  }
  const booleans = [
    record.configured,
    record.installed,
    record.enabled,
    record.loadable,
    record.observed,
    record.healthy,
    record.verified,
  ];
  if (booleans.some((value) => typeof value !== 'boolean')) {
    throw new ContractViolation('E_WORKFLOW_CAPABILITY', 'Workflow capability truths are independent booleans');
  }
  if (record.tier === 'T5' && record.reconciled_effect_types.length === 0) {
    throw new ContractViolation('E_WORKFLOW_CAPABILITY', 'T5 requires an operation-specific reconciled effect');
  }
}

export function workflowTerminalFromEvidence(input: {
  required_stage_failed: boolean;
  required_stage_skipped: boolean;
  permission_denied: boolean;
  ambiguous_receipt: boolean;
  verifier_approved: boolean;
  skeptic_approved: boolean;
  ship_proof_present: boolean;
  external_effect_without_receipt: boolean;
}): WorkflowTerminalV1 {
  if (input.external_effect_without_receipt) return 'effect_unknown';
  if (input.permission_denied || input.ambiguous_receipt) return 'blocked';
  if (input.required_stage_failed) return 'failed';
  if (input.required_stage_skipped || !input.verifier_approved
    || !input.skeptic_approved || !input.ship_proof_present) return 'no_ship';
  return 'ship';
}
