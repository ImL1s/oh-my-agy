import {
  HostIdentityV1,
  PluginIdentityV1,
  assembleHostCapabilityProfile,
} from '../../src/native/capability-profile';
import { sha256 } from '../../src/runtime/atomic';
import { ok } from '../../src/runtime/types';
import { TeamOrchestratorOptions } from '../../src/team/orchestrator';

/**
 * Test-only profile/router authority for Team integration fixtures.
 * It proves the synthetic harness, never live Antigravity host parity.
 */
export function headlessProviderRouteFactory(): NonNullable<TeamOrchestratorOptions['providerProfileFactory']> {
  return ({ selectedAt }) => {
    const host: HostIdentityV1 = {
      realpath: process.execPath,
      binarySha256: sha256('team-test-binary'),
      version: process.version,
      versionOutputSha256: sha256(process.version),
      helpOutputSha256: sha256('team-test-help'),
      platform: process.platform,
      arch: process.arch,
    };
    const plugin: PluginIdentityV1 = {
      status: 'absent',
      realpath: null,
      packageDigest: null,
      version: null,
      readbackDigest: null,
      enabled: false,
    };
    const identity = assembleHostCapabilityProfile({
      evaluationTimestamp: selectedAt,
      hostIdentityBefore: host,
      hostIdentityAfter: host,
      pluginIdentityBefore: plugin,
      pluginIdentityAfter: plugin,
      observations: [],
    }).identityDigest;
    const profile = assembleHostCapabilityProfile({
      evaluationTimestamp: selectedAt,
      hostIdentityBefore: host,
      hostIdentityAfter: host,
      pluginIdentityBefore: plugin,
      pluginIdentityAfter: plugin,
      observations: ['headless.print', 'headless.json'].map((capability) => ({
        capability,
        source: 'live_probe' as const,
        tier: 'healthy' as const,
        result: 'positive' as const,
        observedAt: selectedAt,
        identityDigest: identity,
        detailCode: 'TEAM_TEST_HARNESS_VERIFIED',
        diagnostic: null,
      })),
    });
    return ok({
      profile,
      resolvedExecutable: host.realpath,
    });
  };
}
