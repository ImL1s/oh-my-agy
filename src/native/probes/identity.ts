import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { HostIdentityV1, PluginIdentityV1 } from '../capability-profile';

export interface ExecutableIdentityInputV1 {
  executable: string;
  version: string | null;
  versionOutput: string;
  helpOutput: string;
  pathEnvironment?: string;
}

export function inspectExecutableIdentity(input: Readonly<ExecutableIdentityInputV1>): HostIdentityV1 {
  const resolved = resolveExecutable(input.executable, input.pathEnvironment ?? process.env.PATH ?? '');
  const lexical = path.resolve(resolved);
  const before = fs.lstatSync(lexical);
  const realpath = fs.realpathSync(lexical);
  const descriptor = fs.openSync(realpath, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const openedBefore = fs.fstatSync(descriptor);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : openedBefore.uid;
    if (!openedBefore.isFile() || (openedBefore.mode & 0o111) === 0 || (openedBefore.mode & 0o022) !== 0
      || (openedBefore.uid !== currentUid && openedBefore.uid !== 0)) {
      throw new Error('E_CAPABILITY_IDENTITY: executable permissions are not trusted');
    }
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    const after = fs.lstatSync(lexical);
    const finalRealpath = fs.realpathSync(lexical);
    if (openedBefore.dev !== openedAfter.dev || openedBefore.ino !== openedAfter.ino
      || openedBefore.size !== openedAfter.size || openedBefore.mtimeMs !== openedAfter.mtimeMs
      || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
      || realpath !== finalRealpath) {
      throw new Error('E_CAPABILITY_IDENTITY: executable changed while hashing');
    }
    return {
      realpath,
      binarySha256: digest(bytes),
      version: input.version,
      versionOutputSha256: digest(input.versionOutput),
      helpOutputSha256: digest(input.helpOutput),
      platform: process.platform,
      arch: process.arch,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export interface PluginIdentityInputV1 {
  installedRoot: string;
  packageDigest: string;
  version: string;
  readback: string;
  enabled: boolean;
}

export function inspectPluginIdentity(input: Readonly<PluginIdentityInputV1>): PluginIdentityV1 {
  const lexical = path.resolve(input.installedRoot);
  const before = fs.lstatSync(lexical);
  if (before.isSymbolicLink()) throw new Error('E_CAPABILITY_IDENTITY: plugin root symlink is not trusted');
  const realpath = fs.realpathSync(lexical);
  const after = fs.lstatSync(lexical);
  if (!before.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || realpath !== fs.realpathSync(lexical)
    || !/^[a-f0-9]{64}$/u.test(input.packageDigest) || input.version.trim() === '') {
    throw new Error('E_CAPABILITY_IDENTITY: plugin identity is invalid or drifted');
  }
  return {
    status: 'present',
    realpath,
    packageDigest: input.packageDigest,
    version: input.version,
    readbackDigest: digest(input.readback),
    enabled: input.enabled,
  };
}

export function absentPluginIdentity(): PluginIdentityV1 {
  return { status: 'absent', realpath: null, packageDigest: null, version: null, readbackDigest: null, enabled: false };
}

export function unknownPluginIdentity(): PluginIdentityV1 {
  return { status: 'unknown', realpath: null, packageDigest: null, version: null, readbackDigest: null, enabled: false };
}

export function identityTupleMatches(left: HostIdentityV1 | PluginIdentityV1, right: HostIdentityV1 | PluginIdentityV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveExecutable(executable: string, pathEnvironment: string): string {
  if (path.isAbsolute(executable)) return executable;
  for (const directory of pathEnvironment.split(path.delimiter)) {
    if (directory === '' || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('E_CAPABILITY_IDENTITY: executable was not found on trusted PATH');
}

function noFollowFlag(): number { return typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0; }
function digest(value: string | Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }
