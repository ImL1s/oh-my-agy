import {
  parseHookManifestReadback,
  parsePluginReadback,
} from '../../../src/native/probes/plugin-readback';
import { PassiveProbeContextV1 } from '../../../src/native/probes/types';
import { absentPluginIdentity } from '../../../src/native/probes/identity';

const context: PassiveProbeContextV1 = {
  mode: 'passive', evaluationTimestamp: '2026-07-31T12:00:00.000Z', identityDigest: 'd'.repeat(64),
  hostIdentity: { realpath: '/agy', binarySha256: 'a'.repeat(64), version: null, versionOutputSha256: 'b'.repeat(64), helpOutputSha256: 'c'.repeat(64), platform: 'darwin', arch: 'arm64' },
  pluginIdentity: absentPluginIdentity(),
};

describe('plugin readback', () => {
  it('classifies present and affirmative absent fields', () => {
    const result = parsePluginReadback('{"skills":[],"hooks.json":{},"mcp_config":true}', context);
    expect(result.observations.find(({ capability }) => capability === 'plugin.skills')?.result).toBe('positive');
    expect(result.observations.find(({ capability }) => capability === 'plugin.rules')?.result).toBe('negative');
    expect(result.observations.find(({ capability }) => capability === 'plugin.mcp_config')?.result).toBe('positive');
    expect(result.observations.find(({ capability }) => capability === 'mcp.local_config')?.result).toBe('positive');
  });

  it('treats malformed and oversized JSON as indeterminate', () => {
    expect(parsePluginReadback('{token=secret}', context)).toMatchObject({ cacheable: false, detailCode: 'PLUGIN_READBACK_MALFORMED' });
    expect(parsePluginReadback('x'.repeat(300_000), context)).toMatchObject({ cacheable: false, detailCode: 'PLUGIN_READBACK_OVERFLOW' });
  });

  it('reports only exact registered public hooks and never promotes mere manifest presence', () => {
    const result = parseHookManifestReadback(JSON.stringify({
      runtime: {
        PreInvocation: [{ type: 'command', command: 'node pre.js' }],
        Stop: [{ type: 'command', command: 'node stop.js' }],
      },
    }), context);
    expect(result.observations.find(({ capability }) => capability === 'hook.pre_invocation'))
      .toMatchObject({ result: 'positive', tier: 'loadable', detailCode: 'HOOK_REGISTERED' });
    expect(result.observations.find(({ capability }) => capability === 'hook.stop'))
      .toMatchObject({ result: 'positive', tier: 'loadable', detailCode: 'HOOK_REGISTERED' });
    expect(result.observations.find(({ capability }) => capability === 'hook.pre_tool_use'))
      .toMatchObject({ result: 'indeterminate', tier: 'configured' });
    expect(parseHookManifestReadback('{broken', context)).toMatchObject({
      cacheable: false,
      detailCode: 'HOOK_MANIFEST_MALFORMED',
    });
  });
});
