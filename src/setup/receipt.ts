import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFile, canonicalJson, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { InstalledPluginIdentityV1, PackageIdentityV1 } from './installed-identity';

export interface InstallCommandReceiptV1 {
  argv: string[];
  exitCode: number;
  stdoutSha256: string;
  stderrSha256: string;
}

export interface OwnedInstallPathV1 {
  path: string;
  kind: 'cli_symlink' | 'host_plugin' | 'host_skill_symlink' | 'receipt' | 'stage';
  identity: string;
}

export interface InstallReceiptV1 {
  storeKind: 'oma_install_receipt';
  schemaVersion: 1;
  transactionId: string;
  status: 'installed' | 'completed_with_warning';
  source: {
    uri: string | null;
    tag: string | null;
    peeledCommit: string | null;
    assetSha256: string;
    packageSha256: string;
    realpath: string;
    version: string;
    digest: string;
  };
  installed: {
    realpath: string;
    version: string;
    digest: string;
    entrypoints: InstalledPluginIdentityV1['entrypoints'];
  };
  host: {
    name: 'antigravity';
    version: string | null;
  };
  registry: {
    source: string | null;
    version: string | null;
    installPath: string | null;
    components: string[];
  };
  ownedInventory: OwnedInstallPathV1[];
  commands: InstallCommandReceiptV1[];
  createdAt: string;
  receiptHash: string;
}

export interface CreateInstallReceiptInput {
  transactionId: string;
  status: InstallReceiptV1['status'];
  source: PackageIdentityV1;
  installed: InstalledPluginIdentityV1;
  assetSha256?: string;
  sourceUri?: string | null;
  sourceTag?: string | null;
  peeledCommit?: string | null;
  hostVersion?: string | null;
  ownedInventory: OwnedInstallPathV1[];
  commands: InstallCommandReceiptV1[];
  createdAt?: string;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function canonicalReceiptMaterial(receipt: Omit<InstallReceiptV1, 'receiptHash'>): string {
  return canonicalJson(receipt);
}

export function commandReceipt(
  argv: readonly string[],
  exitCode: number,
  stdout: string,
  stderr: string,
): InstallCommandReceiptV1 {
  return {
    argv: [...argv],
    exitCode,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
  };
}

function gitValue(packageRoot: string, argv: string[]): string | null {
  const result = spawnSync('git', ['-C', packageRoot, ...argv], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  return value === '' ? null : value;
}

export function discoverSourceProvenance(packageRoot: string): {
  uri: string | null;
  tag: string | null;
  peeledCommit: string | null;
} {
  let packageUri: string | null = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      repository?: string | { url?: string };
    };
    packageUri = typeof pkg.repository === 'string'
      ? pkg.repository
      : typeof pkg.repository?.url === 'string' ? pkg.repository.url : null;
  } catch {
    packageUri = null;
  }
  return {
    uri: gitValue(packageRoot, ['config', '--get', 'remote.origin.url']) ?? packageUri,
    tag: process.env.OMA_RELEASE_TAG ?? gitValue(packageRoot, ['describe', '--tags', '--exact-match', 'HEAD']),
    peeledCommit: gitValue(packageRoot, ['rev-parse', 'HEAD^{commit}']),
  };
}

export function createInstallReceipt(input: Readonly<CreateInstallReceiptInput>): InstallReceiptV1 {
  const discovered = discoverSourceProvenance(input.source.rootPath);
  const material: Omit<InstallReceiptV1, 'receiptHash'> = {
    storeKind: 'oma_install_receipt',
    schemaVersion: 1,
    transactionId: input.transactionId,
    status: input.status,
    source: {
      uri: input.sourceUri === undefined ? discovered.uri : input.sourceUri,
      tag: input.sourceTag === undefined ? discovered.tag : input.sourceTag,
      peeledCommit: input.peeledCommit === undefined ? discovered.peeledCommit : input.peeledCommit,
      assetSha256: input.assetSha256 ?? input.source.digest,
      packageSha256: input.source.digest,
      realpath: input.source.rootPath,
      version: input.source.version,
      digest: input.source.digest,
    },
    installed: {
      realpath: input.installed.installPath,
      version: input.installed.version,
      digest: input.installed.digest,
      entrypoints: input.installed.entrypoints,
    },
    host: { name: 'antigravity', version: input.hostVersion ?? null },
    registry: {
      source: input.installed.registry.source,
      version: input.installed.registry.version,
      installPath: input.installed.registry.installPath,
      components: [...input.installed.registry.components].sort(compareUtf8),
    },
    ownedInventory: [...input.ownedInventory].sort((left, right) => compareUtf8(left.path, right.path)),
    commands: input.commands.map((entry) => ({ ...entry, argv: [...entry.argv] })),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return { ...material, receiptHash: sha256(canonicalReceiptMaterial(material)) };
}

export function validateInstallReceipt(value: unknown): Result<InstallReceiptV1, RuntimeError> {
  try {
    const receipt = value as InstallReceiptV1;
    if (typeof receipt !== 'object' || receipt === null
      || receipt.storeKind !== 'oma_install_receipt' || receipt.schemaVersion !== 1
      || !['installed', 'completed_with_warning'].includes(receipt.status)
      || typeof receipt.transactionId !== 'string' || receipt.transactionId.trim() === '') {
      return err(runtimeError('E_CORRUPT_STATE', 'install receipt identity is invalid'));
    }
    for (const digest of [
      receipt.source.assetSha256,
      receipt.source.packageSha256,
      receipt.source.digest,
      receipt.installed.digest,
      receipt.receiptHash,
    ]) {
      if (!isSha256(digest)) return err(runtimeError('E_CORRUPT_STATE', 'install receipt digest is invalid'));
    }
    if (!Array.isArray(receipt.ownedInventory) || !Array.isArray(receipt.commands)) {
      return err(runtimeError('E_CORRUPT_STATE', 'install receipt inventories are invalid'));
    }
    for (const command of receipt.commands) {
      if (!Array.isArray(command.argv) || command.argv.length === 0
        || !Number.isSafeInteger(command.exitCode) || command.exitCode < 0
        || !isSha256(command.stdoutSha256) || !isSha256(command.stderrSha256)) {
        return err(runtimeError('E_CORRUPT_STATE', 'install command receipt is invalid'));
      }
    }
    const { receiptHash, ...material } = receipt;
    if (receiptHash !== sha256(canonicalReceiptMaterial(material))) {
      return err(runtimeError('E_CORRUPT_STATE', 'install receipt hash is invalid'));
    }
    return ok(receipt);
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'install receipt cannot be parsed', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function writeInstallReceipt(
  receiptPath: string,
  receipt: InstallReceiptV1,
): Result<string, RuntimeError> {
  const valid = validateInstallReceipt(receipt);
  if (!valid.ok) return valid;
  try {
    const target = path.resolve(receiptPath);
    const bytes = Buffer.from(canonicalJson(receipt), 'utf8');
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target);
      if (!existing.equals(bytes)) {
        return err(runtimeError('E_ALREADY_EXISTS', 'immutable install receipt already differs'));
      }
      return ok(target);
    }
    atomicWriteFile(target, bytes, { mode: 0o400 });
    return ok(target);
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'install receipt write failed', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function readInstallReceipt(receiptPath: string): Result<InstallReceiptV1, RuntimeError> {
  try {
    const stat = fs.lstatSync(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o400) {
      return err(runtimeError('E_CORRUPT_STATE', 'install receipt must be immutable 0400 regular file'));
    }
    return validateInstallReceipt(JSON.parse(fs.readFileSync(receiptPath, 'utf8')));
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'install receipt read failed', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}
