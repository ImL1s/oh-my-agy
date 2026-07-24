import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computePackageIdentity } from '../../src/setup/installed-identity';
import { PluginCommandAdapter, PluginCommandResult } from '../../src/setup/plugin';
import { readInstallReceipt } from '../../src/setup/receipt';
import {
  ReleaseAttestationContext,
  attestReleaseAsset,
  verifyReleaseAssetChecksum,
} from '../../scripts/release-attest';

const packageRoot = path.resolve(__dirname, '../..');

function writable(root: string): void {
  if (!fs.existsSync(root)) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) writable(absolute);
    else if (entry.isSymbolicLink()) continue;
    else fs.chmodSync(absolute, 0o600);
  }
}

function surface(root: string, version: string, marker = version): void {
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
  fs.writeFileSync(path.join(root, 'dist', 'bin', 'oma.js'), `#!/usr/bin/env node\n${marker}\n`);
  fs.chmodSync(path.join(root, 'dist', 'bin', 'oma.js'), 0o755);
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'pre-invocation.js'), marker);
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'stop.js'), marker);
  fs.writeFileSync(
    path.join(root, 'skills', 'autopilot', 'SKILL.md'),
    '# IN-SESSION PRIMARY\nYou are already in the agent session.\n',
  );
  fs.writeFileSync(path.join(root, 'rules', 'runtime.md'), marker);
}

class InstallingAdapter implements PluginCommandAdapter {
  constructor(private readonly installedRoot: string) {}

  async run(argv: readonly string[]): Promise<PluginCommandResult> {
    if (argv.join(' ') === 'plugin list') {
      return {
        argv: [...argv], code: 0,
        stdout: fs.existsSync(path.join(this.installedRoot, 'plugin.json'))
          ? JSON.stringify({ imports: [{ name: 'oh-my-agy', source: 'release-test' }] })
          : JSON.stringify({ imports: [] }),
        stderr: '',
      };
    }
    if (argv[0] === 'plugin' && argv[1] === 'install' && argv[2]) {
      if (fs.existsSync(this.installedRoot)) {
        writable(this.installedRoot);
        fs.rmSync(this.installedRoot, { recursive: true, force: true });
      }
      fs.cpSync(argv[2], this.installedRoot, { recursive: true, dereference: true });
    }
    if (argv[0] === 'plugin' && argv[1] === 'uninstall' && fs.existsSync(this.installedRoot)) {
      writable(this.installedRoot);
      fs.rmSync(this.installedRoot, { recursive: true, force: true });
    }
    return { argv: [...argv], code: 0, stdout: 'ok\n', stderr: '' };
  }
}

function archive(source: string, target: string): void {
  const staged = path.join(path.dirname(target), 'package');
  fs.cpSync(source, staged, { recursive: true });
  const result = spawnSync('tar', ['-czf', target, 'package'], { cwd: path.dirname(target) });
  expect(result.status).toBe(0);
  fs.rmSync(staged, { recursive: true, force: true });
}

function copyShippingPackage(target: string): void {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    files: string[];
  };
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const relative of pkg.files) {
    const from = path.join(packageRoot, relative);
    const to = path.join(target, relative);
    if (fs.statSync(from).isDirectory()) fs.cpSync(from, to, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
  fs.copyFileSync(path.join(packageRoot, 'package.json'), path.join(target, 'package.json'));
}

function executable(name: string): string {
  if (name === 'node') return process.execPath;
  const result = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  if (result.status !== 0 || result.stdout.trim() === '') throw new Error(`missing test tool: ${name}`);
  return result.stdout.trim();
}

function writeExecutable(target: string, body: string): void {
  fs.writeFileSync(target, body, { mode: 0o700 });
  fs.chmodSync(target, 0o700);
}

interface InstallerHarness {
  root: string;
  toolbox: string;
  home: string;
  state: string;
  config: string;
  binDir: string;
  env: NodeJS.ProcessEnv;
}

function installerHarness(root: string, asset: string, checksums: string): InstallerHarness {
  const toolbox = path.join(root, 'toolbox');
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const config = path.join(root, 'config');
  const binDir = path.join(root, 'installed-bin');
  const temp = path.join(root, 'tmp');
  for (const directory of [toolbox, home, state, config, binDir, temp]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  for (const command of [
    'bash', 'dirname', 'basename', 'mktemp', 'chmod', 'stat', 'cp', 'tar',
    // gzip: GNU tar (Linux/CI) shells out to it for .tgz; macOS bsdtar handles
    // gzip internally and never execs it. Sealing PATH without gzip made the
    // installer tests pass on macOS but fail on CI with "gzip: Cannot exec".
    'gzip', 'mkdir', 'rm', 'shasum', 'which',
  ]) fs.symlinkSync(executable(command), path.join(toolbox, command));
  fs.symlinkSync(process.execPath, path.join(toolbox, 'node'));

  writeExecutable(path.join(toolbox, 'npm'), `#!/bin/bash
printf 'npm-called\\n' >> "$OMA_TEST_NPM_LOG"
exit 91
`);
  writeExecutable(path.join(toolbox, 'curl'), `#!/bin/bash
set -e
printf '%s\\n' "$*" >> "$OMA_TEST_CURL_LOG"
[[ "\${OMA_TEST_CURL_MODE:-forbid}" == release ]] || exit 92
out=''; url=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
[[ -n "$out" && -n "$url" ]] || exit 93
case "$url" in
  */SHA256SUMS) cp "$OMA_TEST_CHECKSUMS" "$out" ;;
  */iml1s-oh-my-agy-*.tgz) cp "$OMA_TEST_ASSET" "$out" ;;
  *) exit 94 ;;
esac
`);
  writeExecutable(path.join(toolbox, 'agy'), `#!/bin/bash
set -e
printf '%s\\n' "$*" >> "$OMA_TEST_AGY_LOG"
root="$OMA_ANTIGRAVITY_CONFIG_ROOT/plugins/oh-my-agy"
if [[ "\${1:-}" == '--version' ]]; then echo 1.1.6; exit 0; fi
[[ "\${1:-}" == plugin ]] || exit 2
case "\${2:-}" in
  help|validate|enable) echo ok ;;
  list)
    if [[ -f "$root/package.json" ]]; then
      version="$(node -p 'require(process.argv[1]).version' "$root/package.json")"
      node -e 'const [version,root]=process.argv.slice(1);console.log(JSON.stringify({imports:[{name:"oh-my-agy",enabled:true,version,installPath:root,source:"sealed-test",components:["hooks","skills"]}]}))' "$version" "$root"
    else
      printf '{"imports":[]}\\n'
    fi ;;
  install)
    [[ "\${OMA_TEST_AGY_FAIL_INSTALL:-0}" != 1 ]] || exit 95
    rm -rf "$root"
    mkdir -p "$(dirname "$root")"
    cp -R "$3" "$root"
    chmod -R u+rwX "$root"
    echo ok ;;
  uninstall) rm -rf "$root"; echo ok ;;
  *) exit 2 ;;
esac
`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    TMPDIR: temp,
    PATH: `${binDir}${path.delimiter}${toolbox}`,
    OMA_STATE_ROOT: state,
    OMA_ANTIGRAVITY_CONFIG_ROOT: config,
    ANTIGRAVITY_CONFIG_ROOT: config,
    OMA_BIN_DIR: binDir,
    OMA_TEST_ASSET: asset,
    OMA_TEST_CHECKSUMS: checksums,
    OMA_TEST_NPM_LOG: path.join(root, 'npm.log'),
    OMA_TEST_CURL_LOG: path.join(root, 'curl.log'),
    OMA_TEST_AGY_LOG: path.join(root, 'agy.log'),
  };
  return { root, toolbox, home, state, config, binDir, env };
}

function installReceiptPaths(stateRoot: string): string[] {
  const root = path.join(stateRoot, 'install', 'receipts');
  return fs.existsSync(root)
    ? fs.readdirSync(root).filter((name) => name.endsWith('.json')).map((name) => path.join(root, name))
    : [];
}

describe('fresh-home release install attestation', () => {
  let scratch: string;
  let source: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-release-install-'));
    source = path.join(scratch, 'source');
    surface(source, '1.0.0', 'candidate');
  });

  afterEach(() => {
    writable(scratch);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test('checksum mismatch fails before adapter creation or host mutation', async () => {
    const asset = path.join(scratch, 'oma.tgz');
    const checksums = path.join(scratch, 'SHA256SUMS');
    archive(source, asset);
    fs.writeFileSync(checksums, `${'0'.repeat(64)}  oma.tgz\n`);
    let adapterCreated = false;
    expect(verifyReleaseAssetChecksum(asset, checksums).ok).toBe(false);
    const result = await attestReleaseAsset({
      assetPath: asset,
      checksumManifestPath: checksums,
      workRoot: path.join(scratch, 'work'),
      adapterFactory: () => {
        adapterCreated = true;
        return new InstallingAdapter(path.join(scratch, 'must-not-exist'));
      },
    });
    expect(result.ok).toBe(false);
    expect(adapterCreated).toBe(false);
    expect(fs.existsSync(path.join(scratch, 'must-not-exist'))).toBe(false);
  });

  test('directory asset installs into isolated HOME/config/state and passes release doctor 0', async () => {
    const identity = computePackageIdentity(source);
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    const result = await attestReleaseAsset({
      assetPath: source,
      expectedAssetSha256: identity.value.digest,
      workRoot: path.join(scratch, 'work'),
      agyCommand: 'true',
      restoreAfterSuccess: false,
      adapterFactory: (context) => new InstallingAdapter(
        path.join(context.configRoot, 'plugins', 'oh-my-agy'),
      ),
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        doctorExitCode: 0,
        packageDigest: identity.value.digest,
        restoredPrior: false,
      }),
    }));
    if (!result.ok) return;
    expect(result.value.homeDir.startsWith(fs.realpathSync(path.join(scratch, 'work')))).toBe(true);
    expect(fs.realpathSync(result.value.installedPath).startsWith(fs.realpathSync(result.value.configRoot)))
      .toBe(true);
    expect(readInstallReceipt(result.value.receiptPath).ok).toBe(true);
  });

  test('verified archive can restore the exact prior plugin and CLI pointers after attestation', async () => {
    const asset = path.join(scratch, 'oma.tgz');
    const checksums = path.join(scratch, 'SHA256SUMS');
    archive(source, asset);
    const digest = verifyReleaseAssetChecksum(asset);
    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    fs.writeFileSync(checksums, `${digest.value}  oma.tgz\n`);
    let priorRoot = '';
    const result = await attestReleaseAsset({
      assetPath: asset,
      checksumManifestPath: checksums,
      workRoot: path.join(scratch, 'work'),
      agyCommand: 'true',
      restoreAfterSuccess: true,
      adapterFactory: (context: ReleaseAttestationContext) => {
        priorRoot = path.join(context.root, 'prior');
        surface(priorRoot, '0.9.0', 'previous');
        const installed = path.join(context.configRoot, 'plugins', 'oh-my-agy');
        fs.cpSync(priorRoot, installed, { recursive: true });
        fs.mkdirSync(context.binDir, { recursive: true });
        fs.symlinkSync(path.join(priorRoot, 'dist', 'bin', 'oma.js'), path.join(context.binDir, 'oma'));
        fs.symlinkSync(path.join(priorRoot, 'dist', 'bin', 'oma.js'), path.join(context.binDir, 'omy'));
        return new InstallingAdapter(installed);
      },
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ restoredPrior: true }),
    }));
    if (!result.ok) return;
    expect(JSON.parse(fs.readFileSync(
      path.join(result.value.configRoot, 'plugins', 'oh-my-agy', 'package.json'),
      'utf8',
    )).version).toBe('0.9.0');
    expect(fs.realpathSync(path.join(result.value.binDir, 'oma')))
      .toBe(fs.realpathSync(path.join(priorRoot, 'dist', 'bin', 'oma.js')));
  });

  test('install shell delegates to immutable updater and never masks doctor failure', () => {
    const body = fs.readFileSync(path.resolve(__dirname, '../../scripts/install.sh'), 'utf8');
    expect(body).toContain('dist/src/setup/update.js');
    expect(body).toContain('--preflight-only');
    expect(body).toContain('--local-dev');
    expect(body).toContain('iml1s-oh-my-agy-$VERSION.tgz');
    expect(body).not.toMatch(/doctor[^\n]*\|\|\s*true/);
    expect(body).not.toContain('ln -sfn');
    expect(body).toContain('PRIMARY_STATUS');
    expect(body).toContain('# LOCAL_DEV_NETWORK_BUILD_START');
    expect(body).toContain('# LOCAL_DEV_NETWORK_BUILD_END');
    const nonDevelopment = body.replace(
      /# LOCAL_DEV_NETWORK_BUILD_START[\s\S]*?# LOCAL_DEV_NETWORK_BUILD_END/,
      '',
    );
    expect(nonDevelopment).not.toMatch(/\bnpm\s+(?:ci|install)|npm run build|\bnpx\b/);
  });

  test('smoke lanes retain fresh-home and exact installed-identity gates', () => {
    const smoke = fs.readFileSync(path.resolve(__dirname, '../../scripts/smoke.sh'), 'utf8');
    const full = fs.readFileSync(
      path.resolve(__dirname, '../../scripts/smoke-full-product.ts'),
      'utf8',
    );
    expect(smoke).toContain('tests/setup/release-install.spec.ts');
    expect(smoke).toContain('dist/src/setup/installed-identity.js');
    expect(full).toContain('INSTALL_IDENTITY_SMOKE_OK');
    expect(full).toContain('stageImmutablePackage');
  });
});

describe('standalone and offline install shell acceptance', () => {
  let suiteRoot: string;
  let asset: string;
  let checksums: string;
  let assetDigest: string;
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;

  beforeAll(() => {
    suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-install-shell-'));
    const releaseRoot = path.join(suiteRoot, 'release-package');
    copyShippingPackage(releaseRoot);
    asset = path.join(suiteRoot, `iml1s-oh-my-agy-${version}.tgz`);
    archive(releaseRoot, asset);
    const digest = verifyReleaseAssetChecksum(asset);
    if (!digest.ok) throw new Error(digest.error.message);
    assetDigest = digest.value;
    checksums = path.join(suiteRoot, 'SHA256SUMS');
    fs.writeFileSync(checksums, `${assetDigest}  ${path.basename(asset)}\n`, { mode: 0o600 });
  });

  afterAll(() => {
    writable(suiteRoot);
    fs.rmSync(suiteRoot, { recursive: true, force: true });
  });

  function run(
    harness: InstallerHarness,
    installer: string,
    argv: string[],
    env: NodeJS.ProcessEnv = harness.env,
  ): ReturnType<typeof spawnSync> {
    return spawnSync('/bin/bash', [installer, ...argv], {
      cwd: harness.root,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
  }

  test('manual archive + SHA256SUMS succeeds with sealed PATH and zero curl/npm/build', () => {
    const root = path.join(suiteRoot, 'offline-success');
    const harness = installerHarness(root, asset, checksums);
    const result = run(harness, path.join(packageRoot, 'scripts', 'install.sh'), [
      '--asset', asset, '--checksums', checksums, '--no-auxiliary',
    ]);
    expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
      status: 0, signal: null, stderr: '',
    });
    expect(result.stdout).toContain('installed and exactly verified');
    expect(fs.existsSync(path.join(root, 'npm.log'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'curl.log'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'agy.log'), 'utf8')).toContain('plugin install');
    const receipts = installReceiptPaths(harness.state);
    expect(receipts).toHaveLength(1);
    const receipt = readInstallReceipt(receipts[0]);
    expect(receipt).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        source: expect.objectContaining({
          assetSha256: assetDigest,
          tag: `v${version}`,
        }),
        installed: expect.objectContaining({ version }),
      }),
    }));
    expect(fs.realpathSync(path.join(harness.binDir, 'oma')))
      .toContain(`${path.sep}install${path.sep}stages${path.sep}`);
  }, 120_000);

  test('manual archive + explicit digest succeeds offline without checksum file access', () => {
    const root = path.join(suiteRoot, 'offline-explicit-digest');
    const harness = installerHarness(root, asset, path.join(root, 'must-not-read'));
    const result = run(harness, path.join(packageRoot, 'scripts', 'install.sh'), [
      '--asset', asset, '--asset-sha256', assetDigest, '--no-auxiliary',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('installed and exactly verified');
    expect(fs.existsSync(path.join(root, 'curl.log'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'npm.log'))).toBe(false);
    const receipt = readInstallReceipt(installReceiptPaths(harness.state)[0]);
    expect(receipt).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        source: expect.objectContaining({ assetSha256: assetDigest }),
      }),
    }));
  }, 120_000);

  test('copied standalone script downloads exact immutable tag URLs without a checkout', () => {
    const root = path.join(suiteRoot, 'github-success');
    const harness = installerHarness(root, asset, checksums);
    const standalone = path.join(root, 'bootstrap', 'install.sh');
    fs.mkdirSync(path.dirname(standalone), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(packageRoot, 'scripts', 'install.sh'), standalone);
    fs.chmodSync(standalone, 0o700);
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(false);
    const result = run(harness, standalone, [
      '--github', '--tag', `v${version}`, '--no-auxiliary',
    ], { ...harness.env, OMA_TEST_CURL_MODE: 'release' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('installed and exactly verified');
    expect(fs.existsSync(path.join(root, 'npm.log'))).toBe(false);
    const curlLog = fs.readFileSync(path.join(root, 'curl.log'), 'utf8');
    expect(curlLog).toContain(`/releases/download/v${version}/iml1s-oh-my-agy-${version}.tgz`);
    expect(curlLog).toContain(`/releases/download/v${version}/SHA256SUMS`);
    const receipt = readInstallReceipt(installReceiptPaths(harness.state)[0]);
    expect(receipt).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        source: expect.objectContaining({
          assetSha256: assetDigest,
          tag: `v${version}`,
          uri: `https://github.com/ImL1s/oh-my-agy/releases/download/v${version}/iml1s-oh-my-agy-${version}.tgz`,
        }),
      }),
    }));
  }, 120_000);

  test('checksum mismatch fails before candidate execution or any host mutation', () => {
    const root = path.join(suiteRoot, 'checksum-failure');
    const bad = path.join(root, 'SHA256SUMS');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(bad, `${'0'.repeat(64)}  ${path.basename(asset)}\n`);
    const harness = installerHarness(root, asset, bad);
    const result = run(harness, path.join(packageRoot, 'scripts', 'install.sh'), [
      '--asset', asset, '--checksums', bad, '--no-auxiliary',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('checksum mismatch');
    expect(fs.existsSync(path.join(root, 'agy.log'))).toBe(false);
    expect(fs.existsSync(path.join(harness.config, 'plugins', 'oh-my-agy'))).toBe(false);
    expect(installReceiptPaths(harness.state)).toEqual([]);
  });

  test('valid checksum with mismatched asset/package version fails before host mutation', () => {
    const root = path.join(suiteRoot, 'version-failure');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const wrongName = path.join(root, 'iml1s-oh-my-agy-9.9.9.tgz');
    fs.copyFileSync(asset, wrongName);
    const manifest = path.join(root, 'SHA256SUMS');
    fs.writeFileSync(manifest, `${assetDigest}  ${path.basename(wrongName)}\n`);
    const harness = installerHarness(root, wrongName, manifest);
    const result = run(harness, path.join(packageRoot, 'scripts', 'install.sh'), [
      '--asset', wrongName, '--checksums', manifest, '--no-auxiliary',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('package version does not match asset/tag identity');
    expect(fs.existsSync(path.join(root, 'agy.log'))).toBe(false);
    expect(installReceiptPaths(harness.state)).toEqual([]);
  });

  test('verified archive missing the updater runtime fails before candidate execution', () => {
    const root = path.join(suiteRoot, 'missing-updater');
    const releaseRoot = path.join(root, 'release-package');
    copyShippingPackage(releaseRoot);
    fs.rmSync(path.join(releaseRoot, 'dist', 'src', 'setup', 'update.js'));
    const badAsset = path.join(root, `iml1s-oh-my-agy-${version}.tgz`);
    archive(releaseRoot, badAsset);
    const digest = verifyReleaseAssetChecksum(badAsset);
    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    const manifest = path.join(root, 'SHA256SUMS');
    fs.writeFileSync(manifest, `${digest.value}  ${path.basename(badAsset)}\n`);
    const harness = installerHarness(path.join(root, 'harness'), badAsset, manifest);
    const result = run(harness, path.join(packageRoot, 'scripts', 'install.sh'), [
      '--asset', badAsset, '--checksums', manifest, '--no-auxiliary',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing runnable surface: dist/src/setup/update.js');
    expect(fs.existsSync(path.join(harness.root, 'agy.log'))).toBe(false);
    expect(installReceiptPaths(harness.state)).toEqual([]);
  });

  test('updater hard failure cannot print success or create a receipt', () => {
    const root = path.join(suiteRoot, 'updater-failure');
    const harness = installerHarness(root, asset, checksums);
    const result = run(harness, path.join(packageRoot, 'scripts', 'install.sh'), [
      '--asset', asset, '--checksums', checksums, '--no-auxiliary',
    ], { ...harness.env, OMA_TEST_AGY_FAIL_INSTALL: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('installed and exactly verified');
    expect(result.stderr).toContain('primary install failed');
    expect(installReceiptPaths(harness.state)).toEqual([]);
  }, 120_000);

  test.each(['gnu', 'bsd'] as const)(
    '%s stat contract validates 0700 temp without accepting incompatible output',
    (kind) => {
      const root = path.join(suiteRoot, `stat-${kind}`);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const bad = path.join(root, 'SHA256SUMS');
      fs.writeFileSync(bad, `${'0'.repeat(64)}  ${path.basename(asset)}\n`);
      const harness = installerHarness(root, asset, bad);
      fs.unlinkSync(path.join(harness.toolbox, 'stat'));
      writeExecutable(path.join(harness.toolbox, 'stat'), kind === 'gnu'
        ? `#!/bin/bash
printf '%s\\n' "$*" >> "$OMA_TEST_STAT_LOG"
[[ "$1" == -c ]] || exit 96
printf '700\\n'
`
        : `#!/bin/bash
printf '%s\\n' "$*" >> "$OMA_TEST_STAT_LOG"
if [[ "$1" == -c ]]; then exit 1; fi
[[ "$1" == -f ]] || exit 96
printf '700\\n'
`);
      const statLog = path.join(root, 'stat.log');
      const result = run(harness, path.join(packageRoot, 'scripts', 'install.sh'), [
        '--asset', asset, '--checksums', bad, '--no-auxiliary',
      ], { ...harness.env, OMA_TEST_STAT_LOG: statLog });
      expect(result.stderr).toContain('checksum mismatch');
      const calls = fs.readFileSync(statLog, 'utf8').trim().split('\n');
      expect(calls[0]).toMatch(/^-c %a /);
      if (kind === 'gnu') expect(calls).toHaveLength(1);
      else expect(calls[1]).toMatch(/^-f %Lp /);
    },
  );
});
