import * as fs from 'fs';
import {
  DISCOVERY_PROOF_ARGV_V1,
  DISCOVERY_PROOF_TOKEN_V1,
  FreshProcessRequestV1,
  inspectAntigravityPublicStatus,
  inspectFreshPluginDiscovery,
  parsePublicSubcommands,
} from '../../src/native/antigravity-status';

describe('public Antigravity status adapter', () => {
  test('calls only public version/help commands and keeps unproved capabilities at T0', () => {
    const calls: string[][] = [];
    const status = inspectAntigravityPublicStatus({
      run: (_command, argv) => {
        calls.push([...argv]);
        if (argv[0] === '--version') return { status: 0, stdout: 'agy 1.1.6\n', stderr: '' };
        return {
          status: 0,
          stdout: 'Commands:\n  agent      Run agent\n  plugins    Manage plugins\n',
          stderr: '',
        };
      },
    });
    expect(calls).toEqual([['--version'], ['--help']]);
    expect(status).toEqual(expect.objectContaining({
      status: 'public_cli_observed', version: '1.1.6', public_subcommands: ['agent', 'plugins'],
    }));
    expect(status.capabilities.find((entry) => entry.capability === 'native_status'))
      .toEqual({ capability: 'native_status', status: 'unobserved', evidence_tier: 'T0' });
    expect(status.capabilities.find(
      (entry) => entry.capability === 'plugin_fresh_session_discovery',
    )).toEqual({
      capability: 'plugin_fresh_session_discovery',
      status: 'unobserved',
      evidence_tier: 'T0',
    });
  });

  test('redacts diagnostics and does not manufacture native status', () => {
    const secret = 'native-secret';
    const status = inspectAntigravityPublicStatus({
      run: () => ({ status: 1, stdout: '', stderr: `token=${secret}` }),
    });
    expect(status.status).toBe('unavailable');
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(status.detail_code).toBe('PUBLIC_CLI_UNAVAILABLE');
  });

  test('parses and byte-sorts documented command rows only', () => {
    expect(parsePublicSubcommands('  zed  z\nnoise\n  alpha    a\n  alpha    duplicate\n'))
      .toEqual(['alpha', 'zed']);
  });

  test('accepts Go flag help emitted on stderr at exit zero', () => {
    const status = inspectAntigravityPublicStatus({
      run: (_command, argv) => argv[0] === '--version'
        ? { status: 0, stdout: '1.1.6\n', stderr: '' }
        : { status: 0, stdout: '', stderr: 'Available subcommands:\n  plugin          Manage plugins\n' },
    });
    expect(status.public_subcommands).toEqual(['plugin']);
    expect(status.capabilities.find((entry) => entry.capability === 'plugins')?.status).toBe('observed');
  });

  test('runner exceptions degrade to unavailable instead of failing the core', () => {
    const status = inspectAntigravityPublicStatus({ run: () => { throw new Error('offline'); } });
    expect(status.status).toBe('unavailable');
    expect(status.diagnostic).toContain('offline');
  });

  test('observes only an exact fresh-process canary and strips reused conversation binding', async () => {
    let request: FreshProcessRequestV1 | undefined;
    const result = await inspectFreshPluginDiscovery({
      ...freshDiscoveryInput(),
      environment: {
        PATH: process.env.PATH,
        OMA_SESSION_ID: 'old-session',
        OMA_CONVERSATION_ID: 'reused-conversation',
      },
      runner: async (input) => {
        request = input;
        return {
          pid: 4242,
          status: 0,
          signal: null,
          stdout: `${DISCOVERY_PROOF_TOKEN_V1}\n`,
          stderr: '',
          timedOut: false,
          outputOverflow: false,
        };
      },
    });
    expect(result).toEqual(expect.objectContaining({
      status: 'observed',
      evidence_tier: 'T2',
      detail_code: 'FRESH_SESSION_CANARY_OBSERVED',
      fresh_process_pid: 4242,
      process_exit_code: 0,
    }));
    expect(request?.argv).toEqual(DISCOVERY_PROOF_ARGV_V1);
    expect(request?.argv).not.toEqual(expect.arrayContaining(['--continue', '--conversation']));
    expect(request?.environment.OMA_SESSION_ID).toBeUndefined();
    expect(request?.environment.OMA_CONVERSATION_ID).toBeUndefined();
    expect(request?.cwd).not.toContain(process.cwd());
    expect(fs.existsSync(request!.cwd)).toBe(false);
  });

  test('observes agy 1.1.6 trailing double-newline and canonicalizes stored output', async () => {
    const result = await inspectFreshPluginDiscovery({
      executableRealpath: '/opt/agy',
      version: '1.1.6',
      environment: {},
      candidateOid: 'a'.repeat(40),
      packageDigest: 'b'.repeat(64),
      installedDigest: 'b'.repeat(64),
      installedRealpath: '/opt/oh-my-agy',
      installedVersion: '1.1.6',
      registryListSha256: 'c'.repeat(64),
      runner: async () => ({
        pid: 4243,
        status: 0,
        signal: null,
        stdout: `${DISCOVERY_PROOF_TOKEN_V1}\n\n`,
        stderr: '',
        timedOut: false,
        outputOverflow: false,
      }),
    });
    expect(result).toEqual(expect.objectContaining({
      status: 'observed',
      evidence_tier: 'T2',
      detail_code: 'FRESH_SESSION_CANARY_OBSERVED',
      stdout: `${DISCOVERY_PROOF_TOKEN_V1}\n`,
    }));
  });

  test.each([
    ['near-miss output', `${DISCOVERY_PROOF_TOKEN_V1}x\n`, '', 0, null],
    ['missing newline', DISCOVERY_PROOF_TOKEN_V1, '', 0, null],
    ['token with leading noise', `noise\n${DISCOVERY_PROOF_TOKEN_V1}\n`, '', 0, null],
    ['extra stderr', `${DISCOVERY_PROOF_TOKEN_V1}\n`, 'warning\n', 0, null],
    ['failed process', `${DISCOVERY_PROOF_TOKEN_V1}\n`, '', 1, null],
  ])('keeps %s at T0', async (_label, stdout, stderr, status, signal) => {
    const result = await inspectFreshPluginDiscovery({
      ...freshDiscoveryInput(),
      runner: async () => ({
        pid: 4242,
        status,
        signal,
        stdout,
        stderr,
        timedOut: false,
        outputOverflow: false,
      }),
    });
    expect(result.status).toBe('unobserved');
    expect(result.evidence_tier).toBe('T0');
    expect(result.detail_code).not.toBe('FRESH_SESSION_CANARY_OBSERVED');
  });

  test('rejects registry/package identity drift without launching a process', async () => {
    let called = false;
    const result = await inspectFreshPluginDiscovery({
      ...freshDiscoveryInput(),
      installedDigest: 'b'.repeat(64),
      runner: async () => {
        called = true;
        throw new Error('must not launch');
      },
    });
    expect(called).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      status: 'unobserved',
      evidence_tier: 'T0',
      detail_code: 'REGISTRY_IDENTITY_DRIFT',
      fresh_process_pid: null,
    }));
  });
});

function freshDiscoveryInput() {
  return {
    executableRealpath: '/usr/local/bin/agy',
    version: '1.1.6',
    environment: { PATH: process.env.PATH },
    candidateOid: 'a'.repeat(40),
    packageDigest: 'c'.repeat(64),
    installedDigest: 'c'.repeat(64),
    installedRealpath: '/tmp/installed-oh-my-agy',
    installedVersion: '1.1.6',
    registryListSha256: 'd'.repeat(64),
  };
}
