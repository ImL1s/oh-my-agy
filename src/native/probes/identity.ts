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
  const resolved = resolveExecutablePath(
    input.executable,
    input.pathEnvironment ?? process.env.PATH ?? '',
  );
  const lexical = path.resolve(resolved);
  const before = fs.lstatSync(lexical);
  const realpath = fs.realpathSync(lexical);
  const descriptor = fs.openSync(realpath, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const openedBefore = fs.fstatSync(descriptor);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : openedBefore.uid;
    const permissionsTrusted = process.platform === 'win32'
      ? openedBefore.isFile()
      : openedBefore.isFile()
        && (openedBefore.mode & 0o111) !== 0
        && (openedBefore.mode & 0o022) === 0
        && (openedBefore.uid === currentUid || openedBefore.uid === 0);
    if (!permissionsTrusted) {
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

export function resolveExecutablePath(
  executable: string,
  pathEnvironment: string,
  platform: NodeJS.Platform = process.platform,
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' && pathApi.extname(executable) === ''
    ? [`${executable}.exe`, executable]
    : [executable];
  if (pathApi.isAbsolute(executable)) {
    for (const candidate of names) {
      if (exists(candidate)) return candidate;
    }
    throw new Error('E_CAPABILITY_IDENTITY: executable was not found at the absolute path');
  }
  for (const directory of pathEnvironment.split(delimiter)) {
    if (directory === '' || !pathApi.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = pathApi.join(directory, name);
      if (exists(candidate)) return candidate;
    }
  }
  throw new Error('E_CAPABILITY_IDENTITY: executable was not found on trusted PATH');
}

function noFollowFlag(): number { return typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0; }
function digest(value: string | Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }
