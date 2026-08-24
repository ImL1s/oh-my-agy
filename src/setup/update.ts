import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalJson, sha256 } from '../runtime/atomic';
import { runtimeError, RuntimeError } from '../runtime/errors';
import { assertRedacted, redactValue } from '../runtime/redaction';
import { resolveStateRoot } from '../runtime/state-root';
import { Result, err, ok } from '../runtime/types';
import { doctorReportToLines, runDoctor } from './doctor';
import {
  computePackageIdentity,
  PackageIdentitySummaryV1,
  readInstalledIdentityIfPresent,
  summarizePackageIdentity,
  validateRunnablePackageEntrypoints,
} from './installed-identity';
import { PluginCommandAdapter, PluginCommandResult, readPackagePluginName } from './plugin';
import {
  InstallReceiptV1,
  commandReceipt,
  createInstallReceipt,
  writeInstallReceipt,
} from './receipt';
import { PluginSetupTransaction, SetupTransactionSuccess } from './transaction';

export interface DoctorProbeV1 {
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  valid: boolean;
}

export type InstallGateMode = 'development' | 'release';

export interface ImmutableInstallUpdaterOptions {
  packageRoot: string;
  stateRoot: string;
  antigravityConfigRoot?: string;
  homeDir?: string;
  binDir: string;
  adapter: PluginCommandAdapter;
  mode: InstallGateMode;
  doctorProbe?: () => Promise<DoctorProbeV1>;
  idFactory?: () => string;
  expectedPackageDigest?: string;
  assetSha256?: string;
  sourceUri?: string | null;
  sourceTag?: string | null;
  peeledCommit?: string | null;
  hostVersion?: string | null;
  agyCommand?: string;
  restoreAfterSuccess?: boolean;
  rejectDirty?: boolean;
}

export interface ImmutableInstallUpdateSuccess {
  status: InstallReceiptV1['status'];
  transactionId: string;
  stagePath: string;
  installedPath: string;
  installedDigest: string;
  receiptPath: string;
  doctorExitCode: 0 | 2;
  restoredPrior: boolean;
}

export interface ImmutableInstallPreflightV1 {
  schemaVersion: 1;
  mode: InstallGateMode;
  packageRoot: string;
  packageName: string;
  pluginName: string;
  version: string;
  packageDigest: string;
  assetSha256: string | null;
  runnableEntrypoints: true;
}

export const UPDATE_CHECK_SCHEMA = 'oma.update-check/v1' as const;
export const UPDATE_CHECK_NO_UPDATE_NEEDED = 'NO_UPDATE_NEEDED' as const;
export const UPDATE_CHECK_UPGRADEABLE = 'UPGRADEABLE' as const;
export const UPDATE_CHECK_NOT_UPGRADEABLE = 'NOT_UPGRADEABLE' as const;
export const UPDATE_CHECK_NO_UPDATE_NEEDED_MESSAGE = '無需更新';

export type UpdateCheckClassificationV1 =
  | typeof UPDATE_CHECK_NO_UPDATE_NEEDED
  | typeof UPDATE_CHECK_UPGRADEABLE
  | typeof UPDATE_CHECK_NOT_UPGRADEABLE;

export interface ImmutableInstallCheckV1 {
  schema: typeof UPDATE_CHECK_SCHEMA;
  schemaVersion: 1;
  classification: UpdateCheckClassificationV1;
  message: string;
  replacement: false;
  candidate: PackageIdentitySummaryV1 | null;
  installed: {
    version: string;
    digest: string;
    installPath: string;
  } | null;
  preflight: { ok: true; report: ImmutableInstallPreflightV1 } | {
    ok: false;
    code: string;
    message: string;
  };
  pointerPreflight: { ok: true } | { ok: false; code: string; message: string };
}

/**
 * Archive/bootstrap preflight.  This deliberately performs no state-root,
 * plugin, pointer, receipt, or host mutation.  The verified release archive
 * must already contain runnable `dist/**` bytes; the real install then passes
 * this digest back into the same ImmutableInstallUpdater transaction.
 */
export function preflightImmutableInstallCandidate(input: {
  packageRoot: string;
  mode: InstallGateMode;
  expectedPackageDigest?: string;
  assetSha256?: string;
}): Result<ImmutableInstallPreflightV1, RuntimeError> {
  const identity = computePackageIdentity(input.packageRoot);
  if (!identity.ok) return identity;
  if (input.mode === 'release' && isDirtyGitSource(identity.value.rootPath)) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'release install refuses a dirty/local checkout'));
  }
  const runnable = validateRunnablePackageEntrypoints(identity.value);
  if (!runnable.ok) return runnable;
  if (input.expectedPackageDigest !== undefined
    && input.expectedPackageDigest !== identity.value.digest) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'package digest changed after preflight', {
      expectedDigest: input.expectedPackageDigest,
      actualDigest: identity.value.digest,
    }));
  }
  const assetSha256 = input.assetSha256?.toLowerCase() ?? null;
  if (assetSha256 !== null && !/^[a-f0-9]{64}$/.test(assetSha256)) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'asset SHA-256 is malformed'));
  }
  return ok({
    schemaVersion: 1,
    mode: input.mode,
    packageRoot: identity.value.rootPath,
    packageName: identity.value.packageName,
    pluginName: identity.value.pluginName,
    version: identity.value.version,
    packageDigest: identity.value.digest,
    assetSha256,
    runnableEntrypoints: true,
  });
}

interface PointerSnapshot {
  name: 'oma' | 'omy';
  path: string;
  previousTarget: string | null;
}

export function classifyDoctorProbe(
  mode: InstallGateMode,
  probe: Readonly<DoctorProbeV1>,
): Result<InstallReceiptV1['status'], RuntimeError> {
  if (!probe.valid || probe.exitCode === null || !Number.isSafeInteger(probe.exitCode)) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'doctor output is malformed', {
      argv: probe.argv,
      stdoutSha256: sha256(probe.stdout),
      stderrSha256: sha256(probe.stderr),
    }));
  }
  if (probe.exitCode === 0) return ok('installed');
  if (probe.exitCode === 2 && mode === 'development') return ok('completed_with_warning');
  return err(runtimeError('E_VALIDATOR_REJECTED', 'doctor gate rejected installed candidate', {
    mode,
    exitCode: probe.exitCode,
    argv: probe.argv,
    stdoutSha256: sha256(probe.stdout),
    stderrSha256: sha256(probe.stderr),
  }));
}

export class ImmutableInstallUpdater {
  private readonly options: ImmutableInstallUpdaterOptions;

  constructor(options: Readonly<ImmutableInstallUpdaterOptions>) {
    this.options = { ...options };
  }

  /**
   * 設計概念映射：OMC `update --check` 只核對 identity/digest 與 preflight，不置換。
   * 禁止 staging、pointer switch、receipt、host registry mutation。
   */
  check(): ImmutableInstallCheckV1 {
    const candidateResult = computePackageIdentity(this.options.packageRoot);
    const candidate = candidateResult.ok ? summarizePackageIdentity(candidateResult.value) : null;
    const preflight = preflightImmutableInstallCandidate({
      packageRoot: this.options.packageRoot,
      mode: this.options.mode,
      expectedPackageDigest: this.options.expectedPackageDigest,
      assetSha256: this.options.assetSha256,
    });
    const preflightReport = preflight.ok
      ? { ok: true as const, report: preflight.value }
      : {
        ok: false as const,
        code: preflight.error.code,
        message: preflight.error.message,
      };
    const pointers = inspectPointers(this.options.binDir, false);
    const pointerPreflight = pointers.ok
      ? { ok: true as const }
      : {
        ok: false as const,
        code: pointers.error.code,
        message: pointers.error.message,
      };

    const named = readPackagePluginName(this.options.packageRoot);
    const pluginName = candidate?.pluginName ?? (named.ok ? named.value : 'oh-my-agy');
    const installedRead = readInstalledIdentityIfPresent({
      pluginName,
      antigravityConfigRoot: this.options.antigravityConfigRoot,
      homeDir: this.options.homeDir,
    });
    const installed = installedRead.identity === null
      ? null
      : {
        version: installedRead.identity.version,
        digest: installedRead.identity.digest,
        installPath: installedRead.identity.rootPath,
      };

    if (!preflight.ok) {
      return this.checkReport(
        UPDATE_CHECK_NOT_UPGRADEABLE,
        preflight.error.message,
        candidate,
        installed,
        preflightReport,
        pointerPreflight,
      );
    }
    if (!candidateResult.ok) {
      return this.checkReport(
        UPDATE_CHECK_NOT_UPGRADEABLE,
        candidateResult.error.message,
        null,
        installed,
        preflightReport,
        pointerPreflight,
      );
    }
    if (!pointers.ok) {
      return this.checkReport(
        UPDATE_CHECK_NOT_UPGRADEABLE,
        pointers.error.message,
        candidate,
        installed,
        preflightReport,
        pointerPreflight,
      );
    }
    if (installed !== null && installed.digest === candidateResult.value.digest) {
      return this.checkReport(
        UPDATE_CHECK_NO_UPDATE_NEEDED,
        UPDATE_CHECK_NO_UPDATE_NEEDED_MESSAGE,
        candidate,
        installed,
        preflightReport,
        pointerPreflight,
      );
    }
    return this.checkReport(
      UPDATE_CHECK_UPGRADEABLE,
      'upgrade available; no replacement',
      candidate,
      installed,
      preflightReport,
      pointerPreflight,
    );
  }

  private checkReport(
    classification: UpdateCheckClassificationV1,
    message: string,
    candidate: PackageIdentitySummaryV1 | null,
    installed: ImmutableInstallCheckV1['installed'],
    preflight: ImmutableInstallCheckV1['preflight'],
    pointerPreflight: ImmutableInstallCheckV1['pointerPreflight'],
  ): ImmutableInstallCheckV1 {
    return {
      schema: UPDATE_CHECK_SCHEMA,
      schemaVersion: 1,
      classification,
      message,
      replacement: false,
      candidate,
      installed,
      preflight,
      pointerPreflight,
    };
  }

  async run(): Promise<Result<ImmutableInstallUpdateSuccess, RuntimeError>> {
    const source = computePackageIdentity(this.options.packageRoot);
    if (!source.ok) return source;
    const runnable = validateRunnablePackageEntrypoints(source.value);
    if (!runnable.ok) return runnable;
    if (this.options.expectedPackageDigest !== undefined
      && this.options.expectedPackageDigest !== source.value.digest) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'package digest does not match expected asset', {
        expectedDigest: this.options.expectedPackageDigest,
        actualDigest: source.value.digest,
      }));
    }
    if ((this.options.rejectDirty === true || this.options.mode === 'release')
      && isDirtyGitSource(source.value.rootPath)) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'release install refuses a dirty/local checkout'));
    }
    const pointerPreflight = inspectPointers(this.options.binDir, true);
    if (!pointerPreflight.ok) return pointerPreflight;

    const transactionId = this.options.idFactory?.() ?? crypto.randomUUID();
    const transaction = new PluginSetupTransaction({
      packageRoot: source.value.rootPath,
      stateRoot: this.options.stateRoot,
      antigravityConfigRoot: this.options.antigravityConfigRoot,
      homeDir: this.options.homeDir,
      adapter: this.options.adapter,
      idFactory: () => transactionId,
    });
    const plugin = await transaction.run();
    if (!plugin.ok) return plugin;

    const switched = switchPointers(pointerPreflight.value, plugin.value.stagePath);
    if (!switched.ok) {
      const rollback = await transaction.rollback(plugin.value, 'CLI pointer switch failed');
      return rollback.ok ? switched : err(rollback.error);
    }

    const doctor = await this.runDoctorProbe(plugin.value);
    const classified = classifyDoctorProbe(this.options.mode, doctor);
    if (!classified.ok) {
      const pointerRollback = restorePointers(pointerPreflight.value, plugin.value.stagePath);
      const pluginRollback = await transaction.rollback(plugin.value, 'doctor gate rejected candidate');
      if (!pointerRollback.ok || !pluginRollback.ok) {
        return err(runtimeError('E_PLUGIN_NOT_ACTIVE', classified.error.message, {
          doctor: classified.error.details ?? null,
          pointerRollback: pointerRollback.ok ? 'ok' : pointerRollback.error,
          pluginRollback: pluginRollback.ok ? 'ok' : pluginRollback.error,
        }));
      }
      return classified;
    }

    const receiptPath = path.join(
      path.resolve(this.options.stateRoot),
      'install',
      'receipts',
      `${transactionId}.json`,
    );
    const receipt = createInstallReceipt({
      transactionId,
      status: classified.value,
      source: source.value,
      installed: plugin.value.installedIdentity,
      assetSha256: this.options.assetSha256,
      sourceUri: this.options.sourceUri,
      sourceTag: this.options.sourceTag,
      peeledCommit: this.options.peeledCommit,
      hostVersion: this.options.hostVersion,
      ownedInventory: [
        {
          path: plugin.value.stagePath,
          kind: 'stage',
          identity: plugin.value.stageIdentity.digest,
        },
        {
          path: plugin.value.installedIdentity.installPath,
          kind: 'host_plugin',
          identity: plugin.value.installedIdentity.digest,
        },
        ...pointerPreflight.value.map((pointer) => ({
          path: pointer.path,
          kind: 'cli_symlink' as const,
          identity: path.join(plugin.value.stagePath, 'dist', 'bin', 'oma.js'),
        })),
        { path: receiptPath, kind: 'receipt' as const, identity: transactionId },
      ],
      commands: [
        ...plugin.value.commands,
        commandReceipt(doctor.argv, doctor.exitCode ?? 1, doctor.stdout, doctor.stderr),
      ],
    });
    const written = writeInstallReceipt(receiptPath, receipt);
    if (!written.ok) {
      const pointerRollback = restorePointers(pointerPreflight.value, plugin.value.stagePath);
      const pluginRollback = await transaction.rollback(plugin.value, 'receipt write failed');
      return pointerRollback.ok && pluginRollback.ok ? written : err(runtimeError(
        'E_CORRUPT_STATE',
        'receipt write and rollback did not both complete',
      ));
    }

    let restoredPrior = false;
    if (this.options.restoreAfterSuccess === true) {
      const pointerRollback = restorePointers(pointerPreflight.value, plugin.value.stagePath);
      const pluginRollback = await transaction.rollback(plugin.value, 'attestation restored prior install');
      if (!pointerRollback.ok || !pluginRollback.ok) {
        return err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'attestation passed but prior install restoration failed', {
          pointerRollback: pointerRollback.ok ? 'ok' : pointerRollback.error,
          pluginRollback: pluginRollback.ok ? 'ok' : pluginRollback.error,
          receiptPath: written.value,
        }));
      }
      restoredPrior = true;
    }

    return ok({
      status: classified.value,
      transactionId,
      stagePath: plugin.value.stagePath,
      installedPath: plugin.value.installedIdentity.installPath,
      installedDigest: plugin.value.installedIdentity.digest,
      receiptPath: written.value,
      doctorExitCode: doctor.exitCode as 0 | 2,
      restoredPrior,
    });
  }

  private async runDoctorProbe(plugin: SetupTransactionSuccess): Promise<DoctorProbeV1> {
    if (this.options.doctorProbe !== undefined) return this.options.doctorProbe();
    const mode = this.options.mode === 'release' ? 'release' : 'development';
    const report = await runDoctor({
      packageRoot: plugin.stagePath,
      packageVersion: plugin.stageIdentity.version,
      agyCommand: this.options.agyCommand,
      adapter: this.options.adapter,
      antigravityConfigRoot: this.options.antigravityConfigRoot,
      homeDir: this.options.homeDir,
      stateRoot: this.options.stateRoot,
      mode,
    });
    const argv = ['node', path.join(plugin.stagePath, 'dist', 'bin', 'oma.js'), 'doctor', '--json'];
    if (!report.ok) {
      return {
        argv,
        exitCode: 1,
        stdout: '',
        stderr: `${report.error.code}: ${report.error.message}`,
        valid: true,
      };
    }
    return {
      argv,
      exitCode: report.value.exitCode,
      stdout: canonicalJson(report.value),
      stderr: report.value.exitCode === 0 ? '' : doctorReportToLines(report.value).join('\n'),
      valid: true,
    };
  }
}

function inspectPointers(
  binDir: string,
  createDirectory = true,
): Result<PointerSnapshot[], RuntimeError> {
  const directory = path.resolve(binDir);
  const snapshots: PointerSnapshot[] = [];
  try {
    if (createDirectory) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    } else if (!fs.existsSync(directory)) {
      return ok([]);
    }
    for (const name of ['oma', 'omy'] as const) {
      const pointerPath = path.join(directory, name);
      if (!fs.existsSync(pointerPath) && !isBrokenSymlink(pointerPath)) {
        snapshots.push({ name, path: pointerPath, previousTarget: null });
        continue;
      }
      const stat = fs.lstatSync(pointerPath);
      if (!stat.isSymbolicLink()) {
        return err(runtimeError('E_ALREADY_EXISTS', `foreign CLI path is not an OMA symlink: ${pointerPath}`));
      }
      const target = fs.readlinkSync(pointerPath);
      const resolved = path.isAbsolute(target) ? target : path.resolve(directory, target);
      if (!isOwnedOmaCli(resolved)) {
        return err(runtimeError('E_ALREADY_EXISTS', `foreign CLI symlink is preserved: ${pointerPath}`));
      }
      snapshots.push({ name, path: pointerPath, previousTarget: target });
    }
    return ok(snapshots);
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'CLI pointer preflight failed', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

function isBrokenSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink() && !fs.existsSync(target);
  } catch {
    return false;
  }
}

function isOwnedOmaCli(cliPath: string): boolean {
  try {
    const real = fs.realpathSync(cliPath);
    if (path.basename(real) !== 'oma.js' || path.basename(path.dirname(real)) !== 'bin'
      || path.basename(path.dirname(path.dirname(real))) !== 'dist') return false;
    const packageRoot = path.dirname(path.dirname(path.dirname(real)));
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      name?: string;
    };
    return pkg.name === '@iml1s/oh-my-agy';
  } catch {
    return false;
  }
}

function switchPointers(
  snapshots: readonly PointerSnapshot[],
  stagePath: string,
): Result<void, RuntimeError> {
  const target = path.join(stagePath, 'dist', 'bin', 'oma.js');
  const switched: PointerSnapshot[] = [];
  try {
    for (const snapshot of snapshots) {
      const temporary = `${snapshot.path}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.symlinkSync(target, temporary);
      fs.renameSync(temporary, snapshot.path);
      switched.push(snapshot);
    }
    return ok(undefined);
  } catch (error) {
    const restored = restorePointers(switched, stagePath);
    return err(runtimeError('E_CORRUPT_STATE', 'CLI pointer switch failed', {
      cause: error instanceof Error ? error.message : String(error),
      rollback: restored.ok ? 'ok' : restored.error,
    }));
  }
}

function restorePointers(
  snapshots: readonly PointerSnapshot[],
  stagePath: string,
): Result<void, RuntimeError> {
  const candidateTarget = path.join(stagePath, 'dist', 'bin', 'oma.js');
  try {
    for (const snapshot of [...snapshots].reverse()) {
      if (fs.existsSync(snapshot.path) || isBrokenSymlink(snapshot.path)) {
        const stat = fs.lstatSync(snapshot.path);
        if (!stat.isSymbolicLink()) {
          return err(runtimeError('E_ALREADY_EXISTS', 'CLI pointer changed during rollback', {
            path: snapshot.path,
          }));
        }
        const current = fs.readlinkSync(snapshot.path);
        const resolved = path.isAbsolute(current) ? current : path.resolve(path.dirname(snapshot.path), current);
        if (path.resolve(resolved) !== path.resolve(candidateTarget)) {
          return err(runtimeError('E_ALREADY_EXISTS', 'CLI symlink changed during rollback', {
            path: snapshot.path,
          }));
        }
        fs.rmSync(snapshot.path, { force: true });
      }
      if (snapshot.previousTarget !== null) fs.symlinkSync(snapshot.previousTarget, snapshot.path);
    }
    return ok(undefined);
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'CLI pointer rollback failed', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

function isDirtyGitSource(packageRoot: string): boolean {
  const inside = spawnSync('git', ['-C', packageRoot, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return false;
  const status = spawnSync('git', ['-C', packageRoot, 'status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return status.status !== 0 || status.stdout.trim() !== '';
}

export function renderUpdateCheck(report: Readonly<ImmutableInstallCheckV1>): string {
  const redacted = redactValue(report);
  assertRedacted(redacted);
  return `${JSON.stringify(redacted, null, 2)}\n`;
}

export function updateCheckExitCode(report: Readonly<ImmutableInstallCheckV1>): number {
  return report.classification === UPDATE_CHECK_NOT_UPGRADEABLE ? 1 : 0;
}

export function defaultPluginCommandAdapter(
  command = 'agy',
  env: NodeJS.ProcessEnv = process.env,
): PluginCommandAdapter {
  return {
    async run(argv: readonly string[]): Promise<PluginCommandResult> {
      return await new Promise((resolve) => {
        const child = spawn(command, [...argv], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...env },
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          child.kill('SIGTERM');
          settled = true;
          resolve({ argv: [...argv], code: 124, stdout, stderr: `${stderr}\ntimeout: result unknown` });
        }, 60_000);
        child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ argv: [...argv], code: 127, stdout, stderr: `${stderr}${error.message}` });
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ argv: [...argv], code: code ?? 1, stdout, stderr });
        });
      });
    },
  };
}

async function cli(argv: readonly string[]): Promise<number> {
  const mode: InstallGateMode = argv.includes('--release') ? 'release' : 'development';
  const option = (name: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const packageRoot = path.resolve(option('--package-root', process.cwd())!);
  if (argv.includes('--preflight-only')) {
    const preflight = preflightImmutableInstallCandidate({
      packageRoot,
      mode,
      expectedPackageDigest: option('--package-digest'),
      assetSha256: option('--asset-sha256'),
    });
    if (!preflight.ok) {
      process.stderr.write(`${preflight.error.code}: ${preflight.error.message}\n`);
      return 1;
    }
    process.stdout.write(`${canonicalJson({ ok: true, ...preflight.value })}\n`);
    return 0;
  }
  const homeDir = path.resolve(option('--home', os.homedir())!);
  const state = resolveStateRoot({
    env: { ...process.env, OMA_STATE_ROOT: option('--state-root', process.env.OMA_STATE_ROOT) },
    homeDirectory: homeDir,
    create: true,
  });
  if (!state.ok) {
    process.stderr.write(`${state.error.code}: ${state.error.message}\n`);
    return 1;
  }
  const updater = new ImmutableInstallUpdater({
    packageRoot,
    stateRoot: state.value.path,
    homeDir,
    antigravityConfigRoot: option('--config-root'),
    binDir: path.resolve(option('--bin-dir', path.join(homeDir, '.local', 'bin'))!),
    adapter: defaultPluginCommandAdapter(option('--agy', 'agy')),
    mode,
    expectedPackageDigest: option('--package-digest'),
    assetSha256: option('--asset-sha256'),
    sourceUri: option('--source-uri'),
    sourceTag: option('--source-tag'),
    peeledCommit: option('--peeled-commit'),
    agyCommand: option('--agy', 'agy'),
  });
  const result = await updater.run();
  if (!result.ok) {
    process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
    return 1;
  }
  process.stdout.write(`${canonicalJson({ ok: true, ...result.value })}\n`);
  // Successful installs must exit 0 even when post-install doctor only warns.
  // Status remains `completed_with_warning` in the receipt/JSON; returning 2
  // here made `curl | bash` / install.sh look failed after a receipt was written.
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
