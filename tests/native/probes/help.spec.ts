import { probeDocumentedHelp } from '../../../src/native/probes/help';
import { PASSIVE_PROBE_LIMITS_V1, PassiveProbeContextV1 } from '../../../src/native/probes/types';
import { HostIdentityV1 } from '../../../src/native/capability-profile';
import { absentPluginIdentity } from '../../../src/native/probes/identity';

const host: HostIdentityV1 = { realpath: '/agy', binarySha256: 'a'.repeat(64), version: '1.1.9', versionOutputSha256: 'b'.repeat(64), helpOutputSha256: 'c'.repeat(64), platform: 'darwin', arch: 'arm64' };
const base: PassiveProbeContextV1 = { mode: 'passive', evaluationTimestamp: '2026-07-31T12:00:00.000Z', identityDigest: 'd'.repeat(64), hostIdentity: host, pluginIdentity: absentPluginIdentity() };

describe('documented help probe', () => {
  it('passes the passive cumulative lineage ceiling of 8 to the runner', async () => {
    expect.assertions(3);
    const result = await probeDocumentedHelp('/agy', {
      ...base,
      runner: async (request) => {
        expect(request.maximumProcesses).toBe(8);
        return {
          status: 0,
          signal: null,
          stdout: '--print',
          stderr: '',
          timedOut: false,
          outputOverflow: false,
          processCountOverflow: false,
        };
      },
    });
    expect(result.detailCode).toBe('HELP_PARSED');
    expect(PASSIVE_PROBE_LIMITS_V1.maximumProcesses).toBe(8);
  });

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

  it('matches only the exact long print option and stamps completion time after the probe', async () => {
    const events: string[] = [];
    const relatedOnly = await probeDocumentedHelp('/agy', {
      ...base,
      runner: async () => {
        events.push('help-complete');
        return {
          status: 0,
          signal: null,
          stdout: '  --print-timeout DURATION\nprose--print\n',
          stderr: '',
          timedOut: false,
          outputOverflow: false,
          processCountOverflow: false,
        };
      },
    }, () => {
      events.push('clock');
      return '2026-07-31T12:00:05.000Z';
    });
    expect(events).toEqual(['help-complete', 'clock']);
    expect(relatedOnly.observations.find(({ capability }) => capability === 'headless.print'))
      .toMatchObject({ result: 'negative', observedAt: '2026-07-31T12:00:05.000Z' });

    for (const advertised of ['--print\n', '--print PROMPT\n', '--print=VALUE\n', '--print, -p\n']) {
      const result = await probeDocumentedHelp('/agy', {
        ...base,
        runner: async () => ({
          status: 0,
          signal: null,
          stdout: advertised,
          stderr: '',
          timedOut: false,
          outputOverflow: false,
          processCountOverflow: false,
        }),
      });
      expect(result.observations.find(({ capability }) => capability === 'headless.print'))
        .toMatchObject({ result: 'positive' });
    }
  });

  it('does not promote related long options or prefixed help tokens', async () => {
    const result = await probeDocumentedHelp('/agy', {
      ...base,
      runner: async () => ({
        status: 0,
        signal: null,
        stdout: [
          '--output-format-extra json',
          '--stream-json-lines',
          '--json-schema-version',
          '--continue-on-error',
          '--conversation-root',
          '--conversation-id-extra',
          '--fork-point',
          '--branch-name',
          '--project-root',
          '--model-cache',
          '--effort-level',
          'mcp-server',
        ].join('\n'),
        stderr: '',
        timedOut: false,
        outputOverflow: false,
        processCountOverflow: false,
      }),
    });
    for (const capability of [
      'headless.json',
      'headless.stream_json',
      'headless.json_schema',
      'conversation.continue',
      'conversation.exact',
      'conversation.fork',
      'conversation.branch',
      'project.association',
      'model.discovery',
      'model.selection',
      'effort.discovery',
      'effort.selection',
      'mcp.local_config',
      'mcp.remote_config',
    ]) {
      expect(result.observations.find(({ capability: key }) => key === capability))
        .toMatchObject({ result: 'negative' });
    }
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
