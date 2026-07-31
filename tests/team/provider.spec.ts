import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CapabilityObservationV1,
  HostCapabilityProfileV1,
  HostIdentityV1,
  PluginIdentityV1,
  assembleHostCapabilityProfile,
} from '../../src/native/capability-profile';
import { canonicalJson, sha256 } from '../../src/runtime/atomic';
import { probeAgy115, routeTeamWorkerProvider, validateProviderRoutePreconditions } from '../../src/team/provider';

const selectedAt = '2026-07-31T12:00:00.000Z';
const now = '2026-07-31T12:00:01.000Z';
const contextDigest = sha256('team/repo/workspace');

const host: HostIdentityV1 = {
  realpath: '/opt/agy', binarySha256: sha256('binary'), version: 'forward',
  versionOutputSha256: sha256('version'), helpOutputSha256: sha256('help'),
  platform: 'darwin', arch: 'arm64',
};
const plugin: PluginIdentityV1 = {
  status: 'present', realpath: '/opt/plugin', packageDigest: sha256('plugin'),
  version: '1.0.0', readbackDigest: sha256('readback'), enabled: true,
};

function profile(capability: string, tier: CapabilityObservationV1['tier']): HostCapabilityProfileV1 {
  const empty = assembleHostCapabilityProfile({
    evaluationTimestamp: selectedAt,
    hostIdentityBefore: host,
    hostIdentityAfter: host,
    pluginIdentityBefore: plugin,
    pluginIdentityAfter: plugin,
    observations: [],
  });
  return assembleHostCapabilityProfile({
    evaluationTimestamp: selectedAt,
    hostIdentityBefore: host,
    hostIdentityAfter: host,
    pluginIdentityBefore: plugin,
    pluginIdentityAfter: plugin,
    observations: [{
      capability, source: 'live_probe', tier, result: 'positive',
      observedAt: selectedAt, identityDigest: empty.identityDigest,
      detailCode: 'LIVE_OK', diagnostic: null,
    }],
  });
}

function headlessProfile(): HostCapabilityProfileV1 {
  const base = profile('headless.print', 'healthy');
  return assembleHostCapabilityProfile({
    evaluationTimestamp: selectedAt,
    hostIdentityBefore: host, hostIdentityAfter: host,
    pluginIdentityBefore: plugin, pluginIdentityAfter: plugin,
    observations: ['headless.print', 'headless.json'].map((capability) => ({
      capability, source: 'live_probe' as const, tier: 'healthy' as const,
      result: 'positive' as const, observedAt: selectedAt,
      identityDigest: base.identityDigest, detailCode: 'LIVE_OK', diagnostic: null,
    })),
  });
}

function nativeProfile(): HostCapabilityProfileV1 {
  const base = profile('subagent.invoke', 'verified');
  return assembleHostCapabilityProfile({
    evaluationTimestamp: selectedAt,
    hostIdentityBefore: host, hostIdentityAfter: host,
    pluginIdentityBefore: plugin, pluginIdentityAfter: plugin,
    observations: ['subagent.invoke', 'subagent.send_message', 'subagent.manage'].map((capability) => ({
      capability, source: 'live_probe' as const, tier: 'verified' as const,
      result: 'positive' as const, observedAt: selectedAt,
      identityDigest: base.identityDigest, detailCode: 'NATIVE_LIVE_OK', diagnostic: null,
    })),
  });
}

function select(value: HostCapabilityProfileV1, launchMode: 'headless' | 'interactive') {
  const tmux = {
    schema: 'oma.tmux-readiness/v1' as const, explicitlyEnabled: true as const,
    tmuxObserved: true as const, interactiveCanaryAttachable: true as const, orphanFree: true as const,
    observedAt: selectedAt, expiresAt: '2026-07-31T12:00:30.000Z',
  };
  return routeTeamWorkerProvider({
    profile: value,
    launchMode,
    now,
    generation: 3,
    contextDigest,
    resolvedExecutable: '/opt/agy',
    ...(launchMode === 'interactive'
      ? { tmuxReadiness: { ...tmux, receiptDigest: sha256(canonicalJson(tmux)) } }
      : {}),
  });
}

describe('profile-backed fail-closed worker provider selection', () => {
  test('version/help probe is compatibility observation and invents no canary or route', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-agy-probe-'));
    try {
      const executable = path.join(root, 'agy');
      fs.writeFileSync(executable, [
        '#!/usr/bin/env node',
        "if (process.argv[2] === '--version') process.stdout.write('1.1.6\\n');",
        "else if (process.argv[2] === '--help') process.stderr.write('--add-dir --conversation --mode --model --print --print-timeout --prompt-interactive --sandbox\\n');",
        'else process.exit(2);',
        '',
      ].join('\n'));
      fs.chmodSync(executable, 0o755);
      const probed = probeAgy115(executable, Date.parse(selectedAt));
      expect(probed.ok).toBe(true);
      if (!probed.ok) return;
      expect(probed.value).toMatchObject({ version: '1.1.6', observedAtMs: Date.parse(selectedAt) });
      expect(probed.value.headlessCanary).toBeUndefined();
      expect(probed.value.interactiveCanary).toBeUndefined();
      expect(probed.value).not.toHaveProperty('provider');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('native candidate returns the exact typed adapter error before a receipt exists', () => {
    const result = select(nativeProfile(), 'headless');
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'E_NATIVE_ADAPTER_UNAVAILABLE',
        message: 'Antigravity native worker adapter is unavailable',
        details: { provider: 'antigravity_native', adapterImplemented: false },
      },
    });
  });

  test('headless then explicit interactive tmux candidates receive validated digest-bound receipts', () => {
    const value = headlessProfile();
    const headless = select(value, 'headless');
    expect(headless.ok && headless.value.provider).toBe('agy_headless');
    if (headless.ok) {
      expect(headless.value.profileDigest).toBe(value.profileDigest);
      expect(headless.value.receiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    }
    const tmux = select(value, 'interactive');
    expect(tmux.ok && tmux.value.provider).toBe('tmux_agy');
  });

  test('routes a profile bound to a native Windows executable path', () => {
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
      evaluationTimestamp: selectedAt,
      hostIdentityBefore: windowsHost,
      hostIdentityAfter: windowsHost,
      pluginIdentityBefore: windowsPlugin,
      pluginIdentityAfter: windowsPlugin,
      observations: [],
    });
    const value = assembleHostCapabilityProfile({
      evaluationTimestamp: selectedAt,
      hostIdentityBefore: windowsHost,
      hostIdentityAfter: windowsHost,
      pluginIdentityBefore: windowsPlugin,
      pluginIdentityAfter: windowsPlugin,
      observations: ['headless.print', 'headless.json'].map((capability) => ({
        capability, source: 'live_probe' as const, tier: 'healthy' as const,
        result: 'positive' as const, observedAt: selectedAt,
        identityDigest: empty.identityDigest, detailCode: 'WINDOWS_LIVE_OK', diagnostic: null,
      })),
    });
    const selected = routeTeamWorkerProvider({
      profile: value,
      launchMode: 'headless',
      now,
      generation: 3,
      contextDigest,
      resolvedExecutable: windowsHost.realpath,
    });
    expect(selected.ok && selected.value.resolvedExecutable).toBe(windowsHost.realpath);
  });

  test('profile tamper, executable drift, and implicit tmux fallback fail closed', () => {
    const value = headlessProfile();
    expect(routeTeamWorkerProvider({
      profile: { ...value, profileDigest: sha256('tampered') }, launchMode: 'headless', now,
      generation: 3, contextDigest, resolvedExecutable: '/opt/agy',
    }).ok).toBe(false);
    expect(routeTeamWorkerProvider({
      profile: value, launchMode: 'headless', now,
      generation: 3, contextDigest, resolvedExecutable: '/other/agy',
    }).ok).toBe(false);
    expect(routeTeamWorkerProvider({
      profile: value, launchMode: 'interactive', now,
      generation: 3, contextDigest, resolvedExecutable: '/opt/agy',
    }).ok).toBe(false);
  });

  test('fallback predicates require structured headless truth and explicit fresh tmux canary', () => {
    expect(validateProviderRoutePreconditions(profile('headless.print', 'healthy'), 'headless', now).ok).toBe(false);
    const value = headlessProfile();
    expect(validateProviderRoutePreconditions(value, 'headless', now)).toEqual({ ok: true, value: true });
    expect(validateProviderRoutePreconditions(value, 'interactive', now).ok).toBe(false);
    const receipt = {
      schema: 'oma.tmux-readiness/v1' as const,
      explicitlyEnabled: true as const,
      tmuxObserved: true as const,
      interactiveCanaryAttachable: true as const,
      orphanFree: true as const,
      observedAt: selectedAt,
      expiresAt: '2026-07-31T12:00:30.000Z',
    };
    expect(validateProviderRoutePreconditions(value, 'interactive', now, {
      ...receipt,
      receiptDigest: sha256(canonicalJson(receipt)),
    })).toEqual({ ok: true, value: true });
  });
});
