import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDoctor } from '../../src/setup/doctor';
import { PluginCommandAdapter } from '../../src/setup/plugin';
import { assembleHostCapabilityProfile } from '../../src/native/capability-profile';
import { ok } from '../../src/runtime/types';

function surface(root: string, version: string, marker = 'same'): void {
  fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'src', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'autopilot'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@iml1s/oh-my-agy', version,
    bin: { oma: 'dist/bin/oma.js', omy: 'dist/bin/oma.js' },
    files: [
      'dist/bin', 'dist/src', 'plugin.json', 'hooks.json', '.claude-plugin',
      'skills', 'rules', 'package.json',
    ],
  }));
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name: 'oh-my-agy', version }));
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'oh-my-agy', version, skills: ['./skills/autopilot/'],
  }));
  fs.writeFileSync(path.join(root, 'hooks.json'), JSON.stringify({
    'oh-my-agy-runtime': {
      PreInvocation: [{ command: 'node "${extensionPath}/dist/src/hooks/pre-invocation.js"' }],
      Stop: [{ command: 'node "${extensionPath}/dist/src/hooks/stop.js"' }],
    },
  }));
  fs.writeFileSync(path.join(root, 'dist', 'bin', 'oma.js'), marker);
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'pre-invocation.js'), marker);
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'stop.js'), marker);
  fs.writeFileSync(
    path.join(root, 'skills', 'autopilot', 'SKILL.md'),
    '# IN-SESSION PRIMARY\nYou are already in the agent session.\n',
  );
  fs.writeFileSync(path.join(root, 'rules', 'runtime.md'), marker);
}

function adapter(stdout: string, code = 0, stderr = ''): PluginCommandAdapter {
  return {
    async run(argv) {
      return { argv, code, stdout, stderr };
    },
  };
}

describe('oma doctor exact installed identity', () => {
  let scratch: string;
  let source: string;
  let configRoot: string;
  let installed: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-doctor-'));
    source = path.join(scratch, 'source');
    configRoot = path.join(scratch, 'gemini-config');
    installed = path.join(configRoot, 'plugins', 'oh-my-agy');
    surface(source, '0.2.3');
  });

  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  test('passes the plugin row only when standard-path bytes exactly match source', async () => {
    surface(installed, '0.2.3');
    const report = await runDoctor({
      packageRoot: source,
      packageVersion: '0.2.3',
      adapter: adapter(JSON.stringify({
        imports: [{ name: 'oh-my-agy', source: 'antigravity', components: ['skills', 'hooks'] }],
      })),
      antigravityConfigRoot: configRoot,
      mode: 'strict',
      agyCommand: 'echo',
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const plugin = report.value.checks.find((check) => check.id === 'plugin_registry');
    expect(plugin).toEqual(expect.objectContaining({
      status: 'pass',
      detail: expect.objectContaining({
        version: '0.2.3',
        installPath: fs.realpathSync(installed),
        installedDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
  });

  test('source 0.2.3 versus installed 0.2.2 is a deterministic hard failure in every mode', async () => {
    surface(installed, '0.2.2', 'stale');
    for (const mode of ['development', 'strict', 'release'] as const) {
      const report = await runDoctor({
        packageRoot: source,
        packageVersion: '0.2.3',
        adapter: adapter(JSON.stringify({
          imports: [{ name: 'oh-my-agy', source: 'antigravity', components: ['skills', 'hooks'] }],
        })),
        antigravityConfigRoot: configRoot,
        mode,
        agyCommand: 'echo',
      });
      expect(report.ok).toBe(true);
      if (!report.ok) continue;
      const plugin = report.value.checks.find((check) => check.id === 'plugin_registry');
      expect(plugin).toEqual(expect.objectContaining({
        status: 'fail',
        detail: expect.objectContaining({
          details: expect.objectContaining({
            expectedVersion: '0.2.3',
            actualVersion: '0.2.2',
            expectedDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            actualDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
      }));
      expect(report.value.exitCode).toBe(1);
    }
  });

  test('stale registry version versus exact installed bytes is hard in every mode', async () => {
    surface(installed, '0.2.3');
    for (const mode of ['development', 'strict', 'release'] as const) {
      const report = await runDoctor({
        packageRoot: source,
        adapter: adapter(JSON.stringify({
          imports: [{ name: 'oh-my-agy', version: '0.2.2', source: 'antigravity' }],
        })),
        antigravityConfigRoot: configRoot,
        mode,
        agyCommand: 'echo',
      });
      expect(report.ok).toBe(true);
      if (!report.ok) continue;
      expect(report.value.checks.find((check) => check.id === 'plugin_registry'))
        .toEqual(expect.objectContaining({ status: 'fail' }));
      expect(report.value.exitCode).toBe(1);
    }
  });

  test('unresolved sparse registry identity warns only in development and fails strict/release', async () => {
    const list = JSON.stringify({ imports: [{ name: 'oh-my-agy', source: 'antigravity' }] });
    for (const [mode, expected] of [
      ['development', 'warn'], ['strict', 'fail'], ['release', 'fail'],
    ] as const) {
      const report = await runDoctor({
        packageRoot: source,
        packageVersion: '0.2.3',
        adapter: adapter(list),
        antigravityConfigRoot: configRoot,
        mode,
        agyCommand: 'echo',
      });
      expect(report.ok).toBe(true);
      if (!report.ok) continue;
      expect(report.value.checks.find((check) => check.id === 'plugin_registry')?.status)
        .toBe(expected);
      if (mode !== 'development') expect(report.value.exitCode).toBe(1);
    }
  });

  test('registry failures redact credentials and never echo raw output', async () => {
    const secret = 'super-secret-token';
    const report = await runDoctor({
      packageRoot: source,
      packageVersion: '0.2.3',
      adapter: adapter('', 1, `Bearer ${secret} token=${secret}`),
      antigravityConfigRoot: configRoot,
      mode: 'strict',
      agyCommand: 'echo',
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const serialized = JSON.stringify(report.value);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('REDACTED');
  });

  test('fresh-home doctor probes only injected home and state roots', async () => {
    surface(installed, '0.2.3');
    const contaminatedHome = path.join(scratch, 'contaminated-home');
    const cleanHome = path.join(scratch, 'clean-home');
    const cleanState = path.join(scratch, 'clean-state');
    fs.mkdirSync(path.join(contaminatedHome, '.claude', 'skills', 'autopilot'), { recursive: true });
    fs.writeFileSync(
      path.join(contaminatedHome, '.claude', 'skills', 'autopilot', 'SKILL.md'),
      'foreign',
    );
    fs.mkdirSync(cleanHome);
    const previousHome = process.env.HOME;
    process.env.HOME = contaminatedHome;
    try {
      const report = await runDoctor({
        packageRoot: source,
        adapter: adapter(JSON.stringify({
          imports: [{ name: 'oh-my-agy', source: 'antigravity' }],
        })),
        antigravityConfigRoot: configRoot,
        homeDir: cleanHome,
        stateRoot: cleanState,
        mode: 'release',
        agyCommand: 'echo',
      });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.checks.find((check) => check.id === 'slash_collision'))
        .toEqual(expect.objectContaining({ status: 'pass' }));
      expect(report.value.checks.find((check) => check.id === 'state_root'))
        .toEqual(expect.objectContaining({
          status: 'pass',
          detail: expect.objectContaining({ path: fs.realpathSync(cleanState) }),
        }));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('adds exactly one passive native profile projection only when requested', async () => {
    surface(installed, '0.2.3');
    const digest = 'a'.repeat(64);
    const hostIdentity = {
      realpath: '/usr/local/bin/agy',
      binarySha256: digest,
      version: '1.1.6',
      versionOutputSha256: digest,
      helpOutputSha256: digest,
      platform: 'darwin',
      arch: 'arm64',
    };
    const pluginIdentity = {
      status: 'absent' as const,
      realpath: null,
      packageDigest: null,
      version: null,
      readbackDigest: null,
      enabled: false,
    };
    const profile = assembleHostCapabilityProfile({
      evaluationTimestamp: '2026-07-31T00:00:00.000Z',
      hostIdentityBefore: hostIdentity,
      hostIdentityAfter: hostIdentity,
      pluginIdentityBefore: pluginIdentity,
      pluginIdentityAfter: pluginIdentity,
      observations: [],
    });
    const base = {
      packageRoot: source,
      packageVersion: '0.2.3',
      adapter: adapter(JSON.stringify({ imports: [] })),
      antigravityConfigRoot: configRoot,
      mode: 'development' as const,
      agyCommand: 'echo',
    };
    const ordinary = await runDoctor(base);
    expect(ordinary.ok).toBe(true);
    if (!ordinary.ok) return;
    expect(ordinary.value.nativeCapabilities).toBeUndefined();
    expect(ordinary.value.checks.some(({ id }) => id === 'native_capabilities')).toBe(false);

    const native = await runDoctor({
      ...base,
      includeNativeCapabilities: true,
      nativeCapabilitiesProbe: async () => ok({ kind: 'profile', profile, cacheStatus: 'miss' }),
      nowMs: () => Date.parse('2026-07-31T00:00:01.000Z'),
    });
    expect(native.ok).toBe(true);
    if (!native.ok) return;
    expect(native.value.checks.filter(({ id }) => id === 'native_capabilities')).toEqual([
      expect.objectContaining({ status: 'pass' }),
    ]);
    expect(native.value.nativeCapabilities).toMatchObject({
      schema: 'oma.doctor-native/v1',
      profileDigest: profile.profileDigest,
      outcome: 'unknown',
      counts: { supported: 0, unsupported: 0, unknown: profile.capabilities.length },
      identityStatus: 'matched',
    });

    const stale = await runDoctor({
      ...base,
      includeNativeCapabilities: true,
      nativeCapabilitiesProbe: async () => ok({ kind: 'profile', profile, cacheStatus: 'hit' }),
      nowMs: () => Date.parse('2026-07-31T00:05:00.001Z'),
    });
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.value.checks.find(({ id }) => id === 'native_capabilities')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('stale'),
    });
    expect(stale.value.nativeCapabilities).toMatchObject({
      cacheStatus: 'non_cacheable',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'E_CAPABILITY_PROFILE_STALE' }),
      ]),
    });
  });

  test('native doctor maps host absence to warn without invoking live behavior', async () => {
    const report = await runDoctor({
      packageRoot: source,
      packageVersion: '0.2.3',
      adapter: adapter(JSON.stringify({ imports: [] })),
      antigravityConfigRoot: configRoot,
      mode: 'development',
      agyCommand: 'echo',
      includeNativeCapabilities: true,
      nativeCapabilitiesProbe: async () => ok({
        kind: 'host_absent',
        diagnostics: [{ code: 'E_NOT_FOUND', message: 'agy unavailable' }],
      }),
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.find(({ id }) => id === 'native_capabilities'))
      .toEqual(expect.objectContaining({ status: 'warn' }));
    expect(report.value.nativeCapabilities).toMatchObject({
      profileDigest: null,
      outcome: 'unknown',
      identityStatus: 'absent',
    });
  });

  test('native doctor evaluates freshness after the asynchronous probe completes', async () => {
    surface(installed, '0.2.3');
    const digest = 'b'.repeat(64);
    const hostIdentity = {
      realpath: '/usr/local/bin/agy',
      binarySha256: digest,
      version: '1.1.9',
      versionOutputSha256: digest,
      helpOutputSha256: digest,
      platform: 'darwin',
      arch: 'arm64',
    };
    const pluginIdentity = {
      status: 'absent' as const,
      realpath: null,
      packageDigest: null,
      version: null,
      readbackDigest: null,
      enabled: false,
    };
    let nowMs = Date.parse('2026-07-31T00:00:00.000Z');
    const report = await runDoctor({
      packageRoot: source,
      packageVersion: '0.2.3',
      adapter: adapter(JSON.stringify({ imports: [] })),
      antigravityConfigRoot: configRoot,
      mode: 'development',
      agyCommand: 'echo',
      includeNativeCapabilities: true,
      nativeCapabilitiesProbe: async () => {
        nowMs += 1_000;
        return ok({
          kind: 'profile',
          cacheStatus: 'miss',
          profile: assembleHostCapabilityProfile({
            evaluationTimestamp: new Date(nowMs).toISOString(),
            hostIdentityBefore: hostIdentity,
            hostIdentityAfter: hostIdentity,
            pluginIdentityBefore: pluginIdentity,
            pluginIdentityAfter: pluginIdentity,
            observations: [],
          }),
        });
      },
      nowMs: () => nowMs,
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.find(({ id }) => id === 'native_capabilities')).toMatchObject({
      status: 'pass',
      message: expect.stringContaining('valid'),
    });
  });
});
