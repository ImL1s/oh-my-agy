import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { computePackageIdentity } from './installed-identity';
import { parsePluginListLine, PluginCommandAdapter } from './plugin';
import { InstallCommandReceiptV1, commandReceipt, readInstallReceipt } from './receipt';

export interface UninstallOwnedInstallationInput {
  receiptPath: string;
  adapter: PluginCommandAdapter;
  projectStatePath?: string;
  purge?: boolean;
}

export interface UninstallOwnedInstallationReportV1 {
  schemaVersion: 1;
  status: 'uninstalled' | 'already_absent' | 'completed_with_collisions';
  receiptPath: string;
  removed: string[];
  preserved: string[];
  collisions: string[];
  commands: InstallCommandReceiptV1[];
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function makeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) makeWritable(absolute);
    else fs.chmodSync(absolute, 0o600);
  }
}

function symlinkMatches(pointerPath: string, expectedTarget: string): boolean {
  try {
    const stat = fs.lstatSync(pointerPath);
    if (!stat.isSymbolicLink()) return false;
    const current = fs.readlinkSync(pointerPath);
    const resolved = path.isAbsolute(current) ? current : path.resolve(path.dirname(pointerPath), current);
    return path.resolve(resolved) === path.resolve(expectedTarget);
  } catch {
    return false;
  }
}

function pathExistsIncludingBrokenSymlink(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

export async function uninstallOwnedInstallation(
  input: Readonly<UninstallOwnedInstallationInput>,
): Promise<Result<UninstallOwnedInstallationReportV1, RuntimeError>> {
  const receipt = readInstallReceipt(input.receiptPath);
  if (!receipt.ok) return receipt;
  const removed: string[] = [];
  const preserved: string[] = [path.resolve(input.receiptPath)];
  const collisions: string[] = [];
  const commands: InstallCommandReceiptV1[] = [];

  const host = receipt.value.ownedInventory.find((entry) => entry.kind === 'host_plugin');
  if (host !== undefined && fs.existsSync(host.path)) {
    const identity = computePackageIdentity(host.path);
    if (!identity.ok || identity.value.digest !== host.identity) {
      collisions.push(host.path);
    } else {
      const disabled = await input.adapter.run(['plugin', 'disable', identity.value.pluginName]);
      commands.push(commandReceipt(disabled.argv, disabled.code, disabled.stdout, disabled.stderr));
      if (disabled.code !== 0 && !/not (?:installed|enabled)|not found/i.test(
        `${disabled.stdout}\n${disabled.stderr}`,
      )) {
        return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'owned plugin disable failed', {
          argv: disabled.argv,
          code: disabled.code,
          stdoutSha256: sha256(disabled.stdout),
          stderrSha256: sha256(disabled.stderr),
        }));
      }
      const uninstalled = await input.adapter.run(['plugin', 'uninstall', identity.value.pluginName]);
      commands.push(commandReceipt(
        uninstalled.argv, uninstalled.code, uninstalled.stdout, uninstalled.stderr,
      ));
      if (uninstalled.code !== 0 && !/not installed|not found/i.test(
        `${uninstalled.stdout}\n${uninstalled.stderr}`,
      )) {
        return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'owned plugin uninstall failed', {
          argv: uninstalled.argv,
          code: uninstalled.code,
          stdoutSha256: sha256(uninstalled.stdout),
          stderrSha256: sha256(uninstalled.stderr),
        }));
      }
      const listed = await input.adapter.run(['plugin', 'list']);
      commands.push(commandReceipt(listed.argv, listed.code, listed.stdout, listed.stderr));
      if (listed.code !== 0 || parsePluginListLine(listed.stdout, identity.value.pluginName) !== undefined
        || fs.existsSync(host.path)) {
        return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'owned plugin uninstall readback failed'));
      }
      removed.push(host.path);
    }
  }

  for (const pointer of receipt.value.ownedInventory.filter(
    (entry) => entry.kind === 'cli_symlink' || entry.kind === 'host_skill_symlink',
  )) {
    if (!pathExistsIncludingBrokenSymlink(pointer.path)) continue;
    if (!symlinkMatches(pointer.path, pointer.identity)) {
      collisions.push(pointer.path);
      continue;
    }
    fs.rmSync(pointer.path, { force: true });
    removed.push(pointer.path);
  }

  for (const stage of receipt.value.ownedInventory.filter((entry) => entry.kind === 'stage')) {
    if (!fs.existsSync(stage.path)) continue;
    const identity = computePackageIdentity(stage.path);
    if (!identity.ok || identity.value.digest !== stage.identity) {
      collisions.push(stage.path);
      continue;
    }
    makeWritable(stage.path);
    fs.rmSync(stage.path, { recursive: true, force: true });
    removed.push(stage.path);
  }

  if (input.projectStatePath !== undefined) {
    const projectState = path.resolve(input.projectStatePath);
    if (input.purge === true) {
      if (path.basename(projectState) !== '.agy') {
        return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'purge target must be an exact .agy directory', {
          projectState,
        }));
      }
      if (fs.existsSync(projectState)) {
        makeWritable(projectState);
        fs.rmSync(projectState, { recursive: true, force: true });
        removed.push(projectState);
      }
    } else if (fs.existsSync(projectState)) {
      preserved.push(projectState);
    }
  }

  removed.sort(compareUtf8);
  preserved.sort(compareUtf8);
  collisions.sort(compareUtf8);
  return ok({
    schemaVersion: 1,
    status: collisions.length > 0
      ? 'completed_with_collisions'
      : removed.length === 0 ? 'already_absent' : 'uninstalled',
    receiptPath: path.resolve(input.receiptPath),
    removed,
    preserved,
    collisions,
    commands,
  });
}
