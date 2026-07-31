import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  HostCapabilityProfileV1,
  HostRouteCandidateV1,
  HostRouteReceiptV1,
  EVIDENCE_TIERS,
  HOST_CAPABILITY_POLICY_REGISTRY_V1,
  TEAM_PROVIDER_POLICY_V1,
  issueHostRouteReceipt,
  isAbsoluteHostPath,
  routeHostCapability,
  validateHostCapabilityProfile,
  validateHostRouteCandidate,
  validateHostRouteReceipt,
} from '../native/capability-profile';
import { canonicalJson, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { WorkerProvider } from '../contracts/worker-envelope';
import { AGY_REQUIRED_HELP_FLAGS, AGY_WORKER_VERSION, validateAgy115Help } from './agy-argv';

const TEAM_ROUTE_RECEIPT_MAX_TTL_MS = 30_000;
const TEAM_ROUTE_RECEIPT_MIN_TTL_MS = 5_000;

export interface AgyCanaryReceiptV1 {
  schemaVersion: 1;
  kind: 'headless_exit' | 'interactive_attach';
  argvHash: string;
  exitCode: number | null;
  attachable: boolean;
  orphanFree: boolean;
  observedAtMs: number;
}

/** Passive argv-compatibility observation. It is never provider authority. */
export interface AgyCliProbeV1 {
  schemaVersion: 1;
  installed: boolean;
  executableRealpath: string;
  executableSha256: string;
  version: string;
  versionOutputHash: string;
  helpOutputHash: string;
  requiredFlags: readonly string[];
  observedAtMs: number;
  headlessCanary?: AgyCanaryReceiptV1;
  interactiveCanary?: AgyCanaryReceiptV1;
}

export interface SelectProviderInputV1 {
  profile: HostCapabilityProfileV1;
  candidate: HostRouteCandidateV1;
  now: string;
  generation: number;
  contextDigest: string;
  identityDigest: string;
  resolvedExecutable: string;
  fallbackPreconditionsSatisfied: boolean;
  tmuxReadiness?: TmuxReadinessReceiptV1;
}

export interface RouteTeamWorkerProviderInputV1 {
  profile: HostCapabilityProfileV1;
  launchMode: 'headless' | 'interactive';
  now: string;
  generation: number;
  contextDigest: string;
  resolvedExecutable: string;
  tmuxReadiness?: TmuxReadinessReceiptV1;
}

export interface TmuxReadinessReceiptV1 {
  schema: 'oma.tmux-readiness/v1';
  explicitlyEnabled: true;
  tmuxObserved: true;
  interactiveCanaryAttachable: true;
  orphanFree: true;
  observedAt: string;
  expiresAt: string;
  receiptDigest: string;
}

/**
 * Converts profile truth (and, for tmux, an explicit bounded canary receipt)
 * into the boolean consumed by the canonical router. Callers cannot replace
 * this check with a literal `true` without losing validation.
 */
export function validateProviderRoutePreconditions(
  profileValue: unknown,
  launchMode: 'headless' | 'interactive',
  now: string,
  tmuxReadiness?: Readonly<TmuxReadinessReceiptV1>,
): Result<true, RuntimeError> {
  let profile: HostCapabilityProfileV1;
  try { profile = validateHostCapabilityProfile(profileValue); } catch (error) {
    return err(capabilityError('Provider precondition profile is invalid', error));
  }
  const healthy = (key: string): boolean => {
    const assessment = profile.capabilities.find((item) => item.key === key);
    return assessment?.outcome === 'supported'
      && assessment.tier !== null
      && EVIDENCE_TIERS.indexOf(assessment.tier) >= EVIDENCE_TIERS.indexOf('healthy');
  };
  if (!healthy('headless.print')) {
    return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Headless print capability is not healthy'));
  }
  if (launchMode === 'headless') {
    return healthy('headless.stream_json') || healthy('headless.json')
      ? ok(true)
      : err(runtimeError('E_CAPABILITY_UNPROVEN', 'Headless structured output capability is not healthy'));
  }
  if (tmuxReadiness === undefined) {
    return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Interactive tmux requires an explicit bounded readiness canary'));
  }
  const { receiptDigest, ...withoutDigest } = tmuxReadiness;
  const valid = tmuxReadiness.schema === 'oma.tmux-readiness/v1'
    && tmuxReadiness.explicitlyEnabled
    && tmuxReadiness.tmuxObserved
    && tmuxReadiness.interactiveCanaryAttachable
    && tmuxReadiness.orphanFree
    && sha256(canonicalJson(withoutDigest)) === receiptDigest
    && Number.isFinite(Date.parse(tmuxReadiness.observedAt))
    && Date.parse(tmuxReadiness.observedAt) <= Date.parse(now)
    && Date.parse(tmuxReadiness.expiresAt) > Date.parse(now);
  return valid
    ? ok(true)
    : err(runtimeError('E_CAPABILITY_UNPROVEN', 'Interactive tmux readiness canary is invalid or stale'));
}

/**
 * The router candidate is the sole provider decision input. This selector only
 * validates that authority and the implemented adapter boundary, then issues a
 * receipt. It never reconstructs evidence or silently chooses another route.
 */
function selectWorkerProvider(
  input: Readonly<SelectProviderInputV1>,
): Result<HostRouteReceiptV1, RuntimeError> {
  let candidate: HostRouteCandidateV1;
  try {
    candidate = validateHostRouteCandidate(input.candidate, input.profile, {
      now: input.now,
      generation: input.generation,
      contextDigest: input.contextDigest,
      identityDigest: input.identityDigest,
    });
  } catch (error) {
    return err(capabilityError('Worker provider route candidate is invalid', error));
  }

  if (candidate.provider === 'antigravity_native') {
    return err(runtimeError(
      'E_NATIVE_ADAPTER_UNAVAILABLE',
      'Antigravity native worker adapter is unavailable',
      { provider: 'antigravity_native', adapterImplemented: false },
    ));
  }

  if (!isImplementedProvider(candidate.provider)
    || candidate.fallbackPreconditionsSatisfied !== input.fallbackPreconditionsSatisfied) {
    return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Worker provider adapter or fallback preconditions are unproven'));
  }
  const preconditions = validateProviderRoutePreconditions(
    input.profile,
    candidate.requestMode === 'headless' ? 'headless' : 'interactive',
    input.now,
    input.tmuxReadiness,
  );
  if (!preconditions.ok) return preconditions;
  if (candidate.provider === 'agy_headless' && candidate.requestMode !== 'headless') {
    return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Headless provider requires a headless route request'));
  }
  if (candidate.provider === 'tmux_agy'
    && (candidate.requestMode !== 'interactive' || !candidate.fallbackPreconditionsSatisfied)) {
    return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Tmux provider requires explicit interactive fallback authority'));
  }

  try {
    const receipt = issueHostRouteReceipt(
      candidate,
      input.resolvedExecutable,
      candidate.provider === 'agy_headless' ? 'agy_headless_v1' : 'tmux_agy_v1',
    );
    return ok(validateHostRouteReceipt(receipt, input.profile, {
      now: input.now,
      generation: input.generation,
      contextDigest: input.contextDigest,
      identityDigest: input.identityDigest,
      fallbackPreconditionsSatisfied: input.fallbackPreconditionsSatisfied,
    }));
  } catch (error) {
    return err(capabilityError('Worker provider route receipt is invalid', error));
  }
}

/**
 * Team 的唯一 provider router。它先評估宣告的 Antigravity native contract；
 * native 證據完整時若 adapter 尚未實作就明確失敗，不得靜默降級。只有
 * native contract 未獲證明時，才依 launch mode 評估既定 fallback 與 canary。
 */
export function preflightTeamWorkerProviderRoute(
  input: Readonly<RouteTeamWorkerProviderInputV1>,
): Result<void, RuntimeError> {
  const evaluated = evaluateTeamWorkerProviderRoute(input);
  return evaluated.ok ? ok(undefined) : evaluated;
}

export function routeTeamWorkerProvider(
  input: Readonly<RouteTeamWorkerProviderInputV1>,
): Result<HostRouteReceiptV1, RuntimeError> {
  const evaluated = evaluateTeamWorkerProviderRoute(input);
  if (!evaluated.ok) return evaluated;
  const { profile, provider, fallbackPreconditionsSatisfied, receiptTtlMs } = evaluated.value;

  try {
    const candidate = routeHostCapability(profile, {
      capability: 'headless.print',
      provider,
      requestMode: input.launchMode,
      generation: input.generation,
      contextDigest: input.contextDigest,
      selectedAt: input.now,
      ttlMs: receiptTtlMs,
      fallbackPreconditionsSatisfied,
    });
    return selectWorkerProvider({
      profile,
      candidate,
      now: input.now,
      generation: input.generation,
      contextDigest: input.contextDigest,
      identityDigest: profile.identityDigest,
      resolvedExecutable: input.resolvedExecutable,
      fallbackPreconditionsSatisfied,
      ...(input.tmuxReadiness === undefined ? {} : { tmuxReadiness: input.tmuxReadiness }),
    });
  } catch (error) {
    return err(capabilityError('Team provider route could not be issued', error));
  }
}

function evaluateTeamWorkerProviderRoute(
  input: Readonly<RouteTeamWorkerProviderInputV1>,
): Result<{
  profile: HostCapabilityProfileV1;
  provider: 'agy_headless' | 'tmux_agy';
  fallbackPreconditionsSatisfied: true;
  receiptTtlMs: number;
}, RuntimeError> {
  let profile: HostCapabilityProfileV1;
  try { profile = validateHostCapabilityProfile(input.profile); } catch (error) {
    return err(capabilityError('Team provider profile is invalid', error));
  }
  if (input.resolvedExecutable !== profile.hostIdentity.realpath
    || !isAbsoluteHostPath(input.resolvedExecutable, profile.hostIdentity.platform)) {
    return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Team provider executable is not bound to the host profile'));
  }

  const nativePolicy = TEAM_PROVIDER_POLICY_V1.antigravity_native;
  const nativeProven = nativePolicy.required.every(({ capability, tier }) =>
    capabilityProvenAtTier(profile, capability, tier, input.now));
  if (nativeProven && !nativePolicy.adapterImplemented) {
    return err(runtimeError(
      'E_NATIVE_ADAPTER_UNAVAILABLE',
      'Antigravity native worker adapter is unavailable',
      { provider: 'antigravity_native', adapterImplemented: false },
    ));
  }

  const provider = input.launchMode === 'headless' ? 'agy_headless' : 'tmux_agy';
  const fallbackPolicy = TEAM_PROVIDER_POLICY_V1[provider];
  const requiredProven = fallbackPolicy.required.every(({ capability, tier }) =>
    capabilityProvenAtTier(profile, capability, tier, input.now));
  const oneOfProven = 'oneOf' in fallbackPolicy
    ? fallbackPolicy.oneOf.some((capability) => capabilityProvenAtTier(profile, capability, 'healthy', input.now))
    : true;
  if (!requiredProven || !oneOfProven) {
    return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Team fallback provider requirements are unproven'));
  }
  const preconditions = validateProviderRoutePreconditions(
    profile,
    input.launchMode,
    input.now,
    input.tmuxReadiness,
  );
  if (!preconditions.ok) return preconditions;
  const receiptTtlMs = remainingRouteReceiptTtlMs(profile, 'headless.print', input.now);
  if (receiptTtlMs === null) {
    return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Team provider evidence is too close to expiry for bootstrap'));
  }
  return ok({
    profile,
    provider,
    fallbackPreconditionsSatisfied: preconditions.value,
    receiptTtlMs,
  });
}

function remainingRouteReceiptTtlMs(
  profile: Readonly<HostCapabilityProfileV1>,
  capability: string,
  now: string,
): number | null {
  const policy = HOST_CAPABILITY_POLICY_REGISTRY_V1.find(({ key }) => key === capability);
  const assessment = profile.capabilities.find(({ key }) => key === capability);
  const nowMs = Date.parse(now);
  if (policy === undefined || assessment === undefined || assessment.observations.length === 0
    || !Number.isFinite(nowMs)) return null;
  const evidenceExpiryMs = Math.min(
    Date.parse(profile.generatedAt) + policy.freshnessMs,
    ...assessment.observations.map(({ observedAt }) => Date.parse(observedAt) + policy.freshnessMs),
  );
  const ttlMs = Math.min(TEAM_ROUTE_RECEIPT_MAX_TTL_MS, evidenceExpiryMs - nowMs);
  return Number.isSafeInteger(ttlMs) && ttlMs >= TEAM_ROUTE_RECEIPT_MIN_TTL_MS ? ttlMs : null;
}

/** Bounded, read-only compatibility probe. It deliberately does not authorize routing. */
const AGY_PROBE_TIMEOUT_MS = 15_000;
export function probeAgy115(executable = 'agy', nowMs = Date.now()): Result<AgyCliProbeV1, RuntimeError> {
  const resolved = resolveExecutable(executable);
  if (resolved === null) return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Antigravity CLI executable is not installed'));
  const version = spawnSync(resolved, ['--version'], { encoding: 'utf8', timeout: AGY_PROBE_TIMEOUT_MS, shell: false });
  const help = spawnSync(resolved, ['--help'], { encoding: 'utf8', timeout: AGY_PROBE_TIMEOUT_MS, shell: false });
  if (version.status !== 0 || help.status !== 0 || version.error !== undefined || help.error !== undefined) {
    return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Antigravity CLI version/help compatibility probe failed'));
  }
  const versionOutput = `${version.stdout}${version.stderr}`;
  const helpOutput = `${help.stdout}${help.stderr}`;
  const valid = validateAgy115Help(versionOutput, helpOutput);
  if (!valid.ok) return valid;
  const bytes = fs.readFileSync(resolved);
  return ok({
    schemaVersion: 1,
    installed: true,
    executableRealpath: resolved,
    executableSha256: sha256(bytes),
    version: AGY_WORKER_VERSION,
    versionOutputHash: sha256(versionOutput),
    helpOutputHash: sha256(helpOutput),
    requiredFlags: [...AGY_REQUIRED_HELP_FLAGS],
    observedAtMs: nowMs,
  });
}

export function withVerifiedCanary(
  probe: Readonly<AgyCliProbeV1>,
  receipt: Readonly<AgyCanaryReceiptV1>,
): AgyCliProbeV1 {
  return receipt.kind === 'headless_exit'
    ? { ...probe, headlessCanary: { ...receipt } }
    : { ...probe, interactiveCanary: { ...receipt } };
}

function isImplementedProvider(value: string): value is Exclude<WorkerProvider, 'antigravity_native'> {
  return value === 'agy_headless' || value === 'tmux_agy';
}

function capabilityProvenAtTier(
  profile: Readonly<HostCapabilityProfileV1>,
  capability: string,
  requiredTier: typeof EVIDENCE_TIERS[number],
  now: string,
): boolean {
  const assessment = profile.capabilities.find(({ key }) => key === capability);
  const policy = HOST_CAPABILITY_POLICY_REGISTRY_V1.find(({ key }) => key === capability);
  const ageMs = Date.parse(now) - Date.parse(profile.generatedAt);
  return assessment?.outcome === 'supported'
    && assessment.tier !== null
    && policy !== undefined
    && EVIDENCE_TIERS.indexOf(assessment.tier) >= EVIDENCE_TIERS.indexOf(requiredTier)
    && ageMs >= 0
    && ageMs <= policy.freshnessMs
    && assessment.observations.every(({ observedAt }) => {
      const observationAgeMs = Date.parse(now) - Date.parse(observedAt);
      return observationAgeMs >= 0 && observationAgeMs <= policy.freshnessMs;
    });
}

function capabilityError(message: string, cause: unknown): RuntimeError {
  return runtimeError('E_CAPABILITY_UNPROVEN', message, {
    cause: cause instanceof Error ? cause.message : String(cause),
  });
}

function resolveExecutable(executable: string): string | null {
  if (path.isAbsolute(executable)) {
    try {
      const resolved = fs.realpathSync(executable);
      return fs.statSync(resolved).isFile() ? resolved : null;
    } catch (_) { return null; }
  }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue;
    const candidate = path.join(directory, executable);
    try {
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch (_) { /* continue */ }
  }
  return null;
}
