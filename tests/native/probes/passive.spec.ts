import { HOST_CAPABILITY_POLICY_REGISTRY_V1, HostIdentityV1, hostCapabilityIdentityDigest } from '../../../src/native/capability-profile';
import { absentPluginIdentity } from '../../../src/native/probes/identity';
import { assemblePassiveHostCapabilityProfile, completePassiveObservationCoverage } from '../../../src/native/probes/passive';

const host: HostIdentityV1 = { realpath: '/agy', binarySha256: 'a'.repeat(64), version: null, versionOutputSha256: 'b'.repeat(64), helpOutputSha256: 'c'.repeat(64), platform: 'darwin', arch: 'arm64' };
const plugin = absentPluginIdentity();

describe('passive probe plan', () => {
  it('emits explicit fail-closed coverage for every registry capability', () => {
    const observations = completePassiveObservationCoverage([], '2026-07-31T12:00:00.000Z', hostCapabilityIdentityDigest(host, plugin));
    expect(observations.map(({ capability }) => capability).sort()).toEqual(HOST_CAPABILITY_POLICY_REGISTRY_V1.map(({ key }) => key).sort());
    expect(observations.every(({ result }) => result === 'indeterminate')).toBe(true);
  });

  it('makes any failed bounded passive probe non-cacheable', () => {
    const profile = assemblePassiveHostCapabilityProfile({
      evaluationTimestamp: '2026-07-31T12:00:00.000Z', hostIdentityBefore: host, hostIdentityAfter: host,
      pluginIdentityBefore: plugin, pluginIdentityAfter: plugin,
      probeResults: [{ observations: [], cacheable: false, detailCode: 'HELP_TIMEOUT' }],
    });
    expect(profile.cacheable).toBe(false);
    expect(profile.capabilities.every(({ outcome }) => outcome === 'unknown')).toBe(true);
  });
});
