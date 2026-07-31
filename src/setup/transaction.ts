import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import {
  InstalledPluginIdentityV1,
  PackageIdentityV1,
  defaultAntigravityConfigRoot,
  resolveInstalledPluginIdentity,
  stageImmutablePackage,
} from './installed-identity';
import {
  ParsedPluginListLine,
  PluginCommandAdapter,
  PluginCommandResult,
  parsePluginListLine,
  readPackagePluginName,
  resolveCompiledHookPaths,
  verifyPluginActive,
} from './plugin';
import { InstallCommandReceiptV1, commandReceipt } from './receipt';

export type SetupTransactionStatus = 'success' | 'failed' | 'rolled_back' | 'rollback_failed';
export type SetupFaultPoint = 'before_plugin_switch' | 'after_plugin_switch' | 'after_exact_readback';

export interface SetupTransactionRecordV1 {
  schemaVersion: 1;
  transactionId: string;
  packageRoot: string;
  packageDigest: string;
  stagePath: string;
  pluginName: string;
  status: SetupTransactionStatus;
  steps: readonly string[];
  commands: readonly InstallCommandReceiptV1[];
  previousSnapshotPath?: string;
  installedPath?: string;
  recovery?: string;
  completedAtMs: number;
}

export interface SetupTransactionSuccess {
  status: 'success';
  idempotent: boolean;
  transactionId: string;
  packageDigest: string;
  recordPath: string;
  stagePath: string;
  stageIdentity: PackageIdentityV1;
  installedIdentity: InstalledPluginIdentityV1;
  previousSnapshotPath?: string;
  commands: InstallCommandReceiptV1[];
}

export interface PluginSetupTransactionOptions {
  packageRoot: string;
  stateRoot: string;
  adapter: PluginCommandAdapter;
  antigravityConfigRoot?: string;
  homeDir?: string;
  idFactory?: () => string;
  now?: () => number;
  faultInjector?: (point: SetupFaultPoint) => void;
}

interface PreviousInstallSnapshot {
  identity: InstalledPluginIdentityV1;
  snapshotPath: string;
}

/**
 * 安裝交易固定為 stage → snapshot → remove old → host switch → exact readback；
 * Antigravity 的同名 install 是覆蓋寫入，因此切換前必須先移除 registry-owned
 * 舊版本，避免殘留檔案污染 exact identity。任何明確失敗或 fault 都用安裝前的
 * immutable bytes 回滾。
 */
export class PluginSetupTransaction {
  private readonly packageRoot: string;
  private readonly stateRoot: string;
  private readonly adapter: PluginCommandAdapter;
  private readonly configRoot: string;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly faultInjector: (point: SetupFaultPoint) => void;

  constructor(options: Readonly<PluginSetupTransactionOptions>) {
    this.packageRoot = path.resolve(options.packageRoot);
    this.stateRoot = path.resolve(options.stateRoot);
    this.adapter = options.adapter;
    this.configRoot = path.resolve(
      options.antigravityConfigRoot ?? defaultAntigravityConfigRoot(options.homeDir),
    );
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => Date.now());
    this.faultInjector = options.faultInjector ?? (() => undefined);
  }

  async run(): Promise<Result<SetupTransactionSuccess, RuntimeError>> {
    const nameResult = readPackagePluginName(this.packageRoot);
    if (!nameResult.ok) return nameResult;
    const pluginName = nameResult.value;
    const entrypoints = resolveCompiledHookPaths(this.packageRoot);
    if (!entrypoints.ok) return entrypoints;
    const staged = stageImmutablePackage({
      packageRoot: this.packageRoot,
      stagesRoot: path.join(this.stateRoot, 'install', 'stages'),
    });
    if (!staged.ok) return staged;
    const packageDigest = staged.value.identity.digest;

    const existing = this.findSuccessfulDigest(packageDigest);
    if (existing !== undefined) {
      const listed = await this.adapter.run(['plugin', 'list']);
      const readback = listed.code === 0
        ? await verifyPluginActive({
          packageRoot: staged.value.stagePath,
          adapter: fixedListAdapter(this.adapter, listed),
          pluginName,
          antigravityConfigRoot: this.configRoot,
        })
        : err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'plugin list failed during idempotent readback'));
      if (readback.ok) {
        return ok({
          status: 'success',
          idempotent: true,
          transactionId: existing.transactionId,
          packageDigest,
          recordPath: this.recordPath(existing.transactionId),
          stagePath: staged.value.stagePath,
          stageIdentity: staged.value.identity,
          installedIdentity: readback.value.identity,
          previousSnapshotPath: existing.previousSnapshotPath,
          commands: [commandReceipt(listed.argv, listed.code, listed.stdout, listed.stderr)],
        });
      }
    }

    const transactionId = this.idFactory();
    const steps: string[] = ['immutable stage'];
    const commands: InstallCommandReceiptV1[] = [];
    let previous: PreviousInstallSnapshot | undefined;
    let switched = false;
    try {
      const listedBefore = await this.runStep(['plugin', 'list'], commands);
      steps.push(`plugin list:${listedBefore.code}`);
      if (listedBefore.code !== 0) {
        return this.failWithoutSwitch(
          transactionId, pluginName, staged.value, steps, commands,
          commandError('plugin list failed before install', listedBefore),
        );
      }
      const parsedBefore = parsePluginListLine(listedBefore.stdout, pluginName);
      if (parsedBefore !== undefined) {
        const snapshot = this.snapshotPrevious(
          pluginName,
          parsedBefore,
          transactionId,
        );
        if (!snapshot.ok) {
          return this.failWithoutSwitch(
            transactionId, pluginName, staged.value, steps, commands, snapshot.error,
          );
        }
        previous = snapshot.value;
        steps.push('previous installed bytes snapshotted');
      } else {
        const unmanagedPath = path.join(this.configRoot, 'plugins', pluginName);
        if (fs.existsSync(unmanagedPath)) {
          return this.failWithoutSwitch(
            transactionId,
            pluginName,
            staged.value,
            steps,
            commands,
            runtimeError(
              'E_PLUGIN_NOT_ACTIVE',
              'installed plugin path exists without registry ownership; refusing overwrite',
              { installPath: unmanagedPath },
            ),
          );
        }
      }

      const validated = await this.runStep(
        ['plugin', 'validate', staged.value.stagePath], commands,
      );
      if (validated.code !== 0) {
        return this.failWithoutSwitch(
          transactionId, pluginName, staged.value, steps, commands,
          commandError('plugin validation failed', validated), previous,
        );
      }
      steps.push('plugin validate');

      this.faultInjector('before_plugin_switch');
      if (previous !== undefined) {
        // disable/uninstall 之間任一步驟都可能已改變 host，從第一個 mutation 起即納入回滾。
        switched = true;
        const removed = await this.removeInstalledPlugin(
          pluginName,
          commands,
          'upgrade',
          previous.identity.installPath,
        );
        if (!removed.ok) {
          return await this.failAfterSwitch(
            transactionId, pluginName, staged.value, steps, commands, removed.error, previous,
          );
        }
        steps.push('previous install removed');
      }
      const installed = await this.runStep(
        ['plugin', 'install', staged.value.stagePath], commands,
      );
      switched = true;
      if (installed.code !== 0) {
        const reconciled = await this.readback(staged.value.stagePath, pluginName);
        if (!isUncertainResult(installed) || !reconciled.ok) {
          return await this.failAfterSwitch(
            transactionId, pluginName, staged.value, steps, commands,
            commandError('plugin install failed', installed), previous,
          );
        }
        steps.push('plugin install reconciled by exact readback');
      } else {
        steps.push('plugin install');
      }

      this.faultInjector('after_plugin_switch');
      const enabled = await this.runStep(['plugin', 'enable', pluginName], commands);
      if (enabled.code !== 0 && !/already enabled/i.test(`${enabled.stderr}\n${enabled.stdout}`)) {
        return await this.failAfterSwitch(
          transactionId, pluginName, staged.value, steps, commands,
          commandError('plugin enable failed', enabled), previous,
        );
      }
      steps.push(enabled.code === 0 ? 'plugin enable' : 'plugin enable (already enabled)');

      const readback = await this.readback(staged.value.stagePath, pluginName, commands);
      if (!readback.ok) {
        return await this.failAfterSwitch(
          transactionId, pluginName, staged.value, steps, commands, readback.error, previous,
        );
      }
      steps.push('exact installed readback');
      this.faultInjector('after_exact_readback');

      const record: SetupTransactionRecordV1 = {
        schemaVersion: 1,
        transactionId,
        packageRoot: this.packageRoot,
        packageDigest,
        stagePath: staged.value.stagePath,
        pluginName,
        status: 'success',
        steps,
        commands,
        previousSnapshotPath: previous?.snapshotPath,
        installedPath: readback.value.installPath,
        completedAtMs: this.now(),
      };
      const recordPath = this.persist(record);
      return ok({
        status: 'success',
        idempotent: false,
        transactionId,
        packageDigest,
        recordPath,
        stagePath: staged.value.stagePath,
        stageIdentity: staged.value.identity,
        installedIdentity: readback.value.identity,
        previousSnapshotPath: previous?.snapshotPath,
        commands,
      });
    } catch (error) {
      const failure = runtimeError('E_PLUGIN_NOT_ACTIVE', 'plugin setup transaction faulted', {
        cause: error instanceof Error ? error.message : String(error),
      });
      return switched
        ? await this.failAfterSwitch(
          transactionId, pluginName, staged.value, steps, commands, failure, previous,
        )
        : this.failWithoutSwitch(
          transactionId, pluginName, staged.value, steps, commands, failure, previous,
        );
    }
  }

  async rollback(
    success: Readonly<SetupTransactionSuccess>,
    reason = 'caller requested rollback',
  ): Promise<Result<void, RuntimeError>> {
    // A digest-idempotent run only proved that the requested bytes were
    // already active.  It did not mutate the host plugin, so its historical
    // transaction snapshot must never be replayed as this run's rollback.
    if (success.idempotent) return ok(undefined);
    const previous = success.previousSnapshotPath === undefined
      ? undefined
      : {
        snapshotPath: success.previousSnapshotPath,
        identity: undefined as unknown as InstalledPluginIdentityV1,
      };
    const restored = await this.restorePrevious('oh-my-agy', previous, []);
    if (!restored.ok) return restored;
    const prior = this.readRecord(success.transactionId);
    if (prior !== undefined) {
      this.persist({
        ...prior,
        status: 'rolled_back',
        recovery: reason,
        completedAtMs: this.now(),
      });
    }
    return ok(undefined);
  }

  private async readback(
    stagePath: string,
    pluginName: string,
    commands?: InstallCommandReceiptV1[],
  ): Promise<Result<Awaited<ReturnType<typeof verifyPluginActive>> extends Result<infer T, RuntimeError> ? T : never, RuntimeError>> {
    const listed = await this.adapter.run(['plugin', 'list']);
    if (commands !== undefined) {
      commands.push(commandReceipt(listed.argv, listed.code, listed.stdout, listed.stderr));
    }
    if (listed.code !== 0) {
      return err(commandError('plugin list failed during exact readback', listed));
    }
    return verifyPluginActive({
      packageRoot: stagePath,
      adapter: fixedListAdapter(this.adapter, listed),
      pluginName,
      antigravityConfigRoot: this.configRoot,
    });
  }

  private snapshotPrevious(
    pluginName: string,
    parsed: ParsedPluginListLine,
    transactionId: string,
  ): Result<PreviousInstallSnapshot, RuntimeError> {
    const resolved = resolveInstalledPluginIdentity({
      pluginName,
      antigravityConfigRoot: this.configRoot,
      registry: {
        present: true,
        enabled: parsed.enabled,
        version: parsed.version,
        installPath: parsed.installPath,
        source: parsed.source,
        components: parsed.components,
      },
    });
    if (!resolved.ok) return resolved;
    const staged = stageImmutablePackage({
      packageRoot: resolved.value.installPath,
      stagesRoot: path.join(this.stateRoot, 'install', 'rollback', transactionId),
    });
    if (!staged.ok) return staged;
    return ok({ identity: resolved.value, snapshotPath: staged.value.stagePath });
  }

  private async runStep(
    argv: readonly string[],
    commands: InstallCommandReceiptV1[],
  ): Promise<PluginCommandResult> {
    const result = await this.adapter.run(argv);
    commands.push(commandReceipt(result.argv, result.code, result.stdout, result.stderr));
    return result;
  }

  private failWithoutSwitch(
    transactionId: string,
    pluginName: string,
    staged: { stagePath: string; identity: PackageIdentityV1 },
    steps: readonly string[],
    commands: readonly InstallCommandReceiptV1[],
    error: RuntimeError,
    previous?: PreviousInstallSnapshot,
  ): Result<SetupTransactionSuccess, RuntimeError> {
    this.persist({
      schemaVersion: 1,
      transactionId,
      packageRoot: this.packageRoot,
      packageDigest: staged.identity.digest,
      stagePath: staged.stagePath,
      pluginName,
      status: 'failed',
      steps,
      commands,
      previousSnapshotPath: previous?.snapshotPath,
      recovery: previous === undefined
        ? 'no host switch occurred'
        : 'previous installed bytes preserved; no host switch occurred',
      completedAtMs: this.now(),
    });
    return err(error);
  }

  private async failAfterSwitch(
    transactionId: string,
    pluginName: string,
    staged: { stagePath: string; identity: PackageIdentityV1 },
    steps: string[],
    commands: InstallCommandReceiptV1[],
    error: RuntimeError,
    previous?: PreviousInstallSnapshot,
  ): Promise<Result<SetupTransactionSuccess, RuntimeError>> {
    const restored = await this.restorePrevious(pluginName, previous, commands);
    const status: SetupTransactionStatus = restored.ok ? 'rolled_back' : 'rollback_failed';
    const recovery = restored.ok
      ? previous === undefined
        ? 'removed transaction-owned new install'
        : 'restored previous immutable installed bytes'
      : `rollback failed: ${restored.error.message}`;
    this.persist({
      schemaVersion: 1,
      transactionId,
      packageRoot: this.packageRoot,
      packageDigest: staged.identity.digest,
      stagePath: staged.stagePath,
      pluginName,
      status,
      steps,
      commands,
      previousSnapshotPath: previous?.snapshotPath,
      recovery,
      completedAtMs: this.now(),
    });
    if (!restored.ok) {
      return err(runtimeError('E_PLUGIN_NOT_ACTIVE', error.message, {
        original: error.details ?? null,
        rollback: restored.error,
      }));
    }
    return err(error);
  }

  private async restorePrevious(
    pluginName: string,
    previous: PreviousInstallSnapshot | undefined,
    commands: InstallCommandReceiptV1[],
  ): Promise<Result<void, RuntimeError>> {
    const cleared = await this.removeInstalledPlugin(pluginName, commands, 'rollback');
    if (!cleared.ok) return cleared;
    if (previous === undefined) return ok(undefined);
    const validated = await this.runStep(['plugin', 'validate', previous.snapshotPath], commands);
    if (validated.code !== 0) return err(commandError('rollback snapshot validate failed', validated));
    const installed = await this.runStep(['plugin', 'install', previous.snapshotPath], commands);
    if (installed.code !== 0 && !isUncertainResult(installed)) {
      return err(commandError('rollback snapshot install failed', installed));
    }
    const enabled = await this.runStep(['plugin', 'enable', pluginName], commands);
    if (enabled.code !== 0 && !/already enabled/i.test(`${enabled.stdout}\n${enabled.stderr}`)) {
      return err(commandError('rollback snapshot enable failed', enabled));
    }
    const exact = await this.readback(previous.snapshotPath, pluginName, commands);
    return exact.ok ? ok(undefined) : exact;
  }

  private async removeInstalledPlugin(
    pluginName: string,
    commands: InstallCommandReceiptV1[],
    context = 'upgrade',
    installPath = path.join(this.configRoot, 'plugins', pluginName),
  ): Promise<Result<void, RuntimeError>> {
    const disabled = await this.runStep(['plugin', 'disable', pluginName], commands);
    if (disabled.code !== 0 && !/already disabled|not (?:installed|enabled)|not found/i.test(
      `${disabled.stdout}\n${disabled.stderr}`,
    )) return err(commandError(`${context} disable failed`, disabled));

    const removed = await this.runStep(['plugin', 'uninstall', pluginName], commands);
    if (removed.code !== 0 && !/not installed|not found/i.test(
      `${removed.stdout}\n${removed.stderr}`,
    )) return err(commandError(`${context} uninstall failed`, removed));

    const listed = await this.runStep(['plugin', 'list'], commands);
    if (listed.code !== 0) return err(commandError(`${context} plugin list failed`, listed));
    if (parsePluginListLine(listed.stdout, pluginName) !== undefined) {
      return err(runtimeError(
        'E_PLUGIN_NOT_ACTIVE',
        `${context} could not prove prior install absent`,
      ));
    }
    if (pathExistsIncludingBrokenSymlink(installPath)) {
      return err(runtimeError(
        'E_PLUGIN_NOT_ACTIVE',
        `${context} left installed plugin bytes after registry removal`,
        { installPath },
      ));
    }
    return ok(undefined);
  }

  private recordPath(transactionId: string): string {
    return path.join(this.stateRoot, 'setup-transactions', `${transactionId}.json`);
  }

  private persist(record: SetupTransactionRecordV1): string {
    const target = this.recordPath(record.transactionId);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    atomicWriteJson(target, record);
    return target;
  }

  private readRecord(transactionId: string): SetupTransactionRecordV1 | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.recordPath(transactionId), 'utf8')) as SetupTransactionRecordV1;
    } catch {
      return undefined;
    }
  }

  private findSuccessfulDigest(packageDigest: string): SetupTransactionRecordV1 | undefined {
    const directory = path.join(this.stateRoot, 'setup-transactions');
    if (!fs.existsSync(directory)) return undefined;
    for (const entry of fs.readdirSync(directory).sort()) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(directory, entry), 'utf8')) as SetupTransactionRecordV1;
        if (raw.status === 'success' && raw.packageDigest === packageDigest) return raw;
      } catch {
        // 損毀舊紀錄不構成已安裝證據，繼續執行新交易。
      }
    }
    return undefined;
  }
}

function fixedListAdapter(
  delegate: PluginCommandAdapter,
  listResult: PluginCommandResult,
): PluginCommandAdapter {
  return {
    async run(argv) {
      return argv[0] === 'plugin' && argv[1] === 'list'
        ? { ...listResult, argv: [...argv] }
        : delegate.run(argv);
    },
  };
}

function commandError(message: string, result: PluginCommandResult): RuntimeError {
  return runtimeError('E_PLUGIN_NOT_ACTIVE', message, {
    argv: [...result.argv],
    code: result.code,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
  });
}

function isUncertainResult(result: PluginCommandResult): boolean {
  return /timeout|timed out|unknown|disconnect|connection|temporar/i.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

function pathExistsIncludingBrokenSymlink(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
