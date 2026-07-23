import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalJson, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';

export interface ShippingInventoryEntryV1 {
  path: string;
  byteLength: number;
  sha256: string;
  executable: boolean;
}

export interface PackageEntrypointsV1 {
  cli: string;
  preInvocation: string;
  stop: string;
}

export interface PackageIdentityV1 {
  schemaVersion: 1;
  packageName: string;
  pluginName: string;
  version: string;
  rootPath: string;
  digest: string;
  inventory: ShippingInventoryEntryV1[];
  entrypoints: PackageEntrypointsV1;
}

export interface RegistryIdentityHintV1 {
  present: boolean;
  enabled?: boolean;
  version?: string;
  installPath?: string;
  source?: string;
  components?: readonly string[];
}

export interface InstalledPluginIdentityV1 extends PackageIdentityV1 {
  installPath: string;
  registry: {
    present: true;
    enabled: boolean;
    source: string | null;
    version: string | null;
    installPath: string | null;
    components: string[];
  };
}

export interface ResolveInstalledPluginIdentityInput {
  pluginName: string;
  registry: RegistryIdentityHintV1;
  antigravityConfigRoot?: string;
  homeDir?: string;
}

const REQUIRED_RELATIVE_PATHS = [
  'package.json',
  'plugin.json',
  'hooks.json',
  'dist/bin/oma.js',
  'dist/src/hooks/pre-invocation.js',
  'dist/src/hooks/stop.js',
] as const;

const PRE_INVOCATION_COMMAND = 'node "${extensionPath}/dist/src/hooks/pre-invocation.js"';
const STOP_COMMAND = 'node "${extensionPath}/dist/src/hooks/stop.js"';

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function readJsonObject(filePath: string): Record<string, unknown> {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path.basename(filePath)} must contain an object`);
  }
  return parsed as Record<string, unknown>;
}

function normalizeShippingPath(relative: string): string {
  if (relative.includes('\\') || path.posix.isAbsolute(relative)) {
    throw new Error(`shipping path is not repository-relative POSIX syntax: ${relative}`);
  }
  const normalized = path.posix.normalize(relative);
  if (normalized !== relative || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`shipping path escapes package root: ${relative}`);
  }
  return normalized.replace(/\/$/, '');
}

function collectFiles(root: string, relative: string, output: Set<string>): void {
  const normalized = normalizeShippingPath(relative);
  const absolute = path.join(root, ...normalized.split('/'));
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    throw new Error(`shipping inventory rejects symlink: ${normalized}`);
  }
  if (stat.isFile()) {
    output.add(normalized);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`shipping inventory rejects non-file: ${normalized}`);
  }
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    collectFiles(root, `${normalized}/${entry.name}`, output);
  }
}

function shippingPaths(root: string, packageJson: Record<string, unknown>): string[] {
  const roots = new Set<string>(['package.json', 'plugin.json', 'hooks.json']);
  const configured = packageJson.files;
  if (Array.isArray(configured)) {
    for (const entry of configured) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new Error('package.json files[] must contain non-empty strings');
      }
      roots.add(normalizeShippingPath(entry));
    }
  } else {
    for (const fallback of ['dist/bin', 'dist/src', 'skills', 'rules']) roots.add(fallback);
  }
  const files = new Set<string>();
  for (const relative of roots) {
    const absolute = path.join(root, ...relative.split('/'));
    if (!fs.existsSync(absolute)) {
      throw new Error(`declared shipping path is missing: ${relative}`);
    }
    collectFiles(root, relative, files);
  }
  return [...files].sort(compareUtf8);
}

function readEntrypoints(root: string, packageJson: Record<string, unknown>): PackageEntrypointsV1 {
  const bin = packageJson.bin;
  const cli = typeof bin === 'object' && bin !== null && !Array.isArray(bin)
    ? (bin as Record<string, unknown>).oma
    : undefined;
  if (cli !== 'dist/bin/oma.js') {
    throw new Error('package.json must bind oma to dist/bin/oma.js');
  }
  const hooks = readJsonObject(path.join(root, 'hooks.json'));
  const registration = hooks['oh-my-agy-runtime'];
  if (typeof registration !== 'object' || registration === null || Array.isArray(registration)) {
    throw new Error('hooks.json is missing oh-my-agy-runtime');
  }
  const record = registration as Record<string, unknown>;
  const commandAt = (key: 'PreInvocation' | 'Stop'): unknown => {
    const rows = record[key];
    return Array.isArray(rows) && typeof rows[0] === 'object' && rows[0] !== null
      ? (rows[0] as Record<string, unknown>).command
      : undefined;
  };
  if (commandAt('PreInvocation') !== PRE_INVOCATION_COMMAND || commandAt('Stop') !== STOP_COMMAND) {
    throw new Error('hooks.json entrypoints are not authoritative');
  }
  return {
    cli: 'dist/bin/oma.js',
    preInvocation: 'dist/src/hooks/pre-invocation.js',
    stop: 'dist/src/hooks/stop.js',
  };
}

export function computePackageIdentity(
  packageRoot: string,
): Result<PackageIdentityV1, RuntimeError> {
  try {
    const root = fs.realpathSync(path.resolve(packageRoot));
    const packageJson = readJsonObject(path.join(root, 'package.json'));
    const pluginJson = readJsonObject(path.join(root, 'plugin.json'));
    const packageName = packageJson.name;
    const version = packageJson.version;
    const pluginName = pluginJson.name;
    if (typeof packageName !== 'string' || packageName.trim() === ''
      || typeof version !== 'string' || version.trim() === ''
      || typeof pluginName !== 'string' || pluginName.trim() === '') {
      return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'package/plugin identity fields are missing'));
    }
    if (pluginJson.version !== undefined && pluginJson.version !== version) {
      return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'package/plugin versions disagree', {
        packageVersion: version,
        pluginVersion: pluginJson.version,
      }));
    }
    for (const relative of REQUIRED_RELATIVE_PATHS) {
      const absolute = path.join(root, ...relative.split('/'));
      if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) {
        return err(runtimeError('E_PLUGIN_NOT_ACTIVE', `required shipping entrypoint is missing: ${relative}`));
      }
    }
    const inventory = shippingPaths(root, packageJson).map((relative) => {
      const absolute = path.join(root, ...relative.split('/'));
      const bytes = fs.readFileSync(absolute);
      return {
        path: relative,
        byteLength: bytes.length,
        sha256: sha256(bytes),
        executable: (fs.statSync(absolute).mode & 0o111) !== 0,
      };
    });
    const entrypoints = readEntrypoints(root, packageJson);
    return ok({
      schemaVersion: 1,
      packageName,
      pluginName,
      version,
      rootPath: root,
      digest: sha256(canonicalJson(inventory)),
      inventory,
      entrypoints,
    });
  } catch (error) {
    return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'installed package identity cannot be resolved', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function comparePackageIdentity(
  expected: Readonly<PackageIdentityV1>,
  actual: Readonly<PackageIdentityV1>,
): Result<void, RuntimeError> {
  if (expected.packageName !== actual.packageName || expected.pluginName !== actual.pluginName
    || expected.version !== actual.version || expected.digest !== actual.digest) {
    return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'installed plugin identity does not match source bytes', {
      expectedPath: expected.rootPath,
      actualPath: actual.rootPath,
      expectedVersion: expected.version,
      actualVersion: actual.version,
      expectedDigest: expected.digest,
      actualDigest: actual.digest,
    }));
  }
  return ok(undefined);
}

function candidateRealpath(candidate: string, pluginName: string): string | undefined {
  try {
    if (!fs.existsSync(candidate)) return undefined;
    const real = fs.realpathSync(candidate);
    const plugin = readJsonObject(path.join(real, 'plugin.json'));
    return plugin.name === pluginName ? real : undefined;
  } catch {
    return undefined;
  }
}

export function defaultAntigravityConfigRoot(homeDir = os.homedir()): string {
  const configured = process.env.OMA_ANTIGRAVITY_CONFIG_ROOT
    ?? process.env.ANTIGRAVITY_CONFIG_ROOT;
  return path.resolve(configured ?? path.join(homeDir, '.gemini', 'config'));
}

export function resolveInstalledPluginIdentity(
  input: Readonly<ResolveInstalledPluginIdentityInput>,
): Result<InstalledPluginIdentityV1, RuntimeError> {
  if (!input.registry.present) {
    return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'plugin is not present in registry readback'));
  }
  const configRoot = path.resolve(
    input.antigravityConfigRoot ?? defaultAntigravityConfigRoot(input.homeDir),
  );
  const candidates: string[] = [];
  if (typeof input.registry.installPath === 'string' && path.isAbsolute(input.registry.installPath)) {
    candidates.push(input.registry.installPath);
  }
  candidates.push(path.join(configRoot, 'plugins', input.pluginName));
  const resolved = [...new Set(candidates
    .map((candidate) => candidateRealpath(candidate, input.pluginName))
    .filter((candidate): candidate is string => candidate !== undefined))];
  if (resolved.length === 0) {
    return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'installed plugin identity is unresolved', {
      pluginName: input.pluginName,
      configRoot,
    }));
  }
  if (resolved.length !== 1) {
    return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'installed plugin identity is ambiguous', {
      pluginName: input.pluginName,
      candidates: resolved.sort(compareUtf8),
    }));
  }
  const identity = computePackageIdentity(resolved[0]);
  if (!identity.ok) return identity;
  if (identity.value.pluginName !== input.pluginName) {
    return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'installed plugin name does not match registry'));
  }
  return ok({
    ...identity.value,
    installPath: identity.value.rootPath,
    registry: {
      present: true,
      enabled: input.registry.enabled !== false,
      source: input.registry.source ?? null,
      version: input.registry.version ?? null,
      installPath: input.registry.installPath ?? null,
      components: [...new Set(input.registry.components ?? [])].sort(compareUtf8),
    },
  });
}

function makeWritableForCleanup(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      fs.chmodSync(absolute, 0o700);
      makeWritableForCleanup(absolute);
    } else {
      fs.chmodSync(absolute, 0o600);
    }
  }
  fs.chmodSync(root, 0o700);
}

export function stageImmutablePackage(input: {
  packageRoot: string;
  stagesRoot: string;
}): Result<{ stagePath: string; identity: PackageIdentityV1 }, RuntimeError> {
  const source = computePackageIdentity(input.packageRoot);
  if (!source.ok) return source;
  const stagesRoot = path.resolve(input.stagesRoot);
  const stagePath = path.join(stagesRoot, source.value.digest);
  try {
    fs.mkdirSync(stagesRoot, { recursive: true, mode: 0o700 });
    if (fs.existsSync(stagePath)) {
      const existing = computePackageIdentity(stagePath);
      if (!existing.ok || existing.value.digest !== source.value.digest) {
        return err(runtimeError('E_CORRUPT_STATE', 'content-addressed install stage is corrupt', {
          stagePath,
          expectedDigest: source.value.digest,
          actualDigest: existing.ok ? existing.value.digest : null,
        }));
      }
      return ok({ stagePath, identity: existing.value });
    }
    const temporary = path.join(stagesRoot, `.${source.value.digest}.${process.pid}.tmp`);
    if (fs.existsSync(temporary)) {
      makeWritableForCleanup(temporary);
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
    for (const entry of source.value.inventory) {
      const from = path.join(source.value.rootPath, ...entry.path.split('/'));
      const to = path.join(temporary, ...entry.path.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, entry.executable ? 0o500 : 0o400);
    }
    fs.renameSync(temporary, stagePath);
    const directories: string[] = [];
    const collectDirectories = (root: string): void => {
      directories.push(root);
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) collectDirectories(path.join(root, entry.name));
      }
    };
    collectDirectories(stagePath);
    directories.sort((left, right) => right.length - left.length);
    for (const directory of directories) fs.chmodSync(directory, 0o500);
    const identity = computePackageIdentity(stagePath);
    if (!identity.ok || identity.value.digest !== source.value.digest) {
      return err(runtimeError('E_CORRUPT_STATE', 'immutable stage readback differs from source'));
    }
    return ok({ stagePath, identity: identity.value });
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'immutable package stage failed', {
      cause: error instanceof Error ? error.message : String(error),
      stagePath,
    }));
  }
}
