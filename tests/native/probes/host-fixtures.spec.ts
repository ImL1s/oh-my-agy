import * as fs from 'fs';
import * as path from 'path';
import {
  HostIdentityV1,
  assembleHostCapabilityProfile,
  hostCapabilityIdentityDigest,
} from '../../../src/native/capability-profile';
import {
  absentPluginIdentity,
  completePassiveObservationCoverage,
  probeDocumentedHelp,
} from '../../../src/native/probes';

interface HostFixtureV1 {
  name: string;
  version: string;
  versionOutput: string;
  helpOutput: string;
  expected: Record<string, 'supported' | 'unsupported'>;
}

const observedAt = '2026-07-31T12:00:00.000Z';
const fixtureRoot = path.resolve(__dirname, '../../fixtures/native-capabilities');

describe('version-independent host capability fixtures', () => {
  test.each([
    'stable-1.1.6.json',
    'forward-structured.json',
    'external-partial.json',
  ])('%s derives truth from exact help evidence, never the version label', async (fixtureName) => {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, fixtureName), 'utf8')) as HostFixtureV1;
    const host: HostIdentityV1 = {
      realpath: '/opt/agy-fixture',
      binarySha256: 'a'.repeat(64),
      version: fixture.version,
      versionOutputSha256: 'b'.repeat(64),
      helpOutputSha256: 'c'.repeat(64),
      platform: 'darwin',
      arch: 'arm64',
    };
    const plugin = absentPluginIdentity();
    const identityDigest = hostCapabilityIdentityDigest(host, plugin);
    const help = await probeDocumentedHelp(host.realpath, {
      mode: 'passive',
      evaluationTimestamp: observedAt,
      identityDigest,
      hostIdentity: host,
      pluginIdentity: plugin,
      runner: async () => ({
        status: 0,
        signal: null,
        stdout: fixture.helpOutput,
        stderr: '',
        timedOut: false,
        outputOverflow: false,
        processCountOverflow: false,
      }),
    });
    const profile = assembleHostCapabilityProfile({
      evaluationTimestamp: observedAt,
      hostIdentityBefore: host,
      hostIdentityAfter: host,
      pluginIdentityBefore: plugin,
      pluginIdentityAfter: plugin,
      observations: completePassiveObservationCoverage(
        help.observations,
        observedAt,
        identityDigest,
      ),
      cacheable: help.cacheable,
    });

    expect(profile.hostIdentity.version).toBe(fixture.version);
    for (const [capability, outcome] of Object.entries(fixture.expected)) {
      expect(profile.capabilities.find(({ key }) => key === capability)).toMatchObject({
        outcome,
        tier: 'observed',
        source: 'help',
      });
    }
    expect(profile.capabilities.find(({ key }) => key === 'headless.print')?.tier)
      .not.toBe('healthy');
  });
});
