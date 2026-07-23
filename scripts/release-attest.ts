import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256 } from '../src/runtime/atomic';
import { RuntimeError, runtimeError } from '../src/runtime/errors';
import { Result, err, ok } from '../src/runtime/types';
import { computePackageIdentity } from '../src/setup/installed-identity';
import { PluginCommandAdapter } from '../src/setup/plugin';
import {
  ImmutableInstallUpdateSuccess,
  ImmutableInstallUpdater,
  defaultPluginCommandAdapter,
} from '../src/setup/update';

export interface ReleaseAttestationContext {
  root: string;
  homeDir: string;
  configRoot: string;
  stateRoot: string;
  binDir: string;
}

export interface ReleaseAttestationInput {
  assetPath: string;
  checksumManifestPath?: string;
  expectedAssetSha256?: string;
  workRoot?: string;
  agyCommand?: string;
  adapterFactory?: (context: ReleaseAttestationContext) => PluginCommandAdapter;
  restoreAfterSuccess?: boolean;
  sourceUri?: string | null;
  sourceTag?: string | null;
  peeledCommit?: string | null;
  hostVersion?: string | null;
  idFactory?: () => string;
}

export interface ReleaseAttestationSuccess extends ImmutableInstallUpdateSuccess {
  assetPath: string;
  assetSha256: string;
  packageRoot: string;
  packageDigest: string;
  root: string;
  homeDir: string;
  configRoot: string;
  stateRoot: string;
  binDir: string;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function digestFile(filePath: string): Result<string, RuntimeError> {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'release asset must be a regular file'));
    }
    return ok(sha256(fs.readFileSync(filePath)));
  } catch (error) {
    return err(runtimeError('E_NOT_FOUND', 'release asset cannot be read', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

/** Verify a file against SHA256SUMS, or return its digest when no manifest is supplied. */
export function verifyReleaseAssetChecksum(
  assetPath: string,
  checksumManifestPath?: string,
): Result<string, RuntimeError> {
  const asset = path.resolve(assetPath);
  if (fs.existsSync(asset) && fs.lstatSync(asset).isDirectory()) {
    if (checksumManifestPath !== undefined) {
      return err(runtimeError(
        'E_VALIDATOR_REJECTED',
        'checksum manifests apply to immutable archive files, not directories',
      ));
    }
    const identity = computePackageIdentity(asset);
    return identity.ok ? ok(identity.value.digest) : identity;
  }
  const actual = digestFile(asset);
  if (!actual.ok || checksumManifestPath === undefined) return actual;
  try {
    const checksumPath = path.resolve(checksumManifestPath);
    const stat = fs.lstatSync(checksumPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'checksum manifest must be a regular file'));
    }
    const assetName = path.basename(asset);
    const matches: string[] = [];
    for (const line of fs.readFileSync(checksumPath, 'utf8').split(/\r?\n/)) {
      if (line.trim() === '') continue;
      const match = /^([a-fA-F0-9]{64})[ \t]+[* ]?(.+)$/.exec(line);
      if (match === null) {
        return err(runtimeError('E_VALIDATOR_REJECTED', 'checksum manifest is malformed'));
      }
      const fileName = match[2].replace(/^\.\//, '');
      if (fileName === assetName) matches.push(match[1].toLowerCase());
    }
    if (matches.length !== 1 || matches[0] !== actual.value) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'release asset checksum mismatch', {
        assetName,
        expected: matches.length === 1 ? matches[0] : null,
        actual: actual.value,
        matchingRows: matches.length,
      }));
    }
    return actual;
  } catch (error) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'checksum manifest cannot be verified', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

function validateArchiveEntry(value: string): boolean {
  if (value === '' || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value.replace(/\/$/, ''));
  return normalized !== '..' && !normalized.startsWith('../');
}

function assertNoLinks(root: string): Result<void, RuntimeError> {
  try {
    const visit = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error(`archive contains symlink: ${absolute}`);
        if (stat.isDirectory()) visit(absolute);
      }
    };
    visit(root);
    return ok(undefined);
  } catch (error) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'release archive contains unsafe links', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

function extractReleaseArchive(
  assetPath: string,
  extractionRoot: string,
): Result<string, RuntimeError> {
  const list = spawnSync('tar', ['-tzf', assetPath], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (list.status !== 0) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'release archive listing failed', {
      exitCode: list.status,
      stderrSha256: sha256(list.stderr ?? ''),
    }));
  }
  const entries = (list.stdout ?? '').split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !validateArchiveEntry(entry))) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'release archive contains unsafe paths'));
  }
  fs.mkdirSync(extractionRoot, { recursive: true, mode: 0o700 });
  const extracted = spawnSync('tar', ['-xzf', assetPath, '-C', extractionRoot], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (extracted.status !== 0) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'release archive extraction failed', {
      exitCode: extracted.status,
      stderrSha256: sha256(extracted.stderr ?? ''),
    }));
  }
  const links = assertNoLinks(extractionRoot);
  if (!links.ok) return links;
  const roots: string[] = [];
  const visit = (current: string): void => {
    if (fs.existsSync(path.join(current, 'package.json'))) roots.push(current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(current, entry.name));
    }
  };
  visit(extractionRoot);
  if (roots.length !== 1) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'release archive must contain one package root', {
      packageRoots: roots,
    }));
  }
  return ok(fs.realpathSync(roots[0]));
}

function freshContext(workRoot?: string): Result<ReleaseAttestationContext, RuntimeError> {
  try {
    const parent = path.resolve(workRoot ?? os.tmpdir());
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(parent).isSymbolicLink()) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'release work root cannot be a symlink'));
    }
    const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'oma-release-attest-')));
    const context = {
      root,
      homeDir: path.join(root, 'home'),
      configRoot: path.join(root, 'home', '.gemini', 'config'),
      stateRoot: path.join(root, 'state'),
      binDir: path.join(root, 'home', '.local', 'bin'),
    };
    for (const directory of [
      context.homeDir, context.configRoot, context.stateRoot, context.binDir,
    ]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return ok(context);
  } catch (error) {
    return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'fresh release roots cannot be created', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

export async function attestReleaseAsset(
  input: Readonly<ReleaseAttestationInput>,
): Promise<Result<ReleaseAttestationSuccess, RuntimeError>> {
  const assetPath = path.resolve(input.assetPath);
  const assetDigest = verifyReleaseAssetChecksum(assetPath, input.checksumManifestPath);
  if (!assetDigest.ok) return assetDigest;
  if (input.expectedAssetSha256 !== undefined) {
    const expected = input.expectedAssetSha256.toLowerCase();
    if (!isSha256(expected) || expected !== assetDigest.value) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'release asset digest is not expected', {
        expected,
        actual: assetDigest.value,
      }));
    }
  }
  const context = freshContext(input.workRoot);
  if (!context.ok) return context;
  const packageRoot = fs.lstatSync(assetPath).isDirectory()
    ? ok(fs.realpathSync(assetPath))
    : extractReleaseArchive(assetPath, path.join(context.value.root, 'extracted'));
  if (!packageRoot.ok) return packageRoot;
  const packageIdentity = computePackageIdentity(packageRoot.value);
  if (!packageIdentity.ok) return packageIdentity;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: context.value.homeDir,
    OMA_STATE_ROOT: context.value.stateRoot,
    OMA_ANTIGRAVITY_CONFIG_ROOT: context.value.configRoot,
    ANTIGRAVITY_CONFIG_ROOT: context.value.configRoot,
    PATH: `${context.value.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  const agyCommand = input.agyCommand ?? 'agy';
  const adapter = input.adapterFactory?.(context.value)
    ?? defaultPluginCommandAdapter(agyCommand, env);
  const hostVersion = input.hostVersion === undefined
    ? probeHostVersion(agyCommand, env)
    : input.hostVersion;
  const updater = new ImmutableInstallUpdater({
    packageRoot: packageRoot.value,
    expectedPackageDigest: packageIdentity.value.digest,
    assetSha256: assetDigest.value,
    stateRoot: context.value.stateRoot,
    antigravityConfigRoot: context.value.configRoot,
    homeDir: context.value.homeDir,
    binDir: context.value.binDir,
    adapter,
    mode: 'release',
    agyCommand,
    restoreAfterSuccess: input.restoreAfterSuccess ?? true,
    sourceUri: input.sourceUri,
    sourceTag: input.sourceTag,
    peeledCommit: input.peeledCommit,
    hostVersion,
    idFactory: input.idFactory,
  });
  const installed = await updater.run();
  if (!installed.ok) return installed;
  return ok({
    ...installed.value,
    assetPath,
    assetSha256: assetDigest.value,
    packageRoot: packageRoot.value,
    packageDigest: packageIdentity.value.digest,
    ...context.value,
  });
}

function probeHostVersion(command: string, env: NodeJS.ProcessEnv): string | null {
  const probe = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 15_000, env });
  if (probe.status !== 0) return null;
  const version = (probe.stdout ?? '').trim();
  return version === '' ? null : version.slice(0, 200);
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function cli(argv: readonly string[]): Promise<number> {
  const assetPath = option(argv, '--asset');
  if (assetPath === undefined) {
    process.stderr.write('usage: release-attest --asset <oma.tgz|package-dir> [--checksums SHA256SUMS]\n');
    return 2;
  }
  if (!fs.lstatSync(path.resolve(assetPath)).isDirectory()
    && option(argv, '--checksums') === undefined
    && option(argv, '--asset-sha256') === undefined) {
    process.stderr.write('archive attestation requires --checksums or --asset-sha256\n');
    return 2;
  }
  const result = await attestReleaseAsset({
    assetPath,
    checksumManifestPath: option(argv, '--checksums'),
    expectedAssetSha256: option(argv, '--asset-sha256'),
    workRoot: option(argv, '--work-root'),
    agyCommand: option(argv, '--agy'),
    restoreAfterSuccess: !argv.includes('--keep-installed'),
    sourceUri: option(argv, '--source-uri'),
    sourceTag: option(argv, '--source-tag'),
    peeledCommit: option(argv, '--peeled-commit'),
  });
  if (!result.ok) {
    process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...result.value })}\n`);
  return 0;
}

if (require.main === module) {
  cli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
