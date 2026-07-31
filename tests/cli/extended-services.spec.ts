import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDefaultServices } from '../../src/cli/services';
import * as runManifest from '../../src/contracts/run-manifest';
import { canonicalBytesV1, sha256Hex } from '../../src/contracts';

describe('public composition CLI services', () => {
  const packageRoot = path.resolve(__dirname, '../..');

  test('doctor rejects duplicate, unknown, and positional arguments deterministically', async () => {
    for (const argv of [
      ['--native', '--native'],
      ['--unknown'],
      ['positional'],
    ]) {
      let stdout = '';
      let stderr = '';
      const services = createDefaultServices({
        packageRoot,
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
      });
      expect(await services.doctorCommand(argv)).toBe(2);
      expect(stdout).toBe('');
      expect(stderr).toContain('E_CLI_USAGE: doctor:');
    }

    let stdout = '';
    let stderr = '';
    const services = createDefaultServices({
      packageRoot,
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    expect(await services.doctorCommand(['--json', '--native', '--native'])).toBe(2);
    expect(stderr).toBe('');
    expect(stdout.endsWith('\n')).toBe(true);
    expect(JSON.parse(stdout)).toEqual({
      command: 'doctor',
      error: { code: 'E_CLI_USAGE', message: 'doctor: duplicate option --native' },
      exitCode: 2,
      ok: false,
      outcome: 'usage_error',
      schema: 'oma.cli-result/v1',
    });
  });

  test('native capability display is canonical JSON and host absence remains honest success', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-missing-'));
    let stdout = '';
    let stderr = '';
    const services = createDefaultServices({
      packageRoot,
      cwd,
      stateRoot: path.join(cwd, 'state'),
      agyCommand: path.join(cwd, 'missing-agy'),
      environment: { PATH: cwd, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    try {
      expect(await services.nativeCommand('capabilities', ['--json'])).toBe(0);
      expect(stderr).toBe('');
      expect(stdout.endsWith('\n')).toBe(true);
      expect(JSON.parse(stdout)).toMatchObject({
        schema: 'oma.native-command-result/v1',
        command: 'native capabilities',
        ok: true,
        outcome: 'unknown',
        exitCode: 0,
        result: { host: 'absent' },
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('explicit native live probe fails closed when the host is absent', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-live-missing-'));
    let stdout = '';
    let stderr = '';
    const services = createDefaultServices({
      packageRoot,
      cwd,
      stateRoot: path.join(cwd, 'state'),
      agyCommand: path.join(cwd, 'missing-agy'),
      environment: { PATH: cwd, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    try {
      expect(await services.nativeCommand('probe', ['--live', '--json'])).toBe(1);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toMatchObject({
        schema: 'oma.native-command-result/v1',
        command: 'native probe',
        ok: false,
        outcome: 'live_probe_failed',
        exitCode: 1,
        error: { code: 'E_CAPABILITY_HOST_UNAVAILABLE' },
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('native status preserves unavailable bounded version/help outcomes at T0', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-status-failed-probes-'));
    const executable = path.join(cwd, 'agy');
    fs.writeFileSync(executable, '#!/bin/sh\nexit 2\n', { mode: 0o700 });
    let stdout = '';
    const services = createDefaultServices({
      packageRoot,
      cwd,
      stateRoot: path.join(cwd, 'state'),
      agyCommand: executable,
      pluginAdapter: { run: async (argv) => ({ argv: [...argv], code: 1, stdout: '', stderr: 'registry unavailable' }) },
      environment: { PATH: cwd, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    });
    try {
      expect(await services.extendedCommand('native-status', [])).toBe(0);
      const body = JSON.parse(stdout) as {
        status: string;
        detail_code: string;
        capabilities: Array<{ capability: string; status: string; evidence_tier: string }>;
      };
      expect(body).toMatchObject({
        status: 'unavailable',
        detail_code: 'HOST_CAPABILITY_PUBLIC_CLI_UNAVAILABLE',
      });
      expect(body.capabilities.find(({ capability }) => capability === 'public_cli')).toEqual({
        capability: 'public_cli',
        status: 'unobserved',
        evidence_tier: 'T0',
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('plugin readback failure remains unknown and non-cacheable instead of affirmative absence', async () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-plugin-failure-')));
    const executable = path.join(cwd, 'agy');
    fs.writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'agy 9.0.0\n'; exit 0; fi
if [ "$1" = "--help" ]; then printf '%s\n' '--print --output-format json'; exit 0; fi
exit 2
`, { mode: 0o700 });
    let stdout = '';
    const services = createDefaultServices({
      packageRoot,
      cwd,
      stateRoot: path.join(cwd, 'state'),
      agyCommand: executable,
      pluginAdapter: { run: async (argv) => ({ argv: [...argv], code: 1, stdout: '', stderr: 'transient registry failure' }) },
      environment: { PATH: cwd, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    });
    try {
      expect(await services.nativeCommand('capabilities', ['--json'])).toBe(0);
      const body = JSON.parse(stdout) as {
        cacheStatus: string;
        profile: { cacheable: boolean; pluginIdentity: { status: string } };
      };
      expect(body.profile).toMatchObject({
        cacheable: false,
        pluginIdentity: { status: 'unknown' },
      });
      expect(body.cacheStatus).toBe('non_cacheable');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('bounded plugin readback terminates descendants that retain inherited pipes', async () => {
    if (process.platform === 'win32') return;
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-plugin-tree-')));
    const executable = path.join(cwd, 'agy');
    const descendantPidPath = path.join(cwd, 'plugin-descendant.pid');
    const pluginScript = [
      "const fs=require('fs');",
      "const {spawn}=require('child_process');",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:['ignore','inherit','inherit']});",
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid));`,
      "process.stdout.write('x'.repeat(70*1024));",
      'setInterval(()=>{},60000);',
    ].join('');
    fs.writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'agy 9.0.0\\n'; exit 0; fi
if [ "$1" = "--help" ]; then printf '%s\\n' '--print'; exit 0; fi
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(pluginScript)}
fi
exit 2
`, { mode: 0o700 });
    let stdout = '';
    let descendantPid: number | undefined;
    const services = createDefaultServices({
      packageRoot,
      cwd,
      stateRoot: path.join(cwd, 'state'),
      agyCommand: executable,
      environment: { PATH: process.env.PATH, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    });
    const started = Date.now();
    try {
      expect(await services.nativeCommand('capabilities', ['--json'])).toBe(0);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(JSON.parse(stdout).profile.pluginIdentity.status).toBe('unknown');
      descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
      await waitForProcessExit(descendantPid, 2_000);
      expect(processIsAlive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid === undefined && fs.existsSync(descendantPidPath)) {
        descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
      }
      if (descendantPid !== undefined && processIsAlive(descendantPid)) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch (_) { /* 已結束 */ }
      }
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  test('help output overflow remains unknown instead of masquerading as host absence', async () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-help-overflow-')));
    const executable = path.join(cwd, 'agy');
    fs.writeFileSync(executable, `#!${process.execPath}
if (process.argv[2] === '--version') { process.stdout.write('agy 9.0.0\\n'); process.exit(0); }
if (process.argv[2] === '--help') { process.stdout.write('x'.repeat(70 * 1024)); }
else { process.exit(2); }
`, { mode: 0o700 });
    let stdout = '';
    const services = createDefaultServices({
      packageRoot,
      cwd,
      stateRoot: path.join(cwd, 'state'),
      agyCommand: executable,
      pluginAdapter: { run: async (argv) => ({ argv: [...argv], code: 1, stdout: '', stderr: 'registry unavailable' }) },
      environment: { PATH: cwd, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    });
    try {
      expect(await services.nativeCommand('capabilities', ['--json'])).toBe(0);
      const body = JSON.parse(stdout) as {
        profile?: { cacheable: boolean; capabilities: Array<{ key: string; outcome: string }> };
        result?: { host?: string };
      };
      expect(body.result?.host).not.toBe('absent');
      expect(body.profile?.cacheable).toBe(false);
      expect(body.profile?.capabilities.find(({ key }) => key === 'headless.print')?.outcome).toBe('unknown');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('alternating help bytes cannot pass an ABA identity fence', async () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-help-aba-')));
    const executable = path.join(cwd, 'agy');
    const counter = path.join(cwd, 'help-counter');
    fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('fs');
const counter = ${JSON.stringify(counter)};
if (process.argv[2] === '--version') { process.stdout.write('agy 9.0.0\\n'); process.exit(0); }
if (process.argv[2] === '--help') {
  const value = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
  fs.writeFileSync(counter, String(value));
  process.stdout.write(value % 2 === 1 ? '--print\\n' : '--print --output-format stream-json\\n');
  process.exit(0);
}
process.exit(2);
`, { mode: 0o700 });
    let stdout = '';
    const services = createDefaultServices({
      packageRoot,
      cwd,
      stateRoot: path.join(cwd, 'state'),
      agyCommand: executable,
      pluginAdapter: { run: async (argv) => ({ argv: [...argv], code: 1, stdout: '', stderr: 'registry unavailable' }) },
      environment: { PATH: cwd, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    });
    try {
      expect(await services.nativeCommand('capabilities', ['--json'])).toBe(0);
      const body = JSON.parse(stdout) as {
        profile: { identityStatus: string; capabilities: Array<{ key: string; outcome: string }> };
      };
      expect(body.profile.identityStatus).toBe('drifted');
      expect(body.profile.capabilities.find(({ key }) => key === 'headless.stream_json')?.outcome).toBe('unknown');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('native commands reject duplicate/unknown flags and require literal live opt-in', async () => {
    for (const [command, argv] of ([
      ['capabilities', ['--json', '--json']],
      ['capabilities', ['--unknown']],
      ['probe', ['--json']],
      ['probe', ['--live', '--live']],
    ] as Array<['capabilities' | 'probe', string[]]>)) {
      let stdout = '';
      let stderr = '';
      const services = createDefaultServices({
        packageRoot,
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
      });
      expect(await services.nativeCommand(command, argv)).toBe(2);
      if (argv.includes('--json')) {
        expect(stderr).toBe('');
        expect(JSON.parse(stdout)).toMatchObject({ ok: false, outcome: 'usage_error', exitCode: 2 });
      } else {
        expect(stdout).toBe('');
        expect(stderr).toContain('E_CLI_USAGE');
      }
    }
  });

  test('explicit native live command reaches the fixed bounded canary and returns a profile', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-live-'));
    const executable = path.join(cwd, 'agy');
    const argvLog = path.join(cwd, 'live-argv.log');
    const completionMarker = path.join(cwd, 'live-complete');
    fs.writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'agy 1.1.6\\n'; exit 0; fi
if [ "$1" = "--help" ]; then printf '%s\\n' '--print --output-format json'; exit 0; fi
printf 'CALL\\n' >> ${JSON.stringify(argvLog)}
printf '%s\\n' "$@" >> ${JSON.stringify(argvLog)}
previous=''
format='text'
for arg in "$@"; do
  if [ "$previous" = "--print" ]; then prompt="$arg"; fi
  if [ "$previous" = "--output-format" ]; then format="$arg"; fi
  previous="$arg"
done
token="\${prompt##*: }"
/bin/sleep 0.05
: > ${JSON.stringify(completionMarker)}
if [ "$format" = "json" ]; then
  printf '{"conversation_id":"fixture","status":"SUCCESS","response":"%s","error":null}\\n' "$token"
else
  printf '%s\\n' "$token"
fi
exit 0
`, { mode: 0o700 });
    let stdout = '';
    let stderr = '';
    const services = createDefaultServices({
      packageRoot,
      cwd,
      stateRoot: path.join(cwd, 'state'),
      agyCommand: executable,
      pluginAdapter: { run: async (argv) => ({ argv: [...argv], code: 1, stdout: '', stderr: 'registry unavailable' }) },
      environment: { PATH: cwd, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    try {
      expect(await services.nativeCommand('probe', ['--live', '--json'])).toBe(0);
      expect(stderr).toBe('');
      const body = JSON.parse(stdout) as {
        ok: boolean;
        profile: {
          generatedAt: string;
          capabilities: Array<{
            key: string;
            outcome: string;
            observations: Array<{ source: string; observedAt: string }>;
          }>;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.profile.capabilities.find(({ key }) => key === 'headless.print'))
        .toEqual(expect.objectContaining({ outcome: 'supported' }));
      expect(body.profile.capabilities.find(({ key }) => key === 'headless.json'))
        .toEqual(expect.objectContaining({ outcome: 'supported' }));
      const liveObservation = body.profile.capabilities
        .find(({ key }) => key === 'headless.print')
        ?.observations.find(({ source }) => source === 'live_probe');
      expect(liveObservation).toBeDefined();
      expect(Date.parse(liveObservation!.observedAt) + 1).toBeGreaterThanOrEqual(
        fs.statSync(completionMarker).mtimeMs,
      );
      expect(Date.parse(body.profile.generatedAt)).toBeGreaterThanOrEqual(Date.parse(liveObservation!.observedAt));
      const liveCalls = fs.readFileSync(argvLog, 'utf8').split('CALL\n')
        .filter((entry) => entry.trim() !== '')
        .map((entry) => entry.trim().split('\n'));
      expect(liveCalls).toHaveLength(3);
      expect(liveCalls[0]).toEqual(expect.arrayContaining(['--output-format', 'json']));
      expect(liveCalls[1]).not.toContain('--output-format');
      expect(liveCalls[1]).toEqual(expect.arrayContaining(['--mode', 'accept-edits']));
      expect(liveCalls[1]).not.toContain('--sandbox');
      expect(liveCalls[2]).toEqual(expect.arrayContaining(['--mode', 'plan', '--sandbox']));
      for (const liveArgv of liveCalls) {
        const timeoutIndex = liveArgv.indexOf('--print-timeout');
        expect(liveArgv.slice(timeoutIndex, timeoutIndex + 2)).toEqual(['--print-timeout', '45s']);
      }
      const writeAddDirIndex = liveCalls[1].indexOf('--add-dir');
      expect(path.basename(liveCalls[1][writeAddDirIndex + 1])).toMatch(/^oma-native-write-/u);
      const readAddDirIndex = liveCalls[2].indexOf('--add-dir');
      expect(liveCalls[2].slice(readAddDirIndex, readAddDirIndex + 2))
        .toEqual(['--add-dir', fs.realpathSync(cwd)]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('JSON success cannot authorize a broken exact-text worker route', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-live-mode-fence-'));
    const executable = path.join(cwd, 'agy');
    fs.writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'agy 1.1.9\\n'; exit 0; fi
if [ "$1" = "--help" ]; then printf '%s\\n' '--print --output-format json'; exit 0; fi
previous=''
format='text'
for arg in "$@"; do
  if [ "$previous" = "--print" ]; then prompt="$arg"; fi
  if [ "$previous" = "--output-format" ]; then format="$arg"; fi
  previous="$arg"
done
token="\${prompt##*: }"
if [ "$format" = "json" ]; then
  printf '{"conversation_id":"fixture","status":"SUCCESS","response":"%s","error":null}\\n' "$token"
else
  printf 'broken-default-print\\n'
fi
`, { mode: 0o700 });
    let stdout = '';
    const services = createDefaultServices({
      packageRoot,
      cwd,
      stateRoot: path.join(cwd, 'state'),
      agyCommand: executable,
      environment: { PATH: cwd, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    });
    try {
      expect(await services.nativeCommand('probe', ['--live', '--json'])).toBe(1);
      const body = JSON.parse(stdout) as {
        outcome: string;
        error: { code: string };
        profile: { capabilities: Array<{ key: string; outcome: string }> };
      };
      expect(body.outcome).toBe('live_probe_failed');
      expect(body.error.code).toBe('LIVE_MALFORMED');
      expect(body.profile.capabilities.find(({ key }) => key === 'headless.print')?.outcome)
        .not.toBe('supported');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('read-write route authority requires the accept-edits worker argv to execute', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-live-write-mode-fence-'));
    const executable = path.join(cwd, 'agy');
    fs.writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'agy 1.1.9\\n'; exit 0; fi
if [ "$1" = "--help" ]; then printf '%s\\n' '--print'; exit 0; fi
previous=''
for arg in "$@"; do
  if [ "$previous" = "--print" ]; then prompt="$arg"; fi
  if [ "$previous" = "--mode" ] && [ "$arg" = "accept-edits" ]; then exit 2; fi
  previous="$arg"
done
printf '%s\\n' "\${prompt##*: }"
`, { mode: 0o700 });
    let stdout = '';
    const services = createDefaultServices({
      packageRoot,
      cwd,
      stateRoot: path.join(cwd, 'state'),
      agyCommand: executable,
      environment: { PATH: cwd, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    });
    try {
      expect(await services.nativeCommand('probe', ['--live', '--json'])).toBe(1);
      const body = JSON.parse(stdout) as {
        error: { code: string };
        profile: { capabilities: Array<{ key: string; outcome: string }> };
      };
      expect(body.error.code).toBe('LIVE_MALFORMED');
      expect(body.profile.capabilities.find(({ key }) => key === 'headless.print')?.outcome)
        .not.toBe('supported');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('exact-text route authority requires the workflow add-dir argv to execute', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-live-add-dir-fence-'));
    const executable = path.join(cwd, 'agy');
    fs.writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'agy 1.1.9\\n'; exit 0; fi
if [ "$1" = "--help" ]; then printf '%s\\n' '--print'; exit 0; fi
previous=''
for arg in "$@"; do
  if [ "$arg" = "--add-dir" ]; then printf 'unsupported add-dir\\n' >&2; exit 2; fi
  if [ "$previous" = "--print" ]; then prompt="$arg"; fi
  previous="$arg"
done
printf '%s\\n' "\${prompt##*: }"
`, { mode: 0o700 });
    let stdout = '';
    const services = createDefaultServices({
      packageRoot,
      cwd,
      stateRoot: path.join(cwd, 'state'),
      agyCommand: executable,
      environment: { PATH: cwd, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    });
    try {
      expect(await services.nativeCommand('probe', ['--live', '--json'])).toBe(1);
      const body = JSON.parse(stdout) as {
        error: { code: string };
        profile: { capabilities: Array<{ key: string; outcome: string }> };
      };
      expect(body.error.code).toBe('LIVE_MALFORMED');
      expect(body.profile.capabilities.find(({ key }) => key === 'headless.print')?.outcome)
        .not.toBe('supported');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('passive help evidence is timestamped after the host help probe completes', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-passive-time-'));
    const executable = path.join(cwd, 'agy');
    const completionMarker = path.join(cwd, 'help-complete');
    fs.writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'agy 1.1.9\\n'; exit 0; fi
if [ "$1" = "--help" ]; then
  /bin/sleep 0.05
  if [ ! -f ${JSON.stringify(completionMarker)} ]; then : > ${JSON.stringify(completionMarker)}; fi
  printf '%s\\n' '--print --output-format json'
  exit 0
fi
exit 2
`, { mode: 0o700 });
    let stdout = '';
    const services = createDefaultServices({
      packageRoot,
      cwd,
      stateRoot: path.join(cwd, 'state'),
      agyCommand: executable,
      pluginAdapter: { run: async (argv) => ({ argv: [...argv], code: 1, stdout: '', stderr: 'registry unavailable' }) },
      environment: { PATH: cwd, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    });
    try {
      expect(await services.nativeCommand('capabilities', ['--json'])).toBe(0);
      const body = JSON.parse(stdout) as {
        profile: {
          capabilities: Array<{
            key: string;
            observations: Array<{ source: string; observedAt: string }>;
          }>;
        };
      };
      const helpObservation = body.profile.capabilities
        .find(({ key }) => key === 'headless.print')
        ?.observations.find(({ source }) => source === 'help');
      expect(helpObservation).toBeDefined();
      expect(Date.parse(helpObservation!.observedAt) + 1).toBeGreaterThanOrEqual(
        fs.statSync(completionMarker).mtimeMs,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('failed live probe invalidates a prior success for the same host identity', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-live-invalidate-'));
    const executable = path.join(cwd, 'agy');
    const failMarker = path.join(cwd, 'fail-live');
    fs.writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'agy 1.1.9\\n'; exit 0; fi
if [ "$1" = "--help" ]; then printf '%s\\n' '--print --output-format json'; exit 0; fi
if [ -f "${failMarker}" ]; then printf '%s\\n' '{"status":"ERROR"}'; exit 0; fi
previous=''
format='text'
for arg in "$@"; do
  if [ "$previous" = "--print" ]; then prompt="$arg"; fi
  if [ "$previous" = "--output-format" ]; then format="$arg"; fi
  previous="$arg"
done
token="\${prompt##*: }"
if [ "$format" = "json" ]; then
  printf '{"conversation_id":"fixture","status":"SUCCESS","response":"%s","error":null}\\n' "$token"
else
  printf '%s\\n' "$token"
fi
`, { mode: 0o700 });
    const stateRoot = path.join(cwd, 'state');
    const output = { stdout: '', stderr: '' };
    const services = createDefaultServices({
      packageRoot,
      cwd,
      stateRoot,
      agyCommand: executable,
      environment: { PATH: cwd, HOME: cwd },
      stdout: (value) => { output.stdout += value; },
      stderr: (value) => { output.stderr += value; },
    });
    try {
      expect(await services.nativeCommand('probe', ['--live', '--json'])).toBe(0);
      fs.writeFileSync(failMarker, 'fail\n');
      output.stdout = '';
      expect(await services.nativeCommand('probe', ['--live', '--json'])).toBe(1);
      expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, outcome: 'live_probe_failed' });

      output.stdout = '';
      expect(await services.nativeCommand('capabilities', ['--json'])).toBe(0);
      const passive = JSON.parse(output.stdout) as {
        cacheStatus: string;
        profile: { capabilities: Array<{ key: string; tier: string | null; source: string | null }> };
      };
      expect(passive.cacheStatus).toBe('rebuilt');
      expect(passive.profile.capabilities.find(({ key }) => key === 'headless.json')).toMatchObject({
        tier: 'observed',
        source: 'help',
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('workflow production CLI rejects custom state roots and an exact-output agy emulator', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-production-cli-'));
    const stateRoot = path.join(cwd, 'injected-state');
    const fakeBin = path.join(cwd, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(fakeBin, 'agy'), `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "1.1.6"
  exit 0
fi
echo "--conversation --mode --print --print-timeout --prompt-interactive --sandbox"
`, { mode: 0o700 });
    let stderr = '';
    const services = createDefaultServices({
      cwd,
      packageRoot,
      agyCommand: path.join(fakeBin, 'agy'),
      stateRoot,
      environment: { PATH: fakeBin, HOME: cwd },
      stdout: () => undefined,
      stderr: (value) => { stderr += value; },
    });
    const previousPath = process.env.PATH;
    const previousStateRoot = process.env.OMA_STATE_ROOT;
    const previousOmaConfigRoot = process.env.OMA_ANTIGRAVITY_CONFIG_ROOT;
    const previousConfigRoot = process.env.ANTIGRAVITY_CONFIG_ROOT;
    const previousProductionRunId = process.env.OMA_PRODUCTION_RUN_ID;
    try {
      process.env.OMA_STATE_ROOT = stateRoot;
      expect(await services.extendedCommand('production', ['probe', 'workflow'])).toBe(1);
      expect(stderr).toContain('rejects custom OMA_STATE_ROOT');
      delete process.env.OMA_STATE_ROOT;
      for (const name of [
        'OMA_ANTIGRAVITY_CONFIG_ROOT',
        'ANTIGRAVITY_CONFIG_ROOT',
        'OMA_PRODUCTION_RUN_ID',
      ] as const) {
        process.env[name] = path.join(cwd, name);
        stderr = '';
        expect(await services.extendedCommand('production', ['probe', 'workflow'])).toBe(1);
        expect(stderr).toContain(`rejects custom ${name}`);
        delete process.env[name];
      }
      process.env.PATH = fakeBin;
      stderr = '';
      expect(await services.extendedCommand('production', ['probe', 'workflow'])).toBe(1);
      expect(stderr).toMatch(
        /canonical agy executable is not installed|agy executable does not match the canonical installed path/u,
      );
      expect(fs.existsSync(stateRoot)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousStateRoot === undefined) delete process.env.OMA_STATE_ROOT;
      else process.env.OMA_STATE_ROOT = previousStateRoot;
      if (previousOmaConfigRoot === undefined) delete process.env.OMA_ANTIGRAVITY_CONFIG_ROOT;
      else process.env.OMA_ANTIGRAVITY_CONFIG_ROOT = previousOmaConfigRoot;
      if (previousConfigRoot === undefined) delete process.env.ANTIGRAVITY_CONFIG_ROOT;
      else process.env.ANTIGRAVITY_CONFIG_ROOT = previousConfigRoot;
      if (previousProductionRunId === undefined) delete process.env.OMA_PRODUCTION_RUN_ID;
      else process.env.OMA_PRODUCTION_RUN_ID = previousProductionRunId;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('installs and lists the built-in workflow under repository runtime state', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-cli-'));
    let stdout = '';
    let stderr = '';
    const services = createDefaultServices({
      cwd,
      packageRoot,
      stateRoot: path.join(cwd, 'state'),
      environment: { PATH: process.env.PATH, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    expect(await services.extendedCommand('workflow', ['install'])).toBe(0);
    const installed = path.join(
      cwd,
      '.agy',
      'workflows',
      'production-safety-review-1.0.0.json',
    );
    expect(fs.existsSync(installed)).toBe(true);
    expect(await services.extendedCommand('workflow', ['list'])).toBe(0);
    expect(stdout).toContain('production-safety-review');
    expect(stderr).toBe('');
  });

  test('workflow authority rejects a configured state root inside the repository', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-state-root-cli-'));
    const git = require('child_process').spawnSync as typeof import('child_process').spawnSync;
    fs.writeFileSync(path.join(cwd, 'README.md'), 'candidate\n');
    expect(git('git', ['init', '-q'], { cwd }).status).toBe(0);
    expect(git('git', ['config', 'user.email', 'oma@example.invalid'], { cwd }).status).toBe(0);
    expect(git('git', ['config', 'user.name', 'OMA Test'], { cwd }).status).toBe(0);
    expect(git('git', ['add', 'README.md'], { cwd }).status).toBe(0);
    expect(git('git', ['commit', '-qm', 'candidate'], { cwd }).status).toBe(0);
    const oid = git('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    const input = path.join(cwd, 'input.json');
    fs.writeFileSync(input, JSON.stringify({ candidate_commit: oid }));
    const stateRoot = path.join(cwd, 'state');
    let stderr = '';
    const services = createDefaultServices({
      cwd,
      packageRoot,
      stateRoot,
      environment: { PATH: process.env.PATH, HOME: cwd },
      stdout: () => undefined,
      stderr: (value) => { stderr += value; },
    });
    expect(await services.extendedCommand('workflow', ['install'])).toBe(0);
    expect(await services.extendedCommand(
      'workflow',
      ['run', 'production-safety-review', '--input', input],
    )).toBe(1);
    expect(stderr).toContain('workflow authority state root must be repository-external');
    expect(fs.existsSync(path.join(stateRoot, 'trust', 'workflow-v1.key'))).toBe(false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('production verification fails closed when every live evidence seam is absent', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-production-cli-'));
    fs.writeFileSync(path.join(cwd, 'README.md'), '# candidate\n');
    const git = require('child_process').spawnSync as typeof import('child_process').spawnSync;
    expect(git('git', ['init', '-q'], { cwd }).status).toBe(0);
    expect(git('git', ['config', 'user.email', 'oma@example.invalid'], { cwd }).status).toBe(0);
    expect(git('git', ['config', 'user.name', 'OMA Test'], { cwd }).status).toBe(0);
    expect(git('git', ['add', 'README.md'], { cwd }).status).toBe(0);
    expect(git('git', ['commit', '-qm', 'test'], { cwd }).status).toBe(0);
    const fabricated = path.join(cwd, 'fabricated.json');
    fs.writeFileSync(fabricated, JSON.stringify({
      schema_version: 1,
      oid: git('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim(),
      observed_at: new Date().toISOString(),
      seam: 'managed-lifecycle',
      pre_invocation_exact_bind: true,
      stop_n_continue: true,
    }));
    let stdout = '';
    let stderr = '';
    const services = createDefaultServices({
      cwd,
      packageRoot,
      agyCommand: path.join(cwd, 'missing-agy'),
      stateRoot: path.join(cwd, 'state'),
      environment: {
        PATH: process.env.PATH,
        HOME: cwd,
        OMA_PRODUCTION_LIFECYCLE_EVIDENCE: fabricated,
      },
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    expect(await services.extendedCommand('production', ['verify', '--run-id', 'missing-run'])).toBe(1);
    const report = JSON.parse(stdout) as { ok: boolean; seams: Array<{ passed: boolean }> };
    expect(report.ok).toBe(false);
    expect(report.seams).toHaveLength(7);
    expect(report.seams.every((seam) => seam.passed === false)).toBe(true);
    expect(stderr).toContain('E_PRODUCTION_EVIDENCE');
    expect(fs.existsSync(path.join(cwd, 'state'))).toBe(false);
  });

  test('production verification defaults run identity to the exact candidate OID', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-production-default-run-'));
    fs.writeFileSync(path.join(cwd, 'README.md'), '# candidate\n');
    const git = require('child_process').spawnSync as typeof import('child_process').spawnSync;
    expect(git('git', ['init', '-q'], { cwd }).status).toBe(0);
    expect(git('git', ['config', 'user.email', 'oma@example.invalid'], { cwd }).status).toBe(0);
    expect(git('git', ['config', 'user.name', 'OMA Test'], { cwd }).status).toBe(0);
    expect(git('git', ['add', 'README.md'], { cwd }).status).toBe(0);
    expect(git('git', ['commit', '-qm', 'test'], { cwd }).status).toBe(0);
    const oid = git('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    let stdout = '';
    const services = createDefaultServices({
      cwd,
      packageRoot,
      stateRoot: path.join(cwd, 'missing-state'),
      environment: { PATH: process.env.PATH, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    });
    expect(await services.extendedCommand('production', ['verify'])).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ run_id: oid, oid });
    expect(fs.existsSync(path.join(cwd, 'missing-state'))).toBe(false);
  });

  test('parity composition verifies the canonical revision-2 final aggregate', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-parity-cli-'));
    const runId = 'run-1';
    const aggregatePath = runManifest.expectedRepositoryAggregatePath(cwd, runId);
    fs.mkdirSync(path.dirname(aggregatePath), { recursive: true });
    const inputPayload = { store_kind: 'repo_aggregate_input_payload', run_id: runId };
    const finalPayload = {
      store_kind: 'repo_aggregate_final_payload',
      run_id: runId,
      run_manifest_revision: 4,
      lease_generation: 4,
    };
    const inputEnvelope = {
      payload: inputPayload,
      payload_hash: sha256Hex(canonicalBytesV1(inputPayload)),
      signer_id: 'OMA-W6-aggregate-signer',
      key_id: 'a'.repeat(64),
      phase: 'input',
      signature: 'b'.repeat(64),
    };
    const finalEnvelope = {
      payload: finalPayload,
      payload_hash: sha256Hex(canonicalBytesV1(finalPayload)),
      signer_id: 'OMA-W6-aggregate-signer',
      key_id: 'a'.repeat(64),
      phase: 'final',
      signature: 'c'.repeat(64),
    };
    fs.writeFileSync(aggregatePath, canonicalBytesV1({
      store_kind: 'repo_aggregate_handoff',
      schema_version: 1,
      repository_id: 'OMA',
      run_id: runId,
      revision: 2,
      previous_aggregate_hash: 'd'.repeat(64),
      input_envelope: inputEnvelope,
      final_envelope: finalEnvelope,
    }), { mode: 0o600 });
    const verifyAggregate = jest.spyOn(runManifest, 'verifyRepositoryAggregate')
      .mockImplementation(() => undefined);
    const verifyManifest = jest.spyOn(runManifest, 'verifyRunManifestAtPath')
      .mockReturnValue({
        run_id: runId,
        revision: 5,
        lease_generation: 5,
        state: 'signing_revoked',
      } as ReturnType<typeof runManifest.verifyRunManifestAtPath>);
    let stdout = '';
    let stderr = '';
    const services = createDefaultServices({
      cwd,
      packageRoot,
      stateRoot: path.join(cwd, 'state'),
      environment: { PATH: process.env.PATH, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    try {
      expect(await services.extendedCommand('parity', [
        'verify-composition', '--workspace', cwd, '--run-id', runId,
        '--aggregate', aggregatePath,
      ])).toBe(0);
      expect(verifyAggregate).toHaveBeenCalledWith(expect.objectContaining({
        workspace_path: cwd,
        run_id: runId,
        phase: 'final',
        envelope: finalEnvelope,
      }));
      expect(verifyManifest).toHaveBeenCalledTimes(1);
      expect(JSON.parse(stdout)).toEqual(expect.objectContaining({
        ok: true,
        phase: 'final',
        aggregate_revision: 2,
        manifest_state: 'signing_revoked',
      }));
      const copiedPath = path.join(cwd, 'copied-aggregate.json');
      fs.copyFileSync(aggregatePath, copiedPath);
      expect(await services.extendedCommand('parity', [
        'verify-composition', '--workspace', cwd, '--run-id', runId,
        '--aggregate', copiedPath,
      ])).toBe(1);
      expect(stderr).toContain('exact canonical repository artifact');
    } finally {
      verifyAggregate.mockRestore();
      verifyManifest.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
