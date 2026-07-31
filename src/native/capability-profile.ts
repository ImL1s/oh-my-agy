import * as crypto from 'crypto';
import * as path from 'path';
import { ContractViolation, assertCanonicalUtcTimestamp, canonicalBytesV1 } from '../contracts/state-schemas';

export const HOST_CAPABILITY_PROFILE_SCHEMA_V1 = 'oma.host-capability-profile/v1' as const;
export const HOST_CAPABILITY_POLICY_VERSION_V1 = 2 as const;
export const HOST_CAPABILITY_PROBE_SET_VERSION_V1 = 1 as const;
/** 發布主機實測累計 lineage 峰值為 19；保留至 32 的固定餘裕後仍 fail closed。 */
export const LIVE_MODEL_CANARY_MAXIMUM_PROCESSES_V1 = 32 as const;

export const EVIDENCE_TIERS = [
  'configured', 'installed', 'enabled', 'loadable', 'observed', 'healthy', 'verified',
] as const;
const CAPABILITY_OUTCOMES = ['supported', 'unsupported', 'unknown'] as const;
const CAPABILITY_SOURCES = ['help', 'config', 'plugin_readback', 'structured_init', 'live_probe'] as const;
const OBSERVATION_RESULTS = ['positive', 'negative', 'indeterminate'] as const;
export type EvidenceTier = typeof EVIDENCE_TIERS[number];
export type CapabilityOutcome = 'supported' | 'unsupported' | 'unknown';
export type CapabilitySource = 'help' | 'config' | 'plugin_readback' | 'structured_init' | 'live_probe';
export type ObservationResult = 'positive' | 'negative' | 'indeterminate';
export type CapabilitySideEffect =
  | 'passive-cache-only' | 'conversation' | 'model' | 'hook' | 'agent'
  | 'sidecar' | 'artifact_review' | 'mcp';

export interface HostIdentityV1 {
  realpath: string;
  binarySha256: string;
  version: string | null;
  versionOutputSha256: string;
  helpOutputSha256: string;
  platform: string;
  arch: string;
}

export interface PluginIdentityV1 {
  status: 'present' | 'absent' | 'unknown';
  realpath: string | null;
  packageDigest: string | null;
  version: string | null;
  readbackDigest: string | null;
  enabled: boolean;
}

export interface CapabilityObservationV1 {
  capability: string;
  source: CapabilitySource;
  tier: EvidenceTier;
  result: ObservationResult;
  observedAt: string;
  identityDigest: string;
  detailCode: string;
  diagnostic: string | null;
}

export interface CapabilityAssessmentV1 {
  key: string;
  outcome: CapabilityOutcome;
  supported: boolean;
  tier: EvidenceTier | null;
  source: CapabilitySource | null;
  fallback: string;
  fallbackPreconditions: string[];
  observations: CapabilityObservationV1[];
  diagnostics: string[];
}

export interface HostCapabilityProfileV1 {
  schema: typeof HOST_CAPABILITY_PROFILE_SCHEMA_V1;
  policyVersion: number;
  probeSetVersion: number;
  generatedAt: string;
  profileDigest: string;
  hostIdentity: HostIdentityV1;
  pluginIdentity: PluginIdentityV1;
  identityDigest: string;
  cacheKey: string;
  cacheable: boolean;
  identityStatus: 'matched' | 'drifted';
  freshness: { maximumAgeMs: number; oldestObservationAt: string | null };
  capabilities: CapabilityAssessmentV1[];
}

export interface CapabilityPolicyV1 {
  key: string;
  domain: string;
  scope: string;
  sourceCeilings: Readonly<Partial<Record<CapabilitySource, EvidenceTier>>>;
  routeTier: EvidenceTier;
  fallbackId: string;
  fallbackPreconditions: readonly string[];
  sideEffect: CapabilitySideEffect;
  evidencePredicates: Readonly<{
    positive: 'result_positive';
    affirmativeNegative: 'result_negative_same_identity';
    indeterminate: 'result_indeterminate_or_untrusted';
  }>;
  aggregation: 'indeterminate_or_contradiction_unknown';
  freshnessMs: number;
  limits: Readonly<{
    timeoutMs: number;
    maximumOutputBytes: number;
    maximumProcesses: number;
    maximumRecords: number;
    maximumInputBytes: number;
  }>;
}

const H: Readonly<Partial<Record<CapabilitySource, EvidenceTier>>> = { help: 'observed' };
const C: Readonly<Partial<Record<CapabilitySource, EvidenceTier>>> = { config: 'configured' };
const P: Readonly<Partial<Record<CapabilitySource, EvidenceTier>>> = { plugin_readback: 'loadable' };
const S: Readonly<Partial<Record<CapabilitySource, EvidenceTier>>> = { structured_init: 'observed' };
const L: Readonly<Partial<Record<CapabilitySource, EvidenceTier>>> = { live_probe: 'verified' };
const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 5_000,
  maximumOutputBytes: 64 * 1024,
  maximumProcesses: 8,
  maximumRecords: 256,
  maximumInputBytes: 256 * 1024,
});
const LIVE_MODEL_CANARY_LIMITS = Object.freeze({
  ...DEFAULT_LIMITS,
  timeoutMs: 60_000,
  maximumProcesses: LIVE_MODEL_CANARY_MAXIMUM_PROCESSES_V1,
});
const EVIDENCE_PREDICATES = Object.freeze({
  positive: 'result_positive' as const,
  affirmativeNegative: 'result_negative_same_identity' as const,
  indeterminate: 'result_indeterminate_or_untrusted' as const,
});

type PolicyRow = readonly [
  key: string,
  sources: readonly Readonly<Partial<Record<CapabilitySource, EvidenceTier>>>[],
  routeTier: EvidenceTier,
  fallbackId: string,
  precondition: string,
  sideEffect: CapabilitySideEffect,
];

const ROWS: readonly PolicyRow[] = [
  ['plugin.skills', [C, P, L], 'loadable', 'oma_plugin_assets', 'exact installed plugin identity', 'passive-cache-only'],
  ['plugin.rules', [C, P, L], 'loadable', 'oma_plugin_assets', 'exact installed plugin identity', 'passive-cache-only'],
  ['plugin.mcp_config', [C, P, L], 'loadable', 'oma_mcp_config', 'contained validated .mcp.json', 'passive-cache-only'],
  ['plugin.hooks_manifest', [C, P, L], 'loadable', 'oma_hook_runtime', 'contained validated hooks manifest', 'passive-cache-only'],
  ['plugin.layout.workspace', [C, P], 'configured', 'oma_workspace_projection', 'contained workspace root', 'passive-cache-only'],
  ['plugin.layout.global', [C, P], 'configured', 'fail_closed', 'none', 'passive-cache-only'],
  ...(['pre_tool_use', 'post_tool_use', 'pre_invocation', 'post_invocation', 'stop'] as const).map((name): PolicyRow =>
    [`hook.${name}`, [H, C, P, L], 'verified', 'oma_hook_runtime', 'exact installed enabled plugin', 'hook']),
  ['custom_agent.markdown', [H, C, P, S, L], 'observed', 'oma_agent_projection', 'validated contained agent markdown', 'passive-cache-only'],
  ...(['main_agent', 'subagent', 'hidden'] as const).map((name): PolicyRow =>
    [`custom_agent.${name}`, [H, C, P, S, L], 'observed', 'oma_agent_projection', 'markdown capability observed', 'passive-cache-only']),
  ['custom_agent.inherit_mcp', [H, C, P, S, L], 'observed', 'oma_agent_projection', 'MCP config loadable', 'passive-cache-only'],
  ['custom_agent.command_execution_policy', [H, C, P, S, L], 'observed', 'fail_closed', 'explicit policy readback', 'passive-cache-only'],
  ['custom_agent.model', [H, C, P, S, L], 'observed', 'oma_model_projection', 'model selection observed', 'passive-cache-only'],
  ['subagent.define', [H, C, P, S, L], 'observed', 'oma_agent_projection', 'custom-agent markdown observed', 'passive-cache-only'],
  ['subagent.invoke', [H, S, L], 'verified', 'agy_headless', 'headless route preconditions', 'agent'],
  ['subagent.send_message', [H, S, L], 'verified', 'oma_durable_mailbox', 'Team mailbox contract verified', 'agent'],
  ['subagent.manage', [H, S, L], 'verified', 'oma_team_control_plane', 'control-plane receipt valid', 'agent'],
  ['subagent.nested', [H, S, L], 'verified', 'fail_closed', 'none', 'agent'],
  ['subagent.background', [H, S, L], 'verified', 'agy_headless', 'headless route preconditions', 'agent'],
  ['headless.print', [H, S, L], 'healthy', 'tmux_agy', 'explicit tmux enablement and interactive canary', 'model'],
  ['headless.json', [H, S, L], 'healthy', 'fail_closed', 'none', 'model'],
  ['headless.stream_json', [H, S, L], 'healthy', 'headless.json', 'healthy JSON plus bounded buffering', 'model'],
  ['headless.json_schema', [H, S, L], 'healthy', 'oma_schema_validator', 'local schema validator available', 'model'],
  ...(['slash_expansion', 'skill_expansion'] as const).map((name): PolicyRow =>
    [`headless.${name}`, [H, S, L], 'verified', 'oma_skill_expansion', 'exact installed skill identity', 'model']),
  ['sidecar.layout.plugin', [C, P], 'configured', 'oma_out_of_process_runtime', 'contained public plugin layout', 'passive-cache-only'],
  ['sidecar.layout.global', [C, P], 'configured', 'fail_closed', 'documented contained global layout', 'passive-cache-only'],
  ['sidecar.restart_policy', [H, C, P, L], 'verified', 'oma_supervisor', 'owner and liveness contracts verified', 'sidecar'],
  ['sidecar.schedule', [H, C, P, L], 'verified', 'oma_scheduler', 'durable schedule contract verified', 'sidecar'],
  ['sidecar.agentapi', [H, C, P, L], 'verified', 'fail_closed', 'documented public endpoint only', 'sidecar'],
  ['sidecar.agentapi.new_conversation', [H, L], 'verified', 'agy_headless', 'conversation receipt and headless preconditions', 'conversation'],
  ['sidecar.agentapi.send_message', [H, L], 'verified', 'oma_durable_mailbox', 'exact conversation binding', 'conversation'],
  ...(['statusline', 'title'] as const).map((name): PolicyRow =>
    [`ui.${name}`, [H, C, P, L], 'observed', 'oma_hud', 'state snapshot available', 'passive-cache-only']),
  ['conversation.continue', [H, S, L], 'verified', 'oma_resume', 'exact conversation binding', 'conversation'],
  ['conversation.exact', [H, S, L], 'verified', 'fail_closed', 'exact conversation ID receipt', 'conversation'],
  ...(['fork', 'branch'] as const).map((name): PolicyRow =>
    [`conversation.${name}`, [H, S, L], 'verified', 'oma_recovery_fork', 'explicit history-only semantics', 'conversation']),
  ['project.association', [H, C, S, L], 'observed', 'oma_workspace_identity', 'canonical workspace identity', 'passive-cache-only'],
  ['permission.policy', [H, C, S, L], 'observed', 'oma_permission_envelope', 'explicit readback, never inferred', 'passive-cache-only'],
  ['permission.sandbox', [H, C, S, L], 'healthy', 'oma_sandbox', 'verified local sandbox capability', 'model'],
  ['permission.artifact_review', [H, C, S, L], 'verified', 'oma_artifact_contract', 'artifact validator configured', 'artifact_review'],
  ['model.discovery', [H, S, L], 'observed', 'fail_closed', 'none', 'passive-cache-only'],
  ['model.selection', [H, S, L], 'healthy', 'oma_model_projection', 'discovered model exact match', 'model'],
  ['effort.discovery', [H, S, L], 'observed', 'fail_closed', 'none', 'passive-cache-only'],
  ['effort.selection', [H, S, L], 'healthy', 'oma_effort_projection', 'discovered effort exact match', 'model'],
  ['mcp.local_config', [H, C, P, S, L], 'loadable', 'oma_mcp_config', 'contained local config', 'passive-cache-only'],
  ['mcp.remote_config', [H, C, P, S, L], 'loadable', 'fail_closed', 'remote endpoint allowlist', 'passive-cache-only'],
  ['mcp.local_lifecycle', [H, S, L], 'verified', 'oma_mcp_runtime', 'local config loadable and process bounded', 'mcp'],
  ['mcp.remote_lifecycle', [H, S, L], 'verified', 'fail_closed', 'remote allowlist, auth, and bounded transport', 'mcp'],
];

export const HOST_CAPABILITY_POLICY_REGISTRY_V1: readonly CapabilityPolicyV1[] = Object.freeze(
  ROWS.map(([key, sources, routeTier, fallbackId, precondition, sideEffect]) => Object.freeze({
    key,
    domain: key.split('.')[0],
    scope: key,
    sourceCeilings: Object.freeze(Object.assign({}, ...sources)),
    routeTier,
    fallbackId,
    fallbackPreconditions: Object.freeze(precondition === 'none' ? [] : [precondition]),
    sideEffect,
    evidencePredicates: EVIDENCE_PREDICATES,
    aggregation: 'indeterminate_or_contradiction_unknown' as const,
    freshnessMs: sideEffect === 'passive-cache-only' ? 300_000 : 60_000,
    limits: key === 'headless.print' || key === 'headless.json'
      ? LIVE_MODEL_CANARY_LIMITS
      : DEFAULT_LIMITS,
  })).sort((left, right) => compareUtf8(left.key, right.key)),
);

export function validateCapabilityPolicyRegistry(
  registry: readonly CapabilityPolicyV1[] = HOST_CAPABILITY_POLICY_REGISTRY_V1,
): readonly CapabilityPolicyV1[] {
  const expected = [...ROWS.map(([key]) => key)].sort(compareUtf8);
  const actual = registry.map(({ key }) => key);
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw violation('E_CAPABILITY_POLICY', 'Capability policy registry key set/order is invalid');
  }
  for (const policy of registry) {
    if (Object.keys(policy.sourceCeilings).length === 0 || policy.fallbackId === ''
      || policy.scope === '' || policy.domain === '' || !EVIDENCE_TIERS.includes(policy.routeTier)
      || policy.aggregation !== 'indeterminate_or_contradiction_unknown'
      || policy.evidencePredicates.positive !== 'result_positive'
      || policy.evidencePredicates.affirmativeNegative !== 'result_negative_same_identity'
      || policy.evidencePredicates.indeterminate !== 'result_indeterminate_or_untrusted'
      || policy.freshnessMs <= 0 || Object.values(policy.limits).some((limit) => !Number.isSafeInteger(limit) || limit <= 0)) {
      throw violation('E_CAPABILITY_POLICY', `Capability policy is incomplete: ${policy.key}`);
    }
  }
  return registry;
}

export const TEAM_PROVIDER_POLICY_V1 = Object.freeze({
  antigravity_native: Object.freeze({
    required: Object.freeze([
      Object.freeze({ capability: 'subagent.invoke', tier: 'verified' as const }),
      Object.freeze({ capability: 'subagent.send_message', tier: 'verified' as const }),
      Object.freeze({ capability: 'subagent.manage', tier: 'verified' as const }),
    ]),
    adapterImplemented: false,
  }),
  agy_headless: Object.freeze({
    required: Object.freeze([
      Object.freeze({ capability: 'headless.print', tier: 'healthy' as const }),
    ]),
    adapterImplemented: true,
  }),
  tmux_agy: Object.freeze({
    required: Object.freeze([Object.freeze({ capability: 'headless.print', tier: 'healthy' as const })]),
    externalPreconditions: Object.freeze(['tmux observed', 'explicit enablement', 'interactive canary valid']),
    adapterImplemented: true,
  }),
});

export interface AssembleHostCapabilityProfileInputV1 {
  evaluationTimestamp: string;
  hostIdentityBefore: HostIdentityV1;
  hostIdentityAfter: HostIdentityV1;
  pluginIdentityBefore: PluginIdentityV1;
  pluginIdentityAfter: PluginIdentityV1;
  observations: readonly CapabilityObservationV1[];
  policyVersion?: number;
  probeSetVersion?: number;
  cacheable?: boolean;
}

export function assembleHostCapabilityProfile(
  input: Readonly<AssembleHostCapabilityProfileInputV1>,
): HostCapabilityProfileV1 {
  assertCanonicalUtcTimestamp(input.evaluationTimestamp, 'evaluationTimestamp');
  validateCapabilityPolicyRegistry();
  const evaluationMs = Date.parse(input.evaluationTimestamp);
  const hostMatched = canonicalEqual(input.hostIdentityBefore, input.hostIdentityAfter);
  const pluginMatched = canonicalEqual(input.pluginIdentityBefore, input.pluginIdentityAfter);
  const identityStatus = hostMatched && pluginMatched ? 'matched' : 'drifted';
  const hostIdentity = clone(input.hostIdentityAfter);
  const pluginIdentity = clone(input.pluginIdentityAfter);
  validateHostIdentity(hostIdentity);
  validatePluginIdentity(pluginIdentity, hostIdentity.platform);
  const identityDigest = digestOf({ hostIdentity, pluginIdentity });
  const normalized = input.observations.map((observation) => normalizeObservation(observation, evaluationMs));
  if (normalized.length > DEFAULT_LIMITS.maximumRecords) {
    throw violation('E_CAPABILITY_PROFILE', 'Capability observation count exceeds policy bound');
  }
  const policyVersion = input.policyVersion ?? HOST_CAPABILITY_POLICY_VERSION_V1;
  const probeSetVersion = input.probeSetVersion ?? HOST_CAPABILITY_PROBE_SET_VERSION_V1;
  const capabilities = HOST_CAPABILITY_POLICY_REGISTRY_V1.map((policy) => aggregateCapability(
    policy,
    normalized.filter(({ capability }) => capability === policy.key),
    identityDigest,
    evaluationMs,
    identityStatus,
  ));
  const observationTimes = normalized.map(({ observedAt }) => observedAt).sort(compareUtf8);
  const withoutDigest = {
    schema: HOST_CAPABILITY_PROFILE_SCHEMA_V1,
    policyVersion,
    probeSetVersion,
    generatedAt: input.evaluationTimestamp,
    hostIdentity,
    pluginIdentity,
    identityDigest,
    cacheKey: createHostCapabilityCacheKey({ hostIdentity, pluginIdentity, policyVersion, probeSetVersion }),
    cacheable: identityStatus === 'matched' && input.cacheable !== false,
    identityStatus,
    freshness: { maximumAgeMs: Math.max(...HOST_CAPABILITY_POLICY_REGISTRY_V1.map(({ freshnessMs }) => freshnessMs)), oldestObservationAt: observationTimes[0] ?? null },
    capabilities,
  };
  const profile = { ...withoutDigest, profileDigest: digestOf(withoutDigest) };
  return validateHostCapabilityProfile(profile);
}

export function validateHostCapabilityProfile(value: unknown): HostCapabilityProfileV1 {
  if (!isObject(value)) throw violation('E_CAPABILITY_PROFILE', 'Host capability profile must be an object');
  assertKeys(value, [
    'schema', 'policyVersion', 'probeSetVersion', 'generatedAt', 'profileDigest', 'hostIdentity',
    'pluginIdentity', 'identityDigest', 'cacheKey', 'cacheable', 'identityStatus', 'freshness', 'capabilities',
  ], 'Host capability profile');
  const profile = value as unknown as HostCapabilityProfileV1;
  if (profile.schema !== HOST_CAPABILITY_PROFILE_SCHEMA_V1) throw violation('E_FUTURE_SCHEMA', 'Host capability profile schema is invalid');
  if (!Number.isSafeInteger(profile.policyVersion) || profile.policyVersion <= 0
    || !Number.isSafeInteger(profile.probeSetVersion) || profile.probeSetVersion <= 0) {
    throw violation('E_CAPABILITY_PROFILE', 'Profile versions are invalid');
  }
  assertCanonicalUtcTimestamp(profile.generatedAt, 'generatedAt');
  const evaluationMs = Date.parse(profile.generatedAt);
  validateHostIdentity(profile.hostIdentity);
  validatePluginIdentity(profile.pluginIdentity, profile.hostIdentity.platform);
  if (typeof profile.profileDigest !== 'string' || typeof profile.identityDigest !== 'string'
    || typeof profile.cacheKey !== 'string' || !/^[a-f0-9]{64}$/u.test(profile.profileDigest)
    || !/^[a-f0-9]{64}$/u.test(profile.identityDigest) || !/^[a-f0-9]{64}$/u.test(profile.cacheKey)) {
    throw violation('E_CAPABILITY_PROFILE', 'Profile digest is invalid');
  }
  if (profile.identityDigest !== digestOf({ hostIdentity: profile.hostIdentity, pluginIdentity: profile.pluginIdentity })) {
    throw violation('E_CAPABILITY_PROFILE', 'Profile identity digest mismatch');
  }
  if (profile.cacheKey !== createHostCapabilityCacheKey(profile)) throw violation('E_CAPABILITY_PROFILE', 'Profile cache key mismatch');
  if (typeof profile.cacheable !== 'boolean' || !['matched', 'drifted'].includes(profile.identityStatus)) {
    throw violation('E_CAPABILITY_PROFILE', 'Profile identity status/cacheability is invalid');
  }
  if (profile.cacheable && profile.identityStatus !== 'matched') throw violation('E_CAPABILITY_PROFILE', 'Profile cacheability is inconsistent');
  if (!Array.isArray(profile.capabilities)) throw violation('E_CAPABILITY_PROFILE', 'Profile capabilities must be an array');
  const keys = profile.capabilities.map(({ key }) => key);
  const expected = HOST_CAPABILITY_POLICY_REGISTRY_V1.map(({ key }) => key);
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw violation('E_CAPABILITY_PROFILE', 'Profile capability set/order is invalid');
  const observations = profile.capabilities.flatMap((assessment, index) => validateAssessment(
    assessment,
    HOST_CAPABILITY_POLICY_REGISTRY_V1[index],
    profile.identityDigest,
    evaluationMs,
    profile.identityStatus,
  ));
  if (observations.length > DEFAULT_LIMITS.maximumRecords) {
    throw violation('E_CAPABILITY_PROFILE', 'Capability observation count exceeds policy bound');
  }
  if (!isObject(profile.freshness)) throw violation('E_CAPABILITY_PROFILE', 'Profile freshness must be an object');
  assertKeys(profile.freshness as unknown as Record<string, unknown>, ['maximumAgeMs', 'oldestObservationAt'], 'Profile freshness');
  const observationTimes = observations.map(({ observedAt }) => observedAt).sort(compareUtf8);
  const expectedFreshness = {
    maximumAgeMs: Math.max(...HOST_CAPABILITY_POLICY_REGISTRY_V1.map(({ freshnessMs }) => freshnessMs)),
    oldestObservationAt: observationTimes[0] ?? null,
  };
  if (!canonicalEqual(profile.freshness, expectedFreshness)) {
    throw violation('E_CAPABILITY_PROFILE', 'Profile freshness projection is inconsistent');
  }
  const { profileDigest: _ignored, ...withoutDigest } = profile;
  if (profile.profileDigest !== digestOf(withoutDigest)) throw violation('E_CAPABILITY_PROFILE', 'Profile digest mismatch');
  return profile;
}

export function canonicalHostCapabilityProfile(profile: Readonly<HostCapabilityProfileV1>): string {
  return canonicalBytesV1(validateHostCapabilityProfile(profile)).toString('utf8');
}

export function createHostCapabilityCacheKey(input: {
  hostIdentity: HostIdentityV1;
  pluginIdentity: PluginIdentityV1;
  policyVersion?: number;
  probeSetVersion?: number;
}): string {
  return digestOf({
    schema: HOST_CAPABILITY_PROFILE_SCHEMA_V1,
    policyVersion: input.policyVersion ?? HOST_CAPABILITY_POLICY_VERSION_V1,
    probeSetVersion: input.probeSetVersion ?? HOST_CAPABILITY_PROBE_SET_VERSION_V1,
    hostIdentity: input.hostIdentity,
    pluginIdentity: input.pluginIdentity,
  });
}

export function hostCapabilityIdentityDigest(hostIdentity: HostIdentityV1, pluginIdentity: PluginIdentityV1): string {
  validateHostIdentity(hostIdentity);
  validatePluginIdentity(pluginIdentity, hostIdentity.platform);
  return digestOf({ hostIdentity, pluginIdentity });
}

export interface HostRouteCandidateV1 {
  schema: 'oma.host-route-candidate/v1';
  profileDigest: string;
  policyVersion: number;
  probeSetVersion: number;
  identityDigest: string;
  capability: string;
  requiredTier: EvidenceTier;
  provider: string;
  fallbackId: string;
  fallbackPreconditionsSatisfied: boolean;
  requestMode: string;
  generation: number;
  contextDigest: string;
  selectedAt: string;
  expiresAt: string;
  candidateDigest: string;
}

export interface HostRouteReceiptV1 extends Omit<HostRouteCandidateV1, 'schema' | 'candidateDigest'> {
  schema: 'oma.host-route-receipt/v1';
  candidateDigest: string;
  resolvedExecutable: string;
  adapter: string;
  receiptDigest: string;
}

export interface HostRouteRequestV1 {
  capability: string;
  provider: string;
  requestMode: string;
  generation: number;
  contextDigest: string;
  selectedAt: string;
  ttlMs: number;
  fallbackPreconditionsSatisfied: boolean;
}

export function routeHostCapability(
  profileValue: unknown,
  request: Readonly<HostRouteRequestV1>,
): HostRouteCandidateV1 {
  const profile = validateHostCapabilityProfile(profileValue);
  const policy = HOST_CAPABILITY_POLICY_REGISTRY_V1.find(({ key }) => key === request.capability);
  const assessment = profile.capabilities.find(({ key }) => key === request.capability);
  if (policy === undefined || assessment === undefined
    || profile.policyVersion !== HOST_CAPABILITY_POLICY_VERSION_V1 || profile.probeSetVersion !== HOST_CAPABILITY_PROBE_SET_VERSION_V1
    || profile.identityStatus !== 'matched' || !profile.cacheable
    || assessment.outcome !== 'supported' || assessment.tier === null
    || tierRank(assessment.tier) < tierRank(policy.routeTier)) {
    throw violation('E_CAPABILITY_UNPROVEN', 'Host capability route is unproven');
  }
  assertCanonicalUtcTimestamp(request.selectedAt, 'selectedAt');
  const selectedAtMs = Date.parse(request.selectedAt);
  const selectionAgeMs = selectedAtMs - Date.parse(profile.generatedAt);
  if (!Number.isSafeInteger(request.generation) || request.generation < 0 || !Number.isSafeInteger(request.ttlMs) || request.ttlMs <= 0) {
    throw violation('E_CAPABILITY_ROUTE', 'Route request bounds are invalid');
  }
  if (selectionAgeMs < 0 || selectionAgeMs > policy.freshnessMs || request.ttlMs > policy.freshnessMs) {
    throw violation('E_CAPABILITY_UNPROVEN', 'Host capability profile is stale for routing');
  }
  const expiresAtMs = selectedAtMs + request.ttlMs;
  if (!routeAuthorizingEvidenceCovers(assessment, policy, selectedAtMs, expiresAtMs)
    || expiresAtMs - Date.parse(profile.generatedAt) > policy.freshnessMs) {
    throw violation('E_CAPABILITY_UNPROVEN', 'Host capability evidence expires before the requested route');
  }
  if (policy.fallbackId !== 'fail_closed' && !request.fallbackPreconditionsSatisfied) {
    throw violation('E_CAPABILITY_UNPROVEN', 'Fallback preconditions are not satisfied');
  }
  const withoutDigest = {
    schema: 'oma.host-route-candidate/v1' as const,
    profileDigest: profile.profileDigest,
    policyVersion: profile.policyVersion,
    probeSetVersion: profile.probeSetVersion,
    identityDigest: profile.identityDigest,
    capability: request.capability,
    requiredTier: policy.routeTier,
    provider: request.provider,
    fallbackId: policy.fallbackId,
    fallbackPreconditionsSatisfied: request.fallbackPreconditionsSatisfied,
    requestMode: request.requestMode,
    generation: request.generation,
    contextDigest: request.contextDigest,
    selectedAt: request.selectedAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  return { ...withoutDigest, candidateDigest: digestOf(withoutDigest) };
}

export function validateHostRouteCandidate(
  value: unknown,
  profileValue: unknown,
  expected: { now: string; generation: number; contextDigest: string; identityDigest: string; provider?: string; requestMode?: string },
): HostRouteCandidateV1 {
  const profile = validateHostCapabilityProfile(profileValue);
  if (!isObject(value) || value.schema !== 'oma.host-route-candidate/v1') throw violation('E_CAPABILITY_ROUTE', 'Route candidate schema is invalid');
  assertKeys(value, [
    'schema', 'profileDigest', 'policyVersion', 'probeSetVersion', 'identityDigest', 'capability', 'requiredTier',
    'provider', 'fallbackId', 'fallbackPreconditionsSatisfied', 'requestMode', 'generation', 'contextDigest',
    'selectedAt', 'expiresAt', 'candidateDigest',
  ], 'Route candidate');
  const candidate = value as unknown as HostRouteCandidateV1;
  const policy = HOST_CAPABILITY_POLICY_REGISTRY_V1.find(({ key }) => key === candidate.capability);
  const assessment = profile.capabilities.find(({ key }) => key === candidate.capability);
  assertCanonicalUtcTimestamp(expected.now, 'now');
  assertCanonicalUtcTimestamp(candidate.selectedAt, 'selectedAt');
  assertCanonicalUtcTimestamp(candidate.expiresAt, 'expiresAt');
  const selectedAtMs = Date.parse(candidate.selectedAt);
  const expiresAtMs = Date.parse(candidate.expiresAt);
  const nowMs = Date.parse(expected.now);
  const profileAgeAtSelectionMs = selectedAtMs - Date.parse(profile.generatedAt);
  const routeTtlMs = expiresAtMs - selectedAtMs;
  const { candidateDigest, ...withoutDigest } = candidate;
  const routeEvidenceValid = policy !== undefined && assessment !== undefined
    && routeAuthorizingEvidenceCovers(assessment, policy, selectedAtMs, expiresAtMs);
  if (typeof candidate.capability !== 'string'
    || typeof candidate.provider !== 'string' || !safeRouteField(candidate.provider)
    || typeof candidate.requestMode !== 'string' || !safeRouteField(candidate.requestMode)
    || typeof candidate.contextDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.contextDigest)
    || typeof candidate.candidateDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.candidateDigest)
    || typeof candidate.fallbackPreconditionsSatisfied !== 'boolean'
    || !Number.isSafeInteger(candidate.generation) || candidate.generation < 0
    || candidateDigest !== digestOf(withoutDigest) || candidate.profileDigest !== profile.profileDigest
    || candidate.policyVersion !== profile.policyVersion || candidate.probeSetVersion !== profile.probeSetVersion
    || profile.policyVersion !== HOST_CAPABILITY_POLICY_VERSION_V1
    || profile.probeSetVersion !== HOST_CAPABILITY_PROBE_SET_VERSION_V1
    || profile.identityStatus !== 'matched' || !profile.cacheable
    || candidate.identityDigest !== expected.identityDigest || candidate.identityDigest !== profile.identityDigest
    || candidate.generation !== expected.generation || candidate.contextDigest !== expected.contextDigest
    || (expected.provider !== undefined && candidate.provider !== expected.provider)
    || (expected.requestMode !== undefined && candidate.requestMode !== expected.requestMode)
    || policy === undefined || assessment === undefined || candidate.requiredTier !== policy.routeTier
    || candidate.fallbackId !== policy.fallbackId || assessment.outcome !== 'supported' || assessment.tier === null
    || tierRank(assessment.tier) < tierRank(candidate.requiredTier)
    || (policy.fallbackId !== 'fail_closed' && !candidate.fallbackPreconditionsSatisfied)
    || profileAgeAtSelectionMs < 0 || profileAgeAtSelectionMs > (policy?.freshnessMs ?? 0)
    || routeTtlMs <= 0 || routeTtlMs > (policy?.freshnessMs ?? 0)
    || expiresAtMs - Date.parse(profile.generatedAt) > (policy?.freshnessMs ?? 0)
    || !routeEvidenceValid
    || selectedAtMs > nowMs || expiresAtMs <= nowMs) {
    throw violation('E_CAPABILITY_ROUTE', 'Route candidate is tampered, mismatched, or expired');
  }
  return candidate;
}

function routeAuthorizingEvidenceCovers(
  assessment: Readonly<CapabilityAssessmentV1>,
  policy: Readonly<CapabilityPolicyV1>,
  selectedAtMs: number,
  expiresAtMs: number,
): boolean {
  const evidenceExpiryMs = positiveCapabilityEvidenceExpiryMs(
    assessment,
    policy,
    policy.routeTier,
    selectedAtMs,
  );
  return evidenceExpiryMs !== null && evidenceExpiryMs >= expiresAtMs;
}

export function positiveCapabilityEvidenceExpiryMs(
  assessment: Readonly<CapabilityAssessmentV1>,
  policy: Readonly<CapabilityPolicyV1>,
  requiredTier: EvidenceTier,
  selectedAtMs: number,
): number | null {
  if (assessment.key !== policy.key || !Number.isFinite(selectedAtMs)) return null;
  const expiries = assessment.observations.flatMap((observation) => {
    const ceiling = policy.sourceCeilings[observation.source];
    if (observation.result !== 'positive' || ceiling === undefined
      || tierRank(minTier(observation.tier, ceiling)) < tierRank(requiredTier)) return [];
    const observedAtMs = Date.parse(observation.observedAt);
    return Number.isFinite(observedAtMs) && selectedAtMs >= observedAtMs
      && selectedAtMs - observedAtMs <= policy.freshnessMs
      ? [observedAtMs + policy.freshnessMs]
      : [];
  });
  return expiries.length === 0 ? null : Math.max(...expiries);
}

export function issueHostRouteReceipt(
  candidate: Readonly<HostRouteCandidateV1>,
  resolvedExecutable: string,
  adapter: string,
): HostRouteReceiptV1 {
  if (!isPortableAbsolutePath(resolvedExecutable) || adapter.trim() === '') throw violation('E_CAPABILITY_ROUTE', 'Route adapter identity is invalid');
  const { candidateDigest, ...candidateWithoutDigest } = candidate;
  if (candidateDigest !== digestOf(candidateWithoutDigest)) throw violation('E_CAPABILITY_ROUTE', 'Route candidate digest is invalid');
  const withoutDigest = { ...candidate, schema: 'oma.host-route-receipt/v1' as const, resolvedExecutable, adapter };
  return { ...withoutDigest, receiptDigest: digestOf(withoutDigest) };
}

export function validateHostRouteReceipt(
  value: unknown,
  profile: unknown,
  expected: { now: string; generation: number; contextDigest: string; identityDigest: string; fallbackPreconditionsSatisfied: boolean; provider?: string; requestMode?: string },
): HostRouteReceiptV1 {
  const validatedProfile = validateHostCapabilityProfile(profile);
  if (!isObject(value) || value.schema !== 'oma.host-route-receipt/v1') throw violation('E_CAPABILITY_ROUTE', 'Route receipt schema is invalid');
  assertKeys(value, [
    'schema', 'profileDigest', 'policyVersion', 'probeSetVersion', 'identityDigest', 'capability', 'requiredTier',
    'provider', 'fallbackId', 'fallbackPreconditionsSatisfied', 'requestMode', 'generation', 'contextDigest',
    'selectedAt', 'expiresAt', 'candidateDigest', 'resolvedExecutable', 'adapter', 'receiptDigest',
  ], 'Route receipt');
  const receipt = value as unknown as HostRouteReceiptV1;
  const { receiptDigest, resolvedExecutable: _path, adapter: _adapter, schema: _schema, ...candidateFields } = receipt;
  validateHostRouteCandidate({ ...candidateFields, schema: 'oma.host-route-candidate/v1' }, validatedProfile, expected);
  const { receiptDigest: _ignored, ...withoutDigest } = receipt;
  if (receiptDigest !== digestOf(withoutDigest) || receipt.fallbackPreconditionsSatisfied !== expected.fallbackPreconditionsSatisfied
    || receipt.resolvedExecutable !== validatedProfile.hostIdentity.realpath
    || !isAbsoluteHostPath(receipt.resolvedExecutable, validatedProfile.hostIdentity.platform)
    || !safeRouteField(receipt.adapter)) {
    throw violation('E_CAPABILITY_ROUTE', 'Route receipt is tampered or fallback conditions changed');
  }
  return receipt;
}

function aggregateCapability(
  policy: CapabilityPolicyV1,
  observations: readonly CapabilityObservationV1[],
  identityDigest: string,
  evaluationMs: number,
  identityStatus: HostCapabilityProfileV1['identityStatus'],
): CapabilityAssessmentV1 {
  const sorted = [...observations].sort(compareObservation);
  const trustworthy = sorted.filter((observation) => observation.identityDigest === identityDigest
    && evaluationMs - Date.parse(observation.observedAt) >= 0
    && evaluationMs - Date.parse(observation.observedAt) <= policy.freshnessMs
    && policy.sourceCeilings[observation.source] !== undefined);
  const effective = trustworthy.map((observation) => ({
    observation,
    tier: minTier(observation.tier, policy.sourceCeilings[observation.source] as EvidenceTier),
  }));
  const positives = effective.filter(({ observation }) => observation.result === 'positive');
  const negatives = effective.filter(({ observation }) => observation.result === 'negative');
  const indeterminate = sorted.some(({ result }) => result === 'indeterminate')
    || trustworthy.length !== sorted.length || identityStatus === 'drifted';
  const contradictory = positives.length > 0 && negatives.length > 0;
  const outcome: CapabilityOutcome = indeterminate || contradictory || (positives.length === 0 && negatives.length === 0)
    ? 'unknown' : positives.length > 0 ? 'supported' : 'unsupported';
  const strongest = [...(positives.length > 0 ? positives : negatives)].sort((left, right) =>
    tierRank(right.tier) - tierRank(left.tier) || compareObservation(left.observation, right.observation))[0];
  return {
    key: policy.key,
    outcome,
    supported: outcome === 'supported',
    tier: strongest?.tier ?? null,
    source: strongest?.observation.source ?? null,
    fallback: policy.fallbackId,
    fallbackPreconditions: [...policy.fallbackPreconditions],
    observations: sorted,
    diagnostics: [
      ...(contradictory ? ['CONTRADICTORY_EVIDENCE'] : []),
      ...(identityStatus === 'drifted' ? ['IDENTITY_DRIFT'] : []),
      ...(indeterminate && identityStatus === 'matched' ? ['INDETERMINATE_EVIDENCE'] : []),
    ],
  };
}

function normalizeObservation(observation: CapabilityObservationV1, evaluationMs: number): CapabilityObservationV1 {
  if (!isObject(observation)) throw violation('E_CAPABILITY_PROFILE', 'Capability observation must be an object');
  assertKeys(observation as unknown as Record<string, unknown>, [
    'capability', 'source', 'tier', 'result', 'observedAt', 'identityDigest', 'detailCode', 'diagnostic',
  ], 'Capability observation');
  if (typeof observation.capability !== 'string'
    || typeof observation.source !== 'string' || !CAPABILITY_SOURCES.includes(observation.source as CapabilitySource)
    || typeof observation.tier !== 'string' || !EVIDENCE_TIERS.includes(observation.tier as EvidenceTier)
    || typeof observation.result !== 'string' || !OBSERVATION_RESULTS.includes(observation.result as ObservationResult)
    || typeof observation.observedAt !== 'string' || typeof observation.identityDigest !== 'string'
    || typeof observation.detailCode !== 'string'
    || (observation.diagnostic !== null && typeof observation.diagnostic !== 'string')) {
    throw violation('E_CAPABILITY_PROFILE', 'Capability observation fields are invalid');
  }
  if (!HOST_CAPABILITY_POLICY_REGISTRY_V1.some(({ key }) => key === observation.capability)) throw violation('E_CAPABILITY_PROFILE', `Unknown capability: ${observation.capability}`);
  assertCanonicalUtcTimestamp(observation.observedAt, 'observedAt');
  if (Date.parse(observation.observedAt) > evaluationMs) throw violation('E_CAPABILITY_PROFILE', 'Observation is later than evaluation timestamp');
  if (!/^[a-f0-9]{64}$/u.test(observation.identityDigest) || observation.detailCode.trim() === '') throw violation('E_CAPABILITY_PROFILE', 'Observation identity/detail is invalid');
  if (observation.diagnostic !== null && (observation.diagnostic.length > 4096 || secretLike(observation.diagnostic))) throw violation('E_CAPABILITY_REDACTION', 'Observation diagnostic is unsafe');
  return clone(observation);
}

function validateAssessment(
  assessment: CapabilityAssessmentV1,
  policy: CapabilityPolicyV1,
  identityDigest: string,
  evaluationMs: number,
  identityStatus: HostCapabilityProfileV1['identityStatus'],
): CapabilityObservationV1[] {
  if (!isObject(assessment)) throw violation('E_CAPABILITY_PROFILE', 'Capability assessment must be an object');
  assertKeys(assessment as unknown as Record<string, unknown>, [
    'key', 'outcome', 'supported', 'tier', 'source', 'fallback', 'fallbackPreconditions', 'observations', 'diagnostics',
  ], 'Capability assessment');
  if (typeof assessment.key !== 'string' || assessment.key !== policy.key
    || typeof assessment.outcome !== 'string' || !CAPABILITY_OUTCOMES.includes(assessment.outcome as CapabilityOutcome)
    || typeof assessment.supported !== 'boolean'
    || (assessment.tier !== null && (typeof assessment.tier !== 'string' || !EVIDENCE_TIERS.includes(assessment.tier as EvidenceTier)))
    || (assessment.source !== null && (typeof assessment.source !== 'string' || !CAPABILITY_SOURCES.includes(assessment.source as CapabilitySource)))
    || typeof assessment.fallback !== 'string' || !Array.isArray(assessment.fallbackPreconditions)
    || assessment.fallbackPreconditions.some((entry) => typeof entry !== 'string')
    || !Array.isArray(assessment.observations) || !Array.isArray(assessment.diagnostics)
    || assessment.diagnostics.some((entry) => typeof entry !== 'string')) {
    throw violation('E_CAPABILITY_PROFILE', 'Capability assessment fields are invalid');
  }
  if (assessment.supported !== (assessment.outcome === 'supported')) throw violation('E_CAPABILITY_PROFILE', 'supported compatibility projection is inconsistent');
  if ((assessment.tier === null) !== (assessment.source === null)) throw violation('E_CAPABILITY_PROFILE', 'Assessment tier/source nullability is inconsistent');
  const observations = assessment.observations.map((observation) => normalizeObservation(observation, evaluationMs));
  if (observations.some(({ capability }) => capability !== policy.key)) {
    throw violation('E_CAPABILITY_PROFILE', 'Capability assessment contains cross-capability evidence');
  }
  const recomputed = aggregateCapability(policy, observations, identityDigest, evaluationMs, identityStatus);
  if (!canonicalEqual(assessment, recomputed)) {
    throw violation('E_CAPABILITY_PROFILE', 'Capability assessment projection is inconsistent with evidence');
  }
  return observations;
}

function validateHostIdentity(identity: HostIdentityV1): void {
  if (!isObject(identity)) throw violation('E_CAPABILITY_IDENTITY', 'Host identity must be an object');
  assertKeys(identity as unknown as Record<string, unknown>, [
    'realpath', 'binarySha256', 'version', 'versionOutputSha256', 'helpOutputSha256', 'platform', 'arch',
  ], 'Host identity');
  if (typeof identity.realpath !== 'string'
    || typeof identity.binarySha256 !== 'string' || typeof identity.versionOutputSha256 !== 'string'
    || typeof identity.helpOutputSha256 !== 'string'
    || [identity.binarySha256, identity.versionOutputSha256, identity.helpOutputSha256].some((digest) => !/^[a-f0-9]{64}$/u.test(digest))
    || (identity.version !== null && typeof identity.version !== 'string')
    || typeof identity.platform !== 'string' || identity.platform.trim() === ''
    || typeof identity.arch !== 'string' || identity.arch.trim() === ''
    || !isAbsoluteHostPath(identity.realpath, identity.platform)) {
    throw violation('E_CAPABILITY_IDENTITY', 'Host identity is invalid');
  }
}

function validatePluginIdentity(identity: PluginIdentityV1, platform: string): void {
  if (!isObject(identity)) throw violation('E_CAPABILITY_IDENTITY', 'Plugin identity must be an object');
  assertKeys(identity as unknown as Record<string, unknown>, [
    'status', 'realpath', 'packageDigest', 'version', 'readbackDigest', 'enabled',
  ], 'Plugin identity');
  if (!['present', 'absent', 'unknown'].includes(identity.status)
    || (identity.realpath !== null && typeof identity.realpath !== 'string')
    || (identity.packageDigest !== null && typeof identity.packageDigest !== 'string')
    || (identity.version !== null && typeof identity.version !== 'string')
    || (identity.readbackDigest !== null && typeof identity.readbackDigest !== 'string')
    || typeof identity.enabled !== 'boolean') {
    throw violation('E_CAPABILITY_IDENTITY', 'Plugin identity fields are invalid');
  }
  const digests = [identity.packageDigest, identity.readbackDigest].filter((value): value is string => value !== null);
  if (digests.some((digest) => !/^[a-f0-9]{64}$/u.test(digest))) throw violation('E_CAPABILITY_IDENTITY', 'Plugin identity digest is invalid');
  if ((identity.status === 'absent' || identity.status === 'unknown')
    && (identity.realpath !== null || identity.packageDigest !== null || identity.version !== null || identity.readbackDigest !== null || identity.enabled)) {
    throw violation('E_CAPABILITY_IDENTITY', 'Non-present plugin identity must be explicit');
  }
  if (identity.status === 'present' && (identity.realpath === null
    || !isAbsoluteHostPath(identity.realpath, platform)
    || identity.packageDigest === null || identity.version === null || identity.readbackDigest === null)) {
    throw violation('E_CAPABILITY_IDENTITY', 'Present plugin identity is incomplete');
  }
}

function compareObservation(left: CapabilityObservationV1, right: CapabilityObservationV1): number {
  return compareUtf8(left.capability, right.capability) || compareUtf8(left.source, right.source)
    || compareUtf8(left.observedAt, right.observedAt) || compareUtf8(left.result, right.result)
    || compareUtf8(left.tier, right.tier) || compareUtf8(left.detailCode, right.detailCode)
    || compareUtf8(left.identityDigest, right.identityDigest) || compareUtf8(left.diagnostic ?? '', right.diagnostic ?? '');
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function tierRank(tier: EvidenceTier): number { return EVIDENCE_TIERS.indexOf(tier); }
function minTier(left: EvidenceTier, right: EvidenceTier): EvidenceTier { return tierRank(left) <= tierRank(right) ? left : right; }
function digestOf(value: unknown): string { return crypto.createHash('sha256').update(canonicalBytesV1(value)).digest('hex'); }
function canonicalEqual(left: unknown, right: unknown): boolean { return canonicalBytesV1(left).equals(canonicalBytesV1(right)); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function assertKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw violation('E_CAPABILITY_PROFILE', `${label} keys are invalid`);
}
function safeRouteField(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\0\r\n]/u.test(value) && value.trim() === value;
}
export function isAbsoluteHostPath(value: string, platform: string): boolean {
  return value.length > 0 && value.length <= 4096 && !/[\0\r\n]/u.test(value)
    && (platform === 'win32' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value));
}
function isPortableAbsolutePath(value: string): boolean {
  return isAbsoluteHostPath(value, 'win32') || isAbsoluteHostPath(value, 'linux');
}
function secretLike(value: string): boolean { return /(?:authorization|cookie|token|secret|password)\s*[=:]\s*(?!<redacted>|\[redacted\])\S+/iu.test(value); }
function violation(code: string, message: string): ContractViolation { return new ContractViolation(code, message); }
