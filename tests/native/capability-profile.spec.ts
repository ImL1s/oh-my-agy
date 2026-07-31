import * as crypto from 'crypto';
import { canonicalBytesV1 } from '../../src/contracts/state-schemas';
import {
  HOST_CAPABILITY_POLICY_REGISTRY_V1,
  TEAM_PROVIDER_POLICY_V1,
  HostCapabilityProfileV1,
  HostIdentityV1,
  PluginIdentityV1,
  assembleHostCapabilityProfile,
  canonicalHostCapabilityProfile,
  hostCapabilityIdentityDigest,
  issueHostRouteReceipt,
  routeHostCapability,
  validateCapabilityPolicyRegistry,
  validateHostCapabilityProfile,
  validateHostRouteCandidate,
  validateHostRouteReceipt,
} from '../../src/native/capability-profile';

const NOW = '2026-07-31T12:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const CONTEXT = 'c'.repeat(64);

const host: HostIdentityV1 = {
  realpath: '/usr/local/bin/agy', binarySha256: HASH_A, version: '1.1.9',
  versionOutputSha256: HASH_B, helpOutputSha256: 'c'.repeat(64), platform: 'darwin', arch: 'arm64',
};
const plugin: PluginIdentityV1 = {
  status: 'present', realpath: '/tmp/plugin', packageDigest: HASH_A,
  version: '1.0.0', readbackDigest: HASH_B, enabled: true,
};

function profile(observations: Parameters<typeof assembleHostCapabilityProfile>[0]['observations'] = []): HostCapabilityProfileV1 {
  return assembleHostCapabilityProfile({
    evaluationTimestamp: NOW,
    hostIdentityBefore: host,
    hostIdentityAfter: host,
    pluginIdentityBefore: plugin,
    pluginIdentityAfter: plugin,
    observations,
  });
}

function observation(
  result: 'positive' | 'negative' | 'indeterminate',
  source: 'help' | 'live_probe' = 'help',
  tier: 'observed' | 'verified' = source === 'help' ? 'observed' : 'verified',
) {
  return {
    capability: 'headless.print', source, tier, result, observedAt: NOW,
    identityDigest: hostCapabilityIdentityDigest(host, plugin), detailCode: result.toUpperCase(), diagnostic: null,
  } as const;
}

function resignProfile(profileValue: HostCapabilityProfileV1): HostCapabilityProfileV1 {
  const copy = JSON.parse(JSON.stringify(profileValue)) as HostCapabilityProfileV1;
  const { profileDigest: _ignored, ...withoutDigest } = copy;
  copy.profileDigest = crypto.createHash('sha256').update(canonicalBytesV1(withoutDigest)).digest('hex');
  return copy;
}

function resignCandidate<T extends { candidateDigest: string }>(candidateValue: T): T {
  const copy = JSON.parse(JSON.stringify(candidateValue)) as T;
  const { candidateDigest: _ignored, ...withoutDigest } = copy;
  copy.candidateDigest = crypto.createHash('sha256').update(canonicalBytesV1(withoutDigest)).digest('hex');
  return copy;
}

describe('HostCapabilityProfileV1', () => {
  it('freezes the complete canonical registry', () => {
    expect(validateCapabilityPolicyRegistry()).toHaveLength(55);
    expect(HOST_CAPABILITY_POLICY_REGISTRY_V1.map(({ key }) => key)).toEqual(
      [...HOST_CAPABILITY_POLICY_REGISTRY_V1.map(({ key }) => key)].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
    );
    expect(() => validateCapabilityPolicyRegistry(HOST_CAPABILITY_POLICY_REGISTRY_V1.slice(1))).toThrow(/registry key set/);
    expect(HOST_CAPABILITY_POLICY_REGISTRY_V1.every(({ evidencePredicates, aggregation, limits }) =>
      evidencePredicates.affirmativeNegative === 'result_negative_same_identity'
        && aggregation === 'indeterminate_or_contradiction_unknown'
        && Object.values(limits).every((value) => value > 0))).toBe(true);
    expect(HOST_CAPABILITY_POLICY_REGISTRY_V1.find(({ key }) => key === 'headless.print')?.limits.timeoutMs).toBe(60_000);
    expect(HOST_CAPABILITY_POLICY_REGISTRY_V1.find(({ key }) => key === 'headless.json')?.limits.timeoutMs).toBe(60_000);
    expect(HOST_CAPABILITY_POLICY_REGISTRY_V1.find(({ key }) => key === 'hook.stop')?.limits.timeoutMs).toBe(5_000);
    expect(TEAM_PROVIDER_POLICY_V1.antigravity_native).toMatchObject({ adapterImplemented: false });
    expect(TEAM_PROVIDER_POLICY_V1.agy_headless).not.toHaveProperty('oneOf');
  });

  it('is deterministic for observation permutations at the injected time', () => {
    const observations = [observation('positive'), observation('positive', 'live_probe')];
    const left = profile(observations);
    const right = profile([...observations].reverse());
    expect(canonicalHostCapabilityProfile(left)).toBe(canonicalHostCapabilityProfile(right));
    expect(left.profileDigest).toBe(right.profileDigest);
  });

  it('keeps unknown distinct from affirmative unsupported', () => {
    const unknown = profile([observation('indeterminate')]).capabilities.find(({ key }) => key === 'headless.print');
    const unsupported = profile([observation('negative')]).capabilities.find(({ key }) => key === 'headless.print');
    expect(unknown).toMatchObject({ outcome: 'unknown', supported: false });
    expect(unsupported).toMatchObject({ outcome: 'unsupported', supported: false, tier: 'observed', source: 'help' });
  });

  it('caps help evidence and makes passive/live contradictions unknown', () => {
    const capped = profile([{ ...observation('positive'), tier: 'verified' }]);
    expect(capped.capabilities.find(({ key }) => key === 'headless.print')).toMatchObject({ tier: 'observed' });
    const contradiction = profile([observation('positive'), observation('negative', 'live_probe')]);
    expect(contradiction.capabilities.find(({ key }) => key === 'headless.print')).toMatchObject({
      outcome: 'unknown', diagnostics: expect.arrayContaining(['CONTRADICTORY_EVIDENCE']),
    });
  });

  it('rejects projection inconsistencies, extra keys, future evidence, and identity drift', () => {
    const valid = profile();
    const inconsistent = JSON.parse(JSON.stringify(valid)) as HostCapabilityProfileV1;
    inconsistent.capabilities[0].supported = true;
    expect(() => validateHostCapabilityProfile(inconsistent)).toThrow(/projection/);
    expect(() => validateHostCapabilityProfile({ ...valid, extra: true })).toThrow(/keys/);
    expect(() => profile([{ ...observation('positive'), observedAt: '2026-07-31T12:00:01.000Z' }])).toThrow(/later/);
    const drifted = assembleHostCapabilityProfile({
      evaluationTimestamp: NOW, hostIdentityBefore: host, hostIdentityAfter: { ...host, binarySha256: HASH_B },
      pluginIdentityBefore: plugin, pluginIdentityAfter: plugin, observations: [],
    });
    expect(drifted).toMatchObject({ identityStatus: 'drifted', cacheable: false });
    expect(drifted.capabilities.every(({ outcome }) => outcome === 'unknown')).toBe(true);
  });

  it('accepts Windows absolute host, plugin, and route paths only for win32 identities', () => {
    const windowsHost: HostIdentityV1 = {
      ...host,
      realpath: 'C:\\Program Files\\Antigravity\\agy.exe',
      platform: 'win32',
      arch: 'x64',
    };
    const windowsPlugin: PluginIdentityV1 = {
      ...plugin,
      realpath: 'C:\\Users\\tester\\.gemini\\config\\plugins\\oh-my-agy',
    };
    const empty = assembleHostCapabilityProfile({
      evaluationTimestamp: NOW,
      hostIdentityBefore: windowsHost,
      hostIdentityAfter: windowsHost,
      pluginIdentityBefore: windowsPlugin,
      pluginIdentityAfter: windowsPlugin,
      observations: [],
    });
    const routed = assembleHostCapabilityProfile({
      evaluationTimestamp: NOW,
      hostIdentityBefore: windowsHost,
      hostIdentityAfter: windowsHost,
      pluginIdentityBefore: windowsPlugin,
      pluginIdentityAfter: windowsPlugin,
      observations: [{
        capability: 'headless.print', source: 'live_probe', tier: 'healthy', result: 'positive',
        observedAt: NOW, identityDigest: empty.identityDigest, detailCode: 'WINDOWS_LIVE_OK', diagnostic: null,
      }],
    });
    const candidate = routeHostCapability(routed, {
      capability: 'headless.print', provider: 'agy_headless', requestMode: 'headless', generation: 1,
      contextDigest: CONTEXT, selectedAt: NOW, ttlMs: 5_000, fallbackPreconditionsSatisfied: true,
    });
    const receipt = issueHostRouteReceipt(candidate, windowsHost.realpath, 'agy_headless_v1');
    expect(validateHostRouteReceipt(receipt, routed, {
      now: NOW, generation: 1, contextDigest: CONTEXT,
      identityDigest: routed.identityDigest, fallbackPreconditionsSatisfied: true,
    })).toEqual(receipt);
    expect(() => assembleHostCapabilityProfile({
      evaluationTimestamp: NOW,
      hostIdentityBefore: { ...windowsHost, platform: 'darwin' },
      hostIdentityAfter: { ...windowsHost, platform: 'darwin' },
      pluginIdentityBefore: windowsPlugin,
      pluginIdentityAfter: windowsPlugin,
      observations: [],
    })).toThrow(/Host identity is invalid/);
  });

  it('recomputes evidence projections and rejects a resigned forged route profile', () => {
    const forged = profile();
    const assessment = forged.capabilities.find(({ key }) => key === 'headless.print');
    expect(assessment).toBeDefined();
    Object.assign(assessment as NonNullable<typeof assessment>, {
      outcome: 'supported',
      supported: true,
      tier: 'verified',
      source: 'live_probe',
    });
    const resigned = resignProfile(forged);
    expect(() => validateHostCapabilityProfile(resigned)).toThrow(/projection is inconsistent with evidence/);
    expect(() => routeHostCapability(resigned, {
      capability: 'headless.print', provider: 'agy_headless', requestMode: 'headless', generation: 0,
      contextDigest: CONTEXT, selectedAt: NOW, ttlMs: 5_000, fallbackPreconditionsSatisfied: true,
    })).toThrow(/projection is inconsistent with evidence/);
  });

  it('rejects resigned forged freshness and non-canonical observation fields', () => {
    const forgedFreshness = profile([observation('positive')]);
    forgedFreshness.freshness.oldestObservationAt = null;
    expect(() => validateHostCapabilityProfile(resignProfile(forgedFreshness))).toThrow(/freshness projection/);

    const forgedObservation = profile([observation('positive')]);
    const assessment = forgedObservation.capabilities.find(({ key }) => key === 'headless.print');
    expect(assessment).toBeDefined();
    Object.assign((assessment as NonNullable<typeof assessment>).observations[0], { result: 'trusted' });
    expect(() => validateHostCapabilityProfile(resignProfile(forgedObservation))).toThrow(/observation fields/);
  });

  it('binds candidates and receipts and rejects tamper and expiry', () => {
    const routedProfile = profile([observation('positive', 'live_probe')]);
    const candidate = routeHostCapability(routedProfile, {
      capability: 'headless.print', provider: 'agy_headless', requestMode: 'headless', generation: 2,
      contextDigest: CONTEXT, selectedAt: NOW, ttlMs: 5_000, fallbackPreconditionsSatisfied: true,
    });
    const expected = { now: '2026-07-31T12:00:01.000Z', generation: 2, contextDigest: CONTEXT, identityDigest: routedProfile.identityDigest };
    expect(validateHostRouteCandidate(candidate, routedProfile, expected)).toEqual(candidate);
    expect(() => validateHostRouteCandidate({ ...candidate, provider: 'tampered' }, routedProfile, expected)).toThrow(/tampered/);
    expect(() => validateHostRouteCandidate(candidate, routedProfile, { ...expected, now: '2026-07-31T12:00:06.000Z' })).toThrow(/expired/);
    const receipt = issueHostRouteReceipt(candidate, '/usr/local/bin/agy', 'headless');
    expect(validateHostRouteReceipt(receipt, routedProfile, { ...expected, fallbackPreconditionsSatisfied: true })).toEqual(receipt);
    expect(() => validateHostRouteReceipt({ ...receipt, adapter: 'other' }, routedProfile, { ...expected, fallbackPreconditionsSatisfied: true })).toThrow(/tampered/);
    const wrongExecutable = issueHostRouteReceipt(candidate, '/tmp/forged-agy', 'headless');
    expect(() => validateHostRouteReceipt(wrongExecutable, routedProfile, {
      ...expected, fallbackPreconditionsSatisfied: true,
    })).toThrow(/tampered/);

    const staleSelection = resignCandidate({
      ...candidate,
      selectedAt: '2026-07-31T12:02:00.000Z',
      expiresAt: '2026-07-31T12:02:05.000Z',
    });
    expect(() => validateHostRouteCandidate(staleSelection, routedProfile, {
      ...expected, now: '2026-07-31T12:02:01.000Z',
    })).toThrow(/tampered/);

    const nearlyStaleEvidence = profile([{
      ...observation('positive', 'live_probe'),
      observedAt: '2026-07-31T11:59:01.000Z',
    }]);
    expect(() => routeHostCapability(nearlyStaleEvidence, {
      capability: 'headless.print', provider: 'agy_headless', requestMode: 'headless', generation: 2,
      contextDigest: CONTEXT, selectedAt: NOW, ttlMs: 5_000, fallbackPreconditionsSatisfied: true,
    })).toThrow(/evidence expires/);

    const afterSlowCanary = '2026-07-31T12:00:45.000Z';
    const refreshedAfterSlowCanary = assembleHostCapabilityProfile({
      evaluationTimestamp: afterSlowCanary,
      hostIdentityBefore: host,
      hostIdentityAfter: host,
      pluginIdentityBefore: plugin,
      pluginIdentityAfter: plugin,
      observations: [
        observation('positive'),
        { ...observation('positive', 'live_probe'), observedAt: afterSlowCanary },
      ],
    });
    expect(routeHostCapability(refreshedAfterSlowCanary, {
      capability: 'headless.print', provider: 'agy_headless', requestMode: 'headless', generation: 3,
      contextDigest: CONTEXT, selectedAt: afterSlowCanary, ttlMs: 35_000,
      fallbackPreconditionsSatisfied: true,
    })).toMatchObject({ selectedAt: afterSlowCanary, expiresAt: '2026-07-31T12:01:20.000Z' });
  });

  it('invalidates cache identity when policy version alone changes', () => {
    const first = profile();
    const second = assembleHostCapabilityProfile({
      evaluationTimestamp: NOW, hostIdentityBefore: host, hostIdentityAfter: host,
      pluginIdentityBefore: plugin, pluginIdentityAfter: plugin, observations: [], policyVersion: 2,
    });
    expect(second.cacheKey).not.toBe(first.cacheKey);
    expect(second.profileDigest).not.toBe(first.profileDigest);
  });
});
