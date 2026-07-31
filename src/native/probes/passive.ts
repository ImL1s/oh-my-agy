import {
  CapabilityObservationV1,
  HOST_CAPABILITY_POLICY_REGISTRY_V1,
  HostCapabilityProfileV1,
  HostIdentityV1,
  PluginIdentityV1,
  assembleHostCapabilityProfile,
  hostCapabilityIdentityDigest,
} from '../capability-profile';
import { ProbeResultV1 } from './types';

export interface PassiveProfileAssemblyInputV1 {
  evaluationTimestamp: string;
  hostIdentityBefore: HostIdentityV1;
  hostIdentityAfter: HostIdentityV1;
  pluginIdentityBefore: PluginIdentityV1;
  pluginIdentityAfter: PluginIdentityV1;
  probeResults: readonly ProbeResultV1[];
}

/**
 * Passive assembly performs no host mutation or live call. Callers supply both
 * identity fences so drift is represented as unknown/non-cacheable.
 */
export function assemblePassiveHostCapabilityProfile(
  input: Readonly<PassiveProfileAssemblyInputV1>,
): HostCapabilityProfileV1 {
  const observations = completePassiveObservationCoverage(
    input.probeResults.flatMap(({ observations }) => observations),
    input.evaluationTimestamp,
    hostCapabilityIdentityDigest(input.hostIdentityAfter, input.pluginIdentityAfter),
  );
  return assembleHostCapabilityProfile({
    evaluationTimestamp: input.evaluationTimestamp,
    hostIdentityBefore: input.hostIdentityBefore,
    hostIdentityAfter: input.hostIdentityAfter,
    pluginIdentityBefore: input.pluginIdentityBefore,
    pluginIdentityAfter: input.pluginIdentityAfter,
    observations,
    cacheable: input.probeResults.every(({ cacheable }) => cacheable),
  });
}

export function completePassiveObservationCoverage(
  observations: readonly CapabilityObservationV1[],
  observedAt: string,
  identityDigest: string,
): CapabilityObservationV1[] {
  const covered = new Set(observations.map(({ capability }) => capability));
  const missing = HOST_CAPABILITY_POLICY_REGISTRY_V1
    .filter(({ key }) => !covered.has(key))
    .map((policy): CapabilityObservationV1 => ({
      capability: policy.key,
      source: (Object.keys(policy.sourceCeilings).find((source) => source !== 'live_probe') ?? 'help') as CapabilityObservationV1['source'],
      tier: 'configured',
      result: 'indeterminate',
      observedAt,
      identityDigest,
      detailCode: policy.sideEffect === 'passive-cache-only' ? 'PASSIVE_EVIDENCE_MISSING' : 'LIVE_OPT_IN_REQUIRED',
      diagnostic: null,
    }));
  return [...observations, ...missing];
}
