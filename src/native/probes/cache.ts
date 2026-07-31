import * as fs from 'fs';
import * as path from 'path';
import { ContractStateStore } from '../../runtime/state-store';
import { acquireOwnerLock, releaseOwnerLock } from '../../runtime/lock';
import {
  CapabilityAssessmentV1,
  CapabilityPolicyV1,
  EVIDENCE_TIERS,
  HOST_CAPABILITY_POLICY_REGISTRY_V1,
  HostCapabilityProfileV1,
  positiveCapabilityEvidenceExpiryMs,
  validateHostCapabilityProfile,
} from '../capability-profile';

export const HOST_CAPABILITY_CACHE_STORE_V1 = 'oma_host_capability_cache' as const;
export const HOST_CAPABILITY_CACHE_KEY_V1 = 'native/host-capability-profile-v1' as const;

export interface HostCapabilityProfileCacheSnapshotV1 {
  revision: number;
  profile: HostCapabilityProfileV1;
}

export class HostCapabilityProfileCacheV1 {
  private readonly store: ContractStateStore<HostCapabilityProfileV1>;

  constructor(stateRoot: string) {
    this.store = new ContractStateStore(stateRoot, {
      storeKind: HOST_CAPABILITY_CACHE_STORE_V1,
      validateValue: (value) => { validateHostCapabilityProfile(value); },
    });
  }

  read(expectedCacheKey: string, now = new Date().toISOString()): HostCapabilityProfileV1 | null {
    const snapshot = this.readSnapshot(expectedCacheKey);
    return snapshot !== null && isHostCapabilityProfileFresh(snapshot.profile, now)
      ? snapshot.profile
      : null;
  }

  readSnapshot(expectedCacheKey: string): HostCapabilityProfileCacheSnapshotV1 | null {
    const result = this.store.read(HOST_CAPABILITY_CACHE_KEY_V1);
    return result.ok && result.value.value.cacheKey === expectedCacheKey
      ? { revision: result.value.revision, profile: result.value.value }
      : null;
  }

  async commit(profile: HostCapabilityProfileV1): Promise<'created' | 'updated' | 'unchanged' | 'conflict'> {
    validateHostCapabilityProfile(profile);
    if (!profile.cacheable || profile.identityStatus !== 'matched') return 'conflict';
    const exactCachePath = path.join(this.store.root, `${HOST_CAPABILITY_CACHE_KEY_V1}.json`);
    let current = this.store.read(HOST_CAPABILITY_CACHE_KEY_V1);
    if (!current.ok && current.error.code === 'E_CORRUPT_STATE') {
      const lock = await acquireOwnerLock(`${exactCachePath}.lock`, { timeoutMs: 5_000 });
      if (!lock.ok) return 'conflict';
      try {
        current = this.store.read(HOST_CAPABILITY_CACHE_KEY_V1);
        if (!current.ok && current.error.code === 'E_CORRUPT_STATE') {
          fs.rmSync(exactCachePath, { force: true });
          current = this.store.read(HOST_CAPABILITY_CACHE_KEY_V1);
        }
      } finally {
        releaseOwnerLock(lock.value);
      }
      if (!current.ok && current.error.code === 'E_CORRUPT_STATE') return 'conflict';
    }
    if (!current.ok) {
      if (current.error.code === 'E_FUTURE_SCHEMA') return 'conflict';
      if (current.error.code !== 'E_NOT_FOUND') return 'conflict';
      const created = await this.store.create(HOST_CAPABILITY_CACHE_KEY_V1, profile);
      return created.ok ? 'created' : 'conflict';
    }
    if (current.value.value.profileDigest === profile.profileDigest) return 'unchanged';
    if (shouldPreserveCurrentAuthority(current.value.value, profile)) return 'unchanged';
    const updated = await this.store.compareAndSwap(
      HOST_CAPABILITY_CACHE_KEY_V1,
      current.value.revision,
      () => profile,
    );
    return updated.ok ? 'updated' : 'conflict';
  }

  async invalidate(
    expectedCacheKey: string,
    expectedSnapshot: Readonly<HostCapabilityProfileCacheSnapshotV1> | null,
  ): Promise<'removed' | 'unchanged' | 'conflict'> {
    if (expectedSnapshot === null) return 'unchanged';
    if (expectedSnapshot.profile.cacheKey !== expectedCacheKey) return 'conflict';
    const exactCachePath = path.join(this.store.root, `${HOST_CAPABILITY_CACHE_KEY_V1}.json`);
    const lock = await acquireOwnerLock(`${exactCachePath}.lock`, { timeoutMs: 5_000 });
    if (!lock.ok) return 'conflict';
    try {
      const current = this.store.read(HOST_CAPABILITY_CACHE_KEY_V1);
      if (!current.ok) {
        if (current.error.code === 'E_NOT_FOUND') return 'unchanged';
        return 'conflict';
      }
      if (current.value.value.cacheKey !== expectedCacheKey
        || current.value.revision !== expectedSnapshot.revision
        || current.value.value.profileDigest !== expectedSnapshot.profile.profileDigest) return 'conflict';
      fs.rmSync(exactCachePath, { force: true });
      return 'removed';
    } finally {
      releaseOwnerLock(lock.value);
    }
  }
}

export function isHostCapabilityProfileFresh(profileValue: unknown, now: string): boolean {
  let profile: HostCapabilityProfileV1;
  try { profile = validateHostCapabilityProfile(profileValue); } catch (_) { return false; }
  const nowMs = Date.parse(now);
  const generatedAtMs = Date.parse(profile.generatedAt);
  if (!Number.isFinite(nowMs) || nowMs < generatedAtMs
    || nowMs - generatedAtMs > profile.freshness.maximumAgeMs) return false;
  return profile.capabilities.every((assessment) => {
    const policy = HOST_CAPABILITY_POLICY_REGISTRY_V1.find(({ key }) => key === assessment.key);
    return policy !== undefined && isCapabilityAssessmentProjectionFresh(assessment, policy, nowMs);
  });
}

function isCapabilityAssessmentProjectionFresh(
  assessment: Readonly<CapabilityAssessmentV1>,
  policy: Readonly<CapabilityPolicyV1>,
  nowMs: number,
): boolean {
  if (assessment.outcome === 'unknown') return true;
  if (assessment.tier === null) return false;
  if (assessment.outcome === 'supported') {
    return positiveCapabilityEvidenceExpiryMs(assessment, policy, assessment.tier, nowMs) !== null;
  }
  const requiredTierRank = EVIDENCE_TIERS.indexOf(assessment.tier);
  return assessment.observations.some((observation) => {
    const ceiling = policy.sourceCeilings[observation.source];
    const observedAtMs = Date.parse(observation.observedAt);
    return observation.result === 'negative' && ceiling !== undefined
      && Math.min(EVIDENCE_TIERS.indexOf(observation.tier), EVIDENCE_TIERS.indexOf(ceiling))
        >= requiredTierRank
      && Number.isFinite(observedAtMs) && nowMs >= observedAtMs
      && nowMs - observedAtMs <= policy.freshnessMs;
  });
}

function shouldPreserveCurrentAuthority(
  current: Readonly<HostCapabilityProfileV1>,
  incoming: Readonly<HostCapabilityProfileV1>,
): boolean {
  if (current.cacheKey !== incoming.cacheKey
    || hasPositiveLiveAuthority(incoming)
    || !hasPositiveLiveAuthority(current)) return false;
  const comparisonTime = Date.parse(current.generatedAt) > Date.parse(incoming.generatedAt)
    ? current.generatedAt
    : incoming.generatedAt;
  return isHostCapabilityProfileFresh(current, comparisonTime);
}

function hasPositiveLiveAuthority(profile: Readonly<HostCapabilityProfileV1>): boolean {
  return profile.capabilities.some(({ observations }) => observations.some(({ source, result }) =>
    source === 'live_probe' && result === 'positive'));
}
