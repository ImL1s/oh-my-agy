import { absentPluginIdentity } from '../../../src/native/probes/identity';
import { probeStructuredInitOutput } from '../../../src/native/probes/structured-init';
import { LiveProbeContextV1 } from '../../../src/native/probes/types';

const context: LiveProbeContextV1 = {
  mode: 'live', liveOptIn: true, evaluationTimestamp: '2026-07-31T12:00:00.000Z',
  identityDigest: 'd'.repeat(64),
  hostIdentity: {
    realpath: '/agy', binarySha256: 'a'.repeat(64), version: null,
    versionOutputSha256: 'b'.repeat(64), helpOutputSha256: 'c'.repeat(64),
    platform: 'darwin', arch: 'arm64',
  },
  pluginIdentity: absentPluginIdentity(),
};

describe('structured init public JSON probe', () => {
  it('observes exact public fields and preserves unavailable domains as unknown evidence', () => {
    const result = probeStructuredInitOutput(JSON.stringify({
      conversation_id: 'conversation',
      model: 'gemini-test',
      sandbox: true,
    }), context);
    expect(result).toMatchObject({ cacheable: true, detailCode: 'STRUCTURED_INIT_PARSED' });
    expect(result.observations.find(({ capability }) => capability === 'conversation.exact'))
      .toMatchObject({ result: 'positive', source: 'structured_init' });
    expect(result.observations.find(({ capability }) => capability === 'model.selection'))
      .toMatchObject({ result: 'positive' });
    expect(result.observations.find(({ capability }) => capability === 'subagent.define'))
      .toMatchObject({ result: 'indeterminate' });
  });

  it('rejects malformed and oversized output without retaining it', () => {
    expect(probeStructuredInitOutput('{bad', context)).toEqual({
      observations: [], cacheable: false, detailCode: 'STRUCTURED_INIT_MALFORMED',
    });
    expect(probeStructuredInitOutput(JSON.stringify({ value: 'x'.repeat(70_000) }), context)).toEqual({
      observations: [], cacheable: false, detailCode: 'STRUCTURED_INIT_OVERFLOW',
    });
  });
});
