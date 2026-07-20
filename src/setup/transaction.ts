import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson, canonicalJson, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import {
  PluginCommandAdapter,
  PluginCommandResult,
  readPackagePluginName,
  resolveCompiledHookPaths,
  verifyPluginActive,
} from './plugin';

export type SetupTransactionStatus = 'success' | 'failed';

export interface SetupTransactionRecordV1 {
  schemaVersion: 1;
  transactionId: string;
  packageRoot: string;
  packageDigest: string;
  pluginName: string;
  status: SetupTransactionStatus;
  steps: readonly string[];
  recovery?: string;
  completedAtMs: number;
}

export interface SetupTransactionSuccess {
  status: 'success';
  idempotent: boolean;
  transactionId: string;
  packageDigest: string;
  recordPath: string;
}

export interface PluginSetupTransactionOptions {
  packageRoot: string;
  stateRoot: string;
  adapter: PluginCommandAdapter;
  idFactory?: () => string;
  now?: () => number;
}

/**
 * 設計概念映射：參考 oh-my-claudecode setup transaction —
 * snapshot → validate → install → enable → list/readback；
 * same digest 冪等；partial failure 不 uninstall 既有 plugin。
 */
export class PluginSetupTransaction {
  private readonly packageRoot: string;
  private readonly stateRoot: string;
  private readonly adapter: PluginCommandAdapter;
  private readonly idFactory: () => string;
  private readonly now: () => number;

  constructor(options: Readonly<PluginSetupTransactionOptions>) {
    this.packageRoot = path.resolve(options.packageRoot);
    this.stateRoot = path.resolve(options.stateRoot);
    this.adapter = options.adapter;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => Date.now());
  }

  async run(): Promise<Result<SetupTransactionSuccess, RuntimeError>> {
    const nameResult = readPackagePluginName(this.packageRoot);
    if (!nameResult.ok) return nameResult;
    const pluginName = nameResult.value;
    // setup 只要求編譯後 hook 檔存在；權威 hooks.json 由 package surface 測試把關。
    const entrypoints = resolveCompiledHookPaths(this.packageRoot);
    if (!entrypoints.ok) return entrypoints;

    const packageDigest = computePackageDigest(this.packageRoot);
    const existing = this.findSuccessfulDigest(packageDigest);
    if (existing !== undefined) {
      const readback = await verifyPluginActive({
        packageRoot: this.packageRoot,
        adapter: this.adapter,
        pluginName,
      });
      if (readback.ok) {
        return ok({
          status: 'success',
          idempotent: true,
          transactionId: existing.transactionId,
          packageDigest,
          recordPath: this.recordPath(existing.transactionId),
        });
      }
    }

    const transactionId = this.idFactory();
    const steps: string[] = [];
    try {
      steps.push('snapshot');
      const listedBefore = await this.runStep(['plugin', 'list']);
      steps.push(`plugin list:${listedBefore.code}`);

      const validated = await this.runStep(['plugin', 'validate', this.packageRoot]);
      if (validated.code !== 0) {
        return this.fail(transactionId, pluginName, packageDigest, steps, validated);
      }
      steps.push('plugin validate');

      const installed = await this.runStep(['plugin', 'install', this.packageRoot]);
      if (installed.code !== 0) {
        return this.fail(transactionId, pluginName, packageDigest, steps, installed);
      }
      steps.push('plugin install');

      const enabled = await this.runStep(['plugin', 'enable', pluginName]);
      // 真實 agy：已 enable 時回 exit 1 + "already enabled" — 視為冪等成功。
      if (enabled.code !== 0 && !/already enabled/i.test(`${enabled.stderr}\n${enabled.stdout}`)) {
        return this.fail(transactionId, pluginName, packageDigest, steps, enabled);
      }
      steps.push(enabled.code === 0 ? 'plugin enable' : 'plugin enable (already enabled)');

      const readback = await verifyPluginActive({
        packageRoot: this.packageRoot,
        adapter: this.adapter,
        pluginName,
      });
      if (!readback.ok) {
        return this.fail(transactionId, pluginName, packageDigest, steps, {
          argv: ['plugin', 'list'],
          code: 1,
          stdout: '',
          stderr: readback.error.message,
        }, readback.error);
      }
      steps.push('plugin list');

      const record: SetupTransactionRecordV1 = {
        schemaVersion: 1,
        transactionId,
        packageRoot: this.packageRoot,
        packageDigest,
        pluginName,
        status: 'success',
        steps,
        completedAtMs: this.now(),
      };
      const recordPath = this.persist(record);
      return ok({
        status: 'success',
        idempotent: false,
        transactionId,
        packageDigest,
        recordPath,
      });
    } catch (error) {
      return this.fail(transactionId, pluginName, packageDigest, steps, {
        argv: [],
        code: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runStep(argv: readonly string[]): Promise<PluginCommandResult> {
    return this.adapter.run(argv);
  }

  private fail(
    transactionId: string,
    pluginName: string,
    packageDigest: string,
    steps: readonly string[],
    command: PluginCommandResult,
    error: RuntimeError = runtimeError(
      'E_PLUGIN_NOT_ACTIVE',
      'plugin setup transaction failed',
      { argv: command.argv, code: command.code, stderr: command.stderr },
    ),
  ): Result<SetupTransactionSuccess, RuntimeError> {
    const record: SetupTransactionRecordV1 = {
      schemaVersion: 1,
      transactionId,
      packageRoot: this.packageRoot,
      packageDigest,
      pluginName,
      status: 'failed',
      steps,
      // 既有 plugin 永不任意 uninstall；只留下 recovery 證據。
      recovery: 'preserved existing plugin; no uninstall attempted',
      completedAtMs: this.now(),
    };
    this.persist(record);
    return err(error);
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

  private findSuccessfulDigest(packageDigest: string): SetupTransactionRecordV1 | undefined {
    const directory = path.join(this.stateRoot, 'setup-transactions');
    if (!fs.existsSync(directory)) return undefined;
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(directory, entry), 'utf8'),
        ) as SetupTransactionRecordV1;
        if (raw.status === 'success' && raw.packageDigest === packageDigest) return raw;
      } catch {
        // 略過損毀紀錄，不阻斷新 transaction。
      }
    }
    return undefined;
  }
}

function computePackageDigest(packageRoot: string): string {
  const files = [
    'package.json',
    'plugin.json',
    'hooks.json',
    path.join('dist', 'src', 'hooks', 'pre-invocation.js'),
    path.join('dist', 'src', 'hooks', 'stop.js'),
  ];
  const parts: string[] = [];
  for (const relative of files) {
    const absolute = path.join(packageRoot, relative);
    if (!fs.existsSync(absolute)) continue;
    parts.push(`${relative}:${sha256(fs.readFileSync(absolute))}`);
  }
  // skills / rules 也納入 digest，避免只改文件仍被視為同一 setup。
  for (const tree of ['skills', 'rules']) {
    const root = path.join(packageRoot, tree);
    if (!fs.existsSync(root)) continue;
    for (const file of walkFiles(root).sort()) {
      parts.push(`${path.relative(packageRoot, file)}:${sha256(fs.readFileSync(file))}`);
    }
  }
  return sha256(canonicalJson(parts));
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(absolute));
    else if (entry.isFile()) out.push(absolute);
  }
  return out;
}
