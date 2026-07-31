import { probeDocumentedHelp } from '../../../src/native/probes/help';
import { PassiveProbeContextV1 } from '../../../src/native/probes/types';
import { HostIdentityV1 } from '../../../src/native/capability-profile';
import { absentPluginIdentity } from '../../../src/native/probes/identity';

const host: HostIdentityV1 = { realpath: '/agy', binarySha256: 'a'.repeat(64), version: '1.1.9', versionOutputSha256: 'b'.repeat(64), helpOutputSha256: 'c'.repeat(64), platform: 'darwin', arch: 'arm64' };
const base: PassiveProbeContextV1 = { mode: 'passive', evaluationTimestamp: '2026-07-31T12:00:00.000Z', identityDigest: 'd'.repeat(64), hostIdentity: host, pluginIdentity: absentPluginIdentity() };

describe('documented help probe', () => {
  it('requires JSON on the output-format line and never promotes help above observed', async () => {
    const result = await probeDocumentedHelp('/agy', { ...base, runner: async () => ({ status: 0, signal: null, stdout: '', stderr: '  --output-format stream-json\n  --json-schema FILE\n  -p PROMPT', timedOut: false, outputOverflow: false, processCountOverflow: false }) });
    expect(result.observations.find(({ capability }) => capability === 'headless.stream_json')).toMatchObject({ result: 'positive', tier: 'observed' });
    expect(result.observations.find(({ capability }) => capability === 'headless.json')).toMatchObject({ result: 'negative', tier: 'observed' });

    const exact = await probeDocumentedHelp('/agy', { ...base, runner: async () => ({
      status: 0,
      signal: null,
      stdout: '  --output-format  Output format for print mode (text, json, stream-json) (default text)\n',
      stderr: '',
      timedOut: false,
      outputOverflow: false,
      processCountOverflow: false,
    }) });
    expect(exact.observations.find(({ capability }) => capability === 'headless.json')).toMatchObject({
      result: 'positive',
      tier: 'observed',
    });
  });

  it.each([
    ['timeout', { timedOut: true, outputOverflow: false }, 'HELP_TIMEOUT'],
    ['overflow', { timedOut: false, outputOverflow: true }, 'HELP_OVERFLOW'],
    ['process overflow', { timedOut: false, outputOverflow: false, processCountOverflow: true }, 'HELP_PROCESS_OVERFLOW'],
  ])('keeps %s unknown', async (_label, flags, code) => {
    const result = await probeDocumentedHelp('/agy', { ...base, runner: async () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', processCountOverflow: false, ...flags }) });
    expect(result).toMatchObject({ cacheable: false, detailCode: code });
    expect(result.observations.every(({ result: outcome }) => outcome === 'indeterminate')).toBe(true);
  });
});
