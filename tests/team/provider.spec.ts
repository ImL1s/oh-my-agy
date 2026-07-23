import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256 } from '../../src/runtime/atomic';
import {
  AgyCliProbeV1,
  AntigravityNativeEvidenceV1,
  TmuxAgyEvidenceV1,
  probeAgy115,
  selectWorkerProvider,
} from '../../src/team/provider';

const now = 10_000;
const digest = (value: string) => sha256(value);

function agy(): AgyCliProbeV1 {
  return {
    schemaVersion: 1,
    installed: true,
    executableRealpath: '/opt/agy',
    executableSha256: digest('binary'),
    version: '1.1.5',
    versionOutputHash: digest('version'),
    helpOutputHash: digest('help'),
    requiredFlags: [
      '--conversation', '--mode', '--print', '--print-timeout', '--prompt-interactive', '--sandbox',
    ],
    observedAtMs: now,
    headlessCanary: {
      schemaVersion: 1,
      kind: 'headless_exit',
      argvHash: digest('headless argv'),
      exitCode: 0,
      attachable: false,
      orphanFree: true,
      observedAtMs: now,
    },
    interactiveCanary: {
      schemaVersion: 1,
      kind: 'interactive_attach',
      argvHash: digest('interactive argv'),
      exitCode: null,
      attachable: true,
      orphanFree: true,
      observedAtMs: now,
    },
  };
}

function native(): AntigravityNativeEvidenceV1 {
  return {
    schemaVersion: 1,
    advertised: true,
    documentedPublic: true,
    invokeSubagentObserved: true,
    healthy: true,
    hostVersion: '1.1.5',
    documentationHash: digest('docs'),
    observedAtMs: now,
    conversationReceipt: {
      schemaVersion: 1,
      provider: 'antigravity_native',
      conversationId: 'conversation-native',
      receiptId: 'receipt-native',
      generation: 3,
      observedAtMs: now,
      capabilityDigest: digest('capability'),
    },
  };
}

function tmux(): TmuxAgyEvidenceV1 {
  return {
    schemaVersion: 1,
    explicitlyEnabled: true,
    tmuxObserved: true,
    tmuxVersionHash: digest('tmux'),
    observedAtMs: now,
    agy: agy(),
  };
}

describe('fail-closed worker provider order', () => {
  test('version/help probe accepts the agy 1.1.5 help stream on stderr without inventing canaries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-agy-probe-'));
    try {
      const executable = path.join(root, 'agy');
      fs.writeFileSync(executable, [
        '#!/usr/bin/env node',
        "if (process.argv[2] === '--version') process.stdout.write('1.1.5\\n');",
        "else if (process.argv[2] === '--help') process.stderr.write('--conversation --mode --print --print-timeout --prompt-interactive --sandbox\\n');",
        'else process.exit(2);',
        '',
      ].join('\n'));
      fs.chmodSync(executable, 0o755);
      const probed = probeAgy115(executable, now);
      expect(probed.ok).toBe(true);
      if (!probed.ok) return;
      expect(probed.value).toMatchObject({
        version: '1.1.5',
        observedAtMs: now,
      });
      expect(probed.value.headlessCanary).toBeUndefined();
      expect(probed.value.interactiveCanary).toBeUndefined();
      expect(probed.value.helpOutputHash).toBe(digest(
        '--conversation --mode --print --print-timeout --prompt-interactive --sandbox\n',
      ));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fresh documented native receipt wins and is generation-fenced', () => {
    const selected = selectWorkerProvider(
      { antigravityNative: native(), agyHeadless: agy(), tmuxAgy: tmux() },
      { generation: 3, launchMode: 'headless', nowMs: now },
    );
    expect(selected.ok && selected.value.provider).toBe('antigravity_native');
    const stale = selectWorkerProvider(
      { antigravityNative: native(), agyHeadless: agy(), tmuxAgy: tmux() },
      { generation: 4, launchMode: 'headless', nowMs: now },
    );
    expect(stale.ok).toBe(false);
  });

  test('headless then explicitly enabled tmux are the only lower providers', () => {
    const headless = selectWorkerProvider(
      { agyHeadless: agy(), tmuxAgy: tmux() },
      { generation: 3, launchMode: 'headless', nowMs: now },
    );
    expect(headless.ok && headless.value.provider).toBe('agy_headless');
    const interactive = selectWorkerProvider(
      { agyHeadless: agy(), tmuxAgy: tmux() },
      { generation: 3, launchMode: 'interactive', nowMs: now },
    );
    expect(interactive.ok && interactive.value.provider).toBe('tmux_agy');
  });

  test('advertised or installed unhealthy provider blocks instead of silently falling through', () => {
    const badNative = { ...native(), healthy: false };
    expect(selectWorkerProvider(
      { antigravityNative: badNative, agyHeadless: agy(), tmuxAgy: tmux() },
      { generation: 3, launchMode: 'headless', nowMs: now },
    ).ok).toBe(false);
    const badHeadless = { ...agy(), headlessCanary: undefined };
    expect(selectWorkerProvider(
      { agyHeadless: badHeadless, tmuxAgy: tmux() },
      { generation: 3, launchMode: 'headless', nowMs: now },
    ).ok).toBe(false);
  });

  test('missing provider blocks and never selects Claude, Codex, or Grok', () => {
    const result = selectWorkerProvider(
      { claude: true, codex: true, grok: true } as never,
      { generation: 1, launchMode: 'headless', nowMs: now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('fallback is forbidden');
  });
});
