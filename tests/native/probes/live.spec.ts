import {
  LIVE_CAPABILITY_PROBE_PLAN_V1,
  completeLiveCapabilityProbeCoverage,
  runExplicitLiveProbe,
} from '../../../src/native/probes/live';
import { LiveProbeContextV1 } from '../../../src/native/probes/types';
import { absentPluginIdentity } from '../../../src/native/probes/identity';

const context: LiveProbeContextV1 = {
  mode: 'live', liveOptIn: true, evaluationTimestamp: '2026-07-31T12:00:00.000Z', identityDigest: 'd'.repeat(64),
  hostIdentity: { realpath: '/agy', binarySha256: 'a'.repeat(64), version: null, versionOutputSha256: 'b'.repeat(64), helpOutputSha256: 'c'.repeat(64), platform: 'darwin', arch: 'arm64' },
  pluginIdentity: absentPluginIdentity(),
};

describe('explicit live probe', () => {
  it('defines a bounded plan for every non-passive live-capable domain', () => {
    expect(new Set(LIVE_CAPABILITY_PROBE_PLAN_V1.map(({ sideEffect }) => sideEffect))).toEqual(
      new Set(['agent', 'artifact_review', 'conversation', 'hook', 'mcp', 'model', 'sidecar']),
    );
    expect(LIVE_CAPABILITY_PROBE_PLAN_V1.every(({ timeoutMs, maximumOutputBytes }) => timeoutMs > 0 && maximumOutputBytes > 0)).toBe(true);
    const coverage = completeLiveCapabilityProbeCoverage([], context);
    expect(new Set(coverage.map(({ capability }) => capability))).toEqual(
      new Set(LIVE_CAPABILITY_PROBE_PLAN_V1.map(({ capability }) => capability)),
    );
    expect(coverage.every(({ result, source, detailCode }) =>
      result === 'indeterminate' && source === 'live_probe' && detailCode.endsWith('_PROBE_UNAVAILABLE'))).toBe(true);

    const passiveDoesNotSuppressLiveCoverage = completeLiveCapabilityProbeCoverage([{
      capability: 'hook.stop',
      source: 'plugin_readback',
      tier: 'loadable',
      result: 'positive',
      observedAt: context.evaluationTimestamp,
      identityDigest: context.identityDigest,
      detailCode: 'HOOK_REGISTERED',
      diagnostic: null,
    }], context);
    expect(passiveDoesNotSuppressLiveCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capability: 'hook.stop',
        source: 'live_probe',
        result: 'indeterminate',
        detailCode: 'LIVE_HOOK_PROBE_UNAVAILABLE',
      }),
    ]));
  });
  it('requires explicit opt-in and preserves malformed/timeout as indeterminate', async () => {
    await expect(runExplicitLiveProbe({ live: false, executable: '/agy', argv: [], capability: 'headless.print', expectedToken: 'ok', context })).rejects.toThrow(/OPT_IN/);
    const malformed = await runExplicitLiveProbe({ live: true, executable: '/agy', argv: [], capability: 'headless.print', expectedToken: 'ok', context, runner: async () => ({ status: 0, signal: null, stdout: 'deceptive', stderr: '', timedOut: false, outputOverflow: false }) });
    expect(malformed.observations[0]).toMatchObject({ result: 'indeterminate', detailCode: 'LIVE_MALFORMED' });
    const timeout = await runExplicitLiveProbe({ live: true, executable: '/agy', argv: [], capability: 'headless.print', expectedToken: 'ok', context, runner: async () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true, outputOverflow: false }) });
    expect(timeout).toMatchObject({ cacheable: false, detailCode: 'LIVE_TIMEOUT' });
  });

  it('accepts only an exact successful Antigravity JSON terminal response', async () => {
    const request = {
      live: true,
      executable: '/agy',
      argv: [],
      capability: 'headless.json',
      expectedToken: 'canary',
      outputContract: 'agy_json' as const,
      context,
    };
    const verified = await runExplicitLiveProbe({
      ...request,
      runner: async () => ({
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          conversation_id: 'conversation',
          status: 'SUCCESS',
          response: 'canary',
          error: null,
        }),
        stderr: '',
        timedOut: false,
        outputOverflow: false,
      }),
    });
    expect(verified).toMatchObject({ cacheable: true, detailCode: 'LIVE_VERIFIED' });
    for (const stdout of [
      JSON.stringify({ conversation_id: 'conversation', status: 'ERROR', response: 'canary' }),
      JSON.stringify({ conversation_id: 'conversation', status: 'SUCCESS', response: 'near-canary' }),
      'not-json',
    ]) {
      const rejected = await runExplicitLiveProbe({
        ...request,
        runner: async () => ({
          status: 0,
          signal: null,
          stdout,
          stderr: '',
          timedOut: false,
          outputOverflow: false,
        }),
      });
      expect(rejected).toMatchObject({ cacheable: false, detailCode: 'LIVE_MALFORMED' });
    }
  });
});
