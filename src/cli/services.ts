import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AutopilotRuntime } from '../autopilot/runtime';
import { ProcessRunner } from '../runtime/process';
import { resolveStateRoot, resolveWorkspaceIdentity } from '../runtime/state-root';
import { Result, err, ok } from '../runtime/types';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { verifyPluginActive, PluginCommandAdapter } from '../setup/plugin';
import { PluginSetupTransaction } from '../setup/transaction';
import { doctorReportToLines, runDoctor } from '../setup/doctor';
import { teamCommand as runTeamCommand } from '../team/commands';
import { RuntimeContext } from '../team/types';
import { ManagedInvocationService, ordinaryEnvironment } from './managed-invocation';
import {
  RuntimeManagedTransactionAdapter,
  inspectNativeCapabilities,
  runExtendedCommand,
} from './runtime-adapter';
import { CliServices } from './application';
import { guardDangerousArgv } from './dangerous-launch';
import { canonicalBytesV1 } from '../contracts/state-schemas';

interface DoctorCliOptions {
  readonly asJson: boolean;
  readonly native: boolean;
  readonly strictPlugin: boolean;
}

class DoctorCliUsageError extends Error {}

export interface DefaultServicesOptions {
  packageRoot?: string;
  stateRoot?: string;
  cwd?: string;
  agyCommand?: string;
  version?: string;
  pluginAdapter?: PluginCommandAdapter;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  environment?: NodeJS.ProcessEnv;
  processRunner?: ProcessRunner;
  /** 測試注入：危險旗標確認 */
  dangerousLaunch?: {
    isTTY?: boolean;
    ask?: () => Promise<string>;
  };
}

/**
 * 設計概念映射：production CLI wiring 唯一入口；
 * Lane B 擁有 services 組裝，Team 語意委派 src/team/commands。
 */
export function createDefaultServices(
  options: Readonly<DefaultServicesOptions> = {},
): CliServices {
  const cwd = options.cwd ?? process.cwd();
  const packageRoot = options.packageRoot ?? findPackageRoot(__dirname);
  const agyCommand = options.agyCommand ?? 'agy';
  const version = options.version ?? readPackageVersion(packageRoot);
  const stdout = options.stdout ?? ((value) => process.stdout.write(value));
  const stderr = options.stderr ?? ((value) => process.stderr.write(value));
  const environment = options.environment ?? process.env;
  const runner = options.processRunner ?? new ProcessRunner();

  return {
    version,
    async launchMode(mode, task) {
      // managed mode 本身不帶 --madmax；仍防 task 字串外的未來 argv 擴充
      const managed = buildManagedService({
        packageRoot,
        cwd,
        agyCommand,
        stateRoot: options.stateRoot,
        pluginAdapter: options.pluginAdapter,
        runner,
      });
      if (!managed.ok) return managed;
      return managed.value.launchMode(mode, task);
    },
    async passThrough(argv) {
      const guarded = await guardDangerousArgv(argv, {
        isTTY: options.dangerousLaunch?.isTTY ?? Boolean(process.stdin.isTTY),
        ask: options.dangerousLaunch?.ask,
        stderr,
      });
      if (!guarded.ok) return guarded;
      return runner.foregroundInteractive(
        agyCommand,
        [...guarded.value],
        { operationId: 'passthrough', ownerNonce: 'ordinary' },
        { env: ordinaryEnvironment(process.env) },
      );
    },
    async autopilotCommand(argv) {
      const runtime = AutopilotRuntime.create({
        stateRoot: options.stateRoot,
        workspaceRoot: cwd,
      });
      if (!runtime.ok) {
        stderr(`${runtime.error.code}: ${runtime.error.message}\n`);
        return 1;
      }
      // drive：ledger + ManagedInvocationService.resumeConversation（production 呼叫者）
      const { parseAutopilotCommand } = await import('../autopilot/commands');
      const parsed = parseAutopilotCommand(argv);
      if (parsed.ok && parsed.value.kind === 'drive') {
        const driven = await runtime.value.drive(
          parsed.value.sessionId,
          parsed.value.conversationId,
          parsed.value.expectedRevision,
        );
        if (!driven.ok) {
          stderr(`${driven.error.code}: ${driven.error.message}\n`);
          return driven.error.code === 'E_VALIDATOR_REJECTED' ? 2 : 1;
        }
        const managed = buildManagedService({
          packageRoot,
          cwd,
          agyCommand,
          stateRoot: options.stateRoot,
          pluginAdapter: options.pluginAdapter,
          runner,
        });
        if (!managed.ok) {
          stderr(`${managed.error.code}: ${managed.error.message}\n`);
          return 1;
        }
        // 首次 drive 不依賴 plugin preflight：arm → spawn → bind。
        // 已綁定 conversation 則 arm 回 E_BINDING_CONFLICT → 改走 resumeConversation。
        let outcome = await driveFirstManagedLaunch({
          sessionId: driven.value.launch.sessionId,
          conversationId: driven.value.launch.conversationId,
          expectedRevision: driven.value.launch.expectedRevision,
          cwd,
          stateRoot: options.stateRoot,
          packageRoot,
          agyCommand,
          runner,
          goal: driven.value.view.goal,
        });
        if (!outcome.ok && (
          outcome.error.code === 'E_BINDING_CONFLICT'
          || outcome.error.code === 'E_CONVERSATION_UNBOUND'
        )) {
          outcome = await managed.value.resumeConversation(
            driven.value.launch.sessionId,
            driven.value.launch.conversationId,
            driven.value.launch.expectedRevision,
          );
        }
        if (!outcome.ok) {
          stderr(`${outcome.error.code}: ${outcome.error.message}\n`);
          stdout(`${JSON.stringify({
            ok: false,
            kind: 'autopilot-driven',
            view: driven.value.view,
            launch: driven.value.launch,
            error: outcome.error,
          }, null, 2)}\n`);
          return 1;
        }
        stdout(`${JSON.stringify({
          ok: true,
          kind: 'autopilot-driven',
          view: driven.value.view,
          launch: driven.value.launch,
          process: {
            code: outcome.value.code,
            signal: outcome.value.signal,
            timedOut: outcome.value.timedOut,
          },
        }, null, 2)}\n`);
        return outcome.value.code === 0 ? 0 : 1;
      }
      const result = await runtime.value.dispatch(argv);
      if (!result.ok) {
        stderr(`${result.error.code}: ${result.error.message}\n`);
        return result.error.code === 'E_VALIDATOR_REJECTED' ? 2 : 1;
      }
      stdout(`${JSON.stringify(result.value, null, 2)}\n`);
      return 0;
    },
    async teamCommand(argv) {
      const context = buildTeamContext(cwd, options.stateRoot);
      if (!context.ok) {
        stderr(`${context.error.code}: ${context.error.message}\n`);
        return 1;
      }
      const mayLaunch = ['start', 'supervise', 'tick'].includes(argv[0] ?? '');
      const pluginAdapter = options.pluginAdapter ?? defaultAgyPluginAdapter(
        agyCommand,
        NATIVE_PLUGIN_PROBE_LIMITS,
      );
      return runTeamCommand(argv, {
        context: context.value,
        storeRoot: context.value.stateRoot,
        stdout,
        stderr,
        ...(mayLaunch ? {
          providerProfileFactory: async () => {
            try {
              const native = await inspectNativeCapabilities({
                agyCommand,
                stateRoot: options.stateRoot,
                environment,
                packageRoot,
                pluginAdapter,
                cwd,
              }, false);
              return native.kind === 'profile'
                ? ok({ profile: native.profile, resolvedExecutable: native.profile.hostIdentity.realpath })
                : err(runtimeError(
                  'E_CAPABILITY_UNPROVEN',
                  native.diagnostics[0]?.message ?? 'Antigravity host capability profile is unavailable',
                  { diagnosticCode: native.diagnostics[0]?.code ?? 'E_CAPABILITY_HOST_UNAVAILABLE' },
                ));
            } catch (error) {
              return err(runtimeError(
                'E_CAPABILITY_UNPROVEN',
                'Antigravity host capability inspection failed',
                { cause: error instanceof Error ? error.message : String(error) },
              ));
            }
          },
        } : {}),
      });
    },
    async setupCommand(argv) {
      const global = !argv.includes('--workspace');
      const {
        parseSetupHosts,
        installSlashHosts,
        slashReportHasHardFailure,
      } = await import('../setup/host-install');
      const hosts = parseSetupHosts(argv);
      if (hosts.length === 0) {
        stderr('Invalid --host value. Use: all | agy | claude | grok\n');
        return 2;
      }
      const agyOnly = hosts.length === 1 && hosts[0] === 'agy';
      const runAgy = hosts.includes('all') || hosts.includes('agy');
      const runSlash = hosts.includes('all')
        || hosts.includes('claude')
        || hosts.includes('grok');

      // 設計概念映射：slash-first — agy 與 Claude/Grok slash 解耦；
      // 預設 all 時 agy 失敗只 warn 並繼續裝 slash（僅 --host agy 才 hard-fail）。
      let agyResult: unknown = null;
      if (runAgy) {
        const state = options.stateRoot
          ? ok({ path: options.stateRoot, source: 'environment' as const })
          : resolveStateRoot({ create: true });
        if (!state.ok) {
          if (agyOnly) {
            stderr(`${state.error.code}: ${state.error.message}\n`);
            return 1;
          }
          stderr(`warn: agy setup skipped (${state.error.code}: ${state.error.message})\n`);
          agyResult = { status: 'failed', error: state.error };
        } else {
          const adapter = options.pluginAdapter ?? defaultAgyPluginAdapter(agyCommand);
          const transaction = new PluginSetupTransaction({
            packageRoot,
            stateRoot: state.value.path,
            adapter,
          });
          const result = await transaction.run();
          if (!result.ok) {
            if (agyOnly) {
              stderr(`${result.error.code}: ${result.error.message}\n`);
              return 1;
            }
            stderr(
              `warn: agy plugin setup failed (${result.error.code}: ${result.error.message}); `
              + 'continuing slash host install\n',
            );
            agyResult = { status: 'failed', error: result.error };
          } else {
            agyResult = { ...result.value, mode: global ? 'global' : 'workspace' };
          }
        }
      }

      let slashResult: unknown = null;
      let slashHardFailed = false;
      if (runSlash) {
        const slashHosts = hosts.includes('all')
          ? (['claude', 'grok'] as const)
          : hosts.filter((h): h is 'claude' | 'grok' => h === 'claude' || h === 'grok');
        const installed = installSlashHosts(packageRoot, [...slashHosts]);
        if (!installed.ok) {
          stderr(`${installed.error.code}: ${installed.error.message}\n`);
          return 1;
        }
        slashResult = installed.value;
        slashHardFailed = slashReportHasHardFailure(installed.value);
      }

      stdout(`${JSON.stringify({
        agy: agyResult,
        slashHosts: slashResult,
        primaryUx: 'session slash /oh-my-agy:autopilot (not terminal-first)',
        next: [
          'Restart Claude Code / Grok session',
          'Type /oh-my-agy:autopilot <goal>',
          'oma doctor --no-strict-plugin',
        ],
      }, null, 2)}\n`);

      // failed (timeout 等) → 1；agy-only 失敗已 early return；needs_manual 仍 0
      if (slashHardFailed) return 1;
      return 0;
    },
    async doctorCommand(argv) {
      let doctorOptions: DoctorCliOptions;
      try {
        doctorOptions = parseDoctorCliOptions(argv);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (argv.filter((arg) => arg === '--json').length === 1) {
          stdout(`${canonicalBytesV1({
            command: 'doctor',
            error: { code: 'E_CLI_USAGE', message },
            exitCode: 2,
            ok: false,
            outcome: 'usage_error',
            schema: 'oma.cli-result/v1',
          }).toString('utf8')}\n`);
        } else {
          stderr(`E_CLI_USAGE: ${message}\n`);
        }
        return 2;
      }
      const adapter = options.pluginAdapter ?? defaultAgyPluginAdapter(agyCommand);
      const nativeAdapter = options.pluginAdapter ?? defaultAgyPluginAdapter(
        agyCommand,
        NATIVE_PLUGIN_PROBE_LIMITS,
      );
      const report = await runDoctor({
        packageRoot,
        packageVersion: version,
        agyCommand,
        adapter,
        strictPlugin: doctorOptions.strictPlugin,
        includeNativeCapabilities: doctorOptions.native,
        nativeCapabilitiesProbe: doctorOptions.native ? async () => {
          try {
            const inspected = await inspectNativeCapabilities({
              agyCommand,
              stateRoot: options.stateRoot,
              environment,
              packageRoot,
              pluginAdapter: nativeAdapter,
              cwd,
            }, false);
            if (inspected.kind === 'host_absent') return ok(inspected);
            return ok({
              kind: 'profile' as const,
              profile: inspected.profile,
              cacheStatus: inspected.cacheStatus,
              diagnostics: inspected.diagnostics,
            });
          } catch (error) {
            return err(runtimeError(
              'E_VALIDATOR_REJECTED',
              error instanceof Error ? error.message : String(error),
            ));
          }
        } : undefined,
      });
      if (!report.ok) {
        stderr(`${report.error.code}: ${report.error.message}\n`);
        return 1;
      }
      if (doctorOptions.asJson) {
        stdout(`${JSON.stringify(report.value, null, 2)}\n`);
      } else {
        stdout(`${doctorReportToLines(report.value).join('\n')}\n`);
      }
      return report.value.exitCode;
    },
    async skillCommand(argv) {
      // 設計概念映射：`oma doctor` 的雙路徑輸出（預設人類可讀，`--json` 才機器格式）。
      const {
        DEFAULT_SKILL_RENDER_FORMAT,
        parseSkillCommand,
        renderSkillCommandText,
        renderSkillErrorText,
        runSkillCommand,
      } = await import('./skill-commands');
      const parsed = parseSkillCommand(argv);
      if (!parsed.ok) {
        stderr(`${parsed.error.code}: ${parsed.error.message}\n`);
        return 2;
      }
      const format = parsed.value.format ?? DEFAULT_SKILL_RENDER_FORMAT;
      const result = runSkillCommand(parsed.value, packageRoot);
      if (!result.ok) {
        stderr(format === 'json'
          ? `${result.error.code}: ${result.error.message}\n`
          : renderSkillErrorText(result.error));
        return result.error.code === 'E_NOT_FOUND' ? 1 : 2;
      }
      stdout(format === 'json'
        ? `${JSON.stringify(result.value, null, 2)}\n`
        : renderSkillCommandText(parsed.value, result.value));
      return 0;
    },
    async nativeCommand(command, argv) {
      const { runNativeCommand } = await import('./runtime-adapter');
      return runNativeCommand(command, argv, {
        packageRoot,
        cwd,
        agyCommand,
        stateRoot: options.stateRoot,
        pluginAdapter: options.pluginAdapter ?? defaultAgyPluginAdapter(
          agyCommand,
          NATIVE_PLUGIN_PROBE_LIMITS,
        ),
        managedService: () => buildManagedService({
          packageRoot,
          cwd,
          agyCommand,
          stateRoot: options.stateRoot,
          pluginAdapter: options.pluginAdapter,
          runner,
        }),
        version,
        stdout,
        stderr,
        environment,
        runner,
      });
    },
    async extendedCommand(command, argv) {
      return runExtendedCommand(command, argv, {
        packageRoot,
        cwd,
        agyCommand,
        stateRoot: options.stateRoot,
        pluginAdapter: options.pluginAdapter ?? defaultAgyPluginAdapter(
          agyCommand,
          ['native-status', 'lsp-status', 'sidecar-status', 'production', 'workflow'].includes(command)
            ? NATIVE_PLUGIN_PROBE_LIMITS
            : DEFAULT_PLUGIN_COMMAND_LIMITS,
        ),
        managedService: () => buildManagedService({
          packageRoot,
          cwd,
          agyCommand,
          stateRoot: options.stateRoot,
          pluginAdapter: options.pluginAdapter,
          runner,
        }),
        version,
        stdout,
        stderr,
        environment,
        runner,
      });
    },
  };
}

function parseDoctorCliOptions(argv: readonly string[]): DoctorCliOptions {
  const allowed = new Set(['--json', '--native', '--no-strict-plugin']);
  const seen = new Set<string>();
  for (const arg of argv) {
    if (!allowed.has(arg)) {
      throw new DoctorCliUsageError(`doctor: unexpected argument ${JSON.stringify(arg)}`);
    }
    if (seen.has(arg)) {
      throw new DoctorCliUsageError(`doctor: duplicate option ${arg}`);
    }
    seen.add(arg);
  }
  return {
    asJson: seen.has('--json'),
    native: seen.has('--native'),
    strictPlugin: !seen.has('--no-strict-plugin'),
  };
}

function buildManagedService(input: {
  packageRoot: string;
  cwd: string;
  agyCommand: string;
  stateRoot?: string;
  pluginAdapter?: PluginCommandAdapter;
  runner: ProcessRunner;
}): Result<ManagedInvocationService, RuntimeError> {
  const resolvedStateRoot = input.stateRoot === undefined
    ? resolveStateRoot({ create: true })
    : ok({ path: input.stateRoot, source: 'environment' as const });
  if (!resolvedStateRoot.ok) return resolvedStateRoot;
  const transaction = RuntimeManagedTransactionAdapter.create({
    cwd: input.cwd,
    stateRoot: { env: { ...process.env, OMA_STATE_ROOT: resolvedStateRoot.value.path } },
  });
  if (!transaction.ok) return transaction;
  const adapter = input.pluginAdapter ?? defaultAgyPluginAdapter(input.agyCommand);
  return ok(new ManagedInvocationService({
    agyCommand: input.agyCommand,
    packageRoot: input.packageRoot,
    workspacePath: input.cwd,
    stateRoot: resolvedStateRoot.value.path,
    environment: {
      ...process.env,
      OMA_STATE_ROOT: resolvedStateRoot.value.path,
      OMA_PACKAGE_ROOT: input.packageRoot,
      OMA_WORKSPACE_PATH: input.cwd,
    },
    preflight: async () => verifyPluginActive({
      packageRoot: input.packageRoot,
      adapter,
    }),
    transaction: transaction.value,
    runner: {
      foregroundInteractive: (command, argv, identity, policy) =>
        input.runner.foregroundInteractive(command, argv, identity, policy),
      boundedHeadless: (command, argv, policy, identity) =>
        input.runner.boundedHeadless(command, argv, policy, identity),
    },
  }));
}

/**
 * 首次 autopilot drive：arm 既有 session → spawn managed agy → bind exact_env。
 */
async function driveFirstManagedLaunch(input: {
  sessionId: string;
  conversationId: string;
  expectedRevision: number;
  cwd: string;
  stateRoot?: string;
  packageRoot: string;
  agyCommand: string;
  runner: ProcessRunner;
  goal: string;
}): Promise<Result<import('../runtime/process').ProcessOutcome, RuntimeError>> {
  const { SessionLocator } = await import('../continuation/state');
  const { currentProcessIdentity } = await import('../runtime/process');
  const { sha256 } = await import('../runtime/atomic');
  const resolvedStateRoot = input.stateRoot === undefined
    ? resolveStateRoot({ create: true })
    : ok({ path: input.stateRoot, source: 'environment' as const });
  if (!resolvedStateRoot.ok) return resolvedStateRoot;
  const workspace = resolveWorkspaceIdentity(input.cwd);
  if (!workspace.ok) return workspace;
  const locator = new SessionLocator(resolvedStateRoot.value.path, workspace.value.workspaceKey, {
    resumeOwnerFactory: () => currentProcessIdentity('drive-owner'),
  });
  // findLivePending may block if autopilot left launch_pending — armExistingSessionForDrive handles CAS
  const armed = await locator.armExistingSessionForDrive({
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    expectedRevision: input.expectedRevision,
    workspacePath: input.cwd,
    ttlMs: 60_000,
  });
  if (!armed.ok) return armed;
  const pending = armed.value;
  const capability = locator.managedLaunch(pending);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OMA_SESSION_ID: pending.sessionId,
    OMA_LAUNCH_NONCE: pending.launchNonce,
    OMA_INVOCATION_GENERATION: String(pending.invocationGeneration),
    OMA_WORKSPACE_PATH: input.cwd,
    OMA_STATE_ROOT: resolvedStateRoot.value.path,
    OMA_PACKAGE_ROOT: input.packageRoot,
    OMA_MANAGED_HEADLESS: '1',
  };
  const prompt = input.goal.trim() === '' ? `Continue session ${input.sessionId}` : input.goal;
  const outcome = await input.runner.boundedHeadless(
    input.agyCommand,
    [prompt],
    {
      deadlineMs: Number(process.env.OMA_TIMEOUT_MS ?? 30_000),
      maxOutputBytes: Number(process.env.OMA_MAX_OUTPUT_BYTES ?? 1024 * 1024),
      cwd: input.cwd,
      env,
      onSpawn: (identity) => {
        const recorded = capability.recordChildSpawned(identity);
        return recorded.ok ? ok(undefined) : recorded;
      },
    },
    {
      operationId: `drive:${pending.sessionId}:${pending.invocationGeneration}`,
      ownerNonce: pending.owner.ownerNonce ?? 'drive-owner',
    },
  );
  if (!outcome.ok) return outcome;
  const bound = await locator.bindPreInvocation(
    {
      conversationId: input.conversationId,
      workspaceKeys: [workspace.value.workspaceKey],
    },
    {
      OMA_SESSION_ID: pending.sessionId,
      OMA_LAUNCH_NONCE: pending.launchNonce,
      OMA_INVOCATION_GENERATION: String(pending.invocationGeneration),
    },
  );
  if (bound.kind !== 'BoundExactEnv') {
    const diagnostic = bound.kind === 'AllowDiagnostic' ? bound.error : undefined;
    return err(runtimeError(
      diagnostic?.code ?? 'E_BINDING_CONFLICT',
      diagnostic?.message ?? 'Drive spawn completed but exact_env bind failed',
    ));
  }
  void sha256;
  return outcome;
}

function buildTeamContext(
  cwd: string,
  stateRootOption?: string,
): Result<RuntimeContext, RuntimeError> {
  const stateRoot = stateRootOption === undefined
    ? resolveStateRoot({ create: true })
    : ok({ path: stateRootOption, source: 'environment' as const });
  if (!stateRoot.ok) return stateRoot;
  const workspace = resolveWorkspaceIdentity(cwd);
  if (!workspace.ok) return workspace;
  return ok({
    stateRoot: stateRoot.value.path,
    workspaceRoot: cwd,
    repoKey: workspace.value.repoKey,
    workspaceKey: workspace.value.workspaceKey,
  });
}

interface PluginCommandLimitsV1 {
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}

const DEFAULT_PLUGIN_COMMAND_LIMITS: PluginCommandLimitsV1 = Object.freeze({
  timeoutMs: 30_000,
  maximumOutputBytes: 1024 * 1024,
});
const NATIVE_PLUGIN_PROBE_LIMITS: PluginCommandLimitsV1 = Object.freeze({
  timeoutMs: 5_000,
  maximumOutputBytes: 64 * 1024,
});

function defaultAgyPluginAdapter(
  agyCommand: string,
  limits: Readonly<PluginCommandLimitsV1> = DEFAULT_PLUGIN_COMMAND_LIMITS,
): PluginCommandAdapter {
  return {
    async run(argv) {
      return await new Promise((resolve) => {
        const detached = process.platform !== 'win32';
        const child = spawn(agyCommand, [...argv], {
          detached,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let outputBytes = 0;
        let timedOut = false;
        let overflowed = false;
        let settled = false;
        let terminationRequested = false;
        let timer: NodeJS.Timeout | undefined;
        let killFallback: NodeJS.Timeout | undefined;
        const finish = (code: number, extraStderr = '', destroyPipes = false) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          if (killFallback !== undefined) clearTimeout(killFallback);
          if (destroyPipes) {
            try { child.stdout?.destroy(); } catch (_) { /* bounded cleanup 僅能盡力執行 */ }
            try { child.stderr?.destroy(); } catch (_) { /* bounded cleanup 僅能盡力執行 */ }
          }
          resolve({ argv: [...argv], code, stdout, stderr: `${stderr}${extraStderr}` });
        };
        const terminateTree = () => {
          if (child.pid === undefined) return;
          if (process.platform !== 'win32') {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* 程序樹已結束 */ }
            return;
          }
          try {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
            killer.once('error', () => {
              try { child.kill('SIGKILL'); } catch (_) { /* 程序已結束 */ }
            });
            killer.once('close', (status) => {
              if (status === 0) return;
              try { child.kill('SIGKILL'); } catch (_) { /* 程序已結束 */ }
            });
          } catch (_) {
            try { child.kill('SIGKILL'); } catch (_) { /* 程序已結束 */ }
          }
        };
        const killWithFallback = (code: number, detail: string) => {
          if (terminationRequested || settled) return;
          terminationRequested = true;
          if (timer !== undefined) clearTimeout(timer);
          terminateTree();
          killFallback = setTimeout(() => { finish(code, detail, true); }, 1_000);
        };
        const capture = (chunk: Buffer | string, target: 'stdout' | 'stderr') => {
          if (settled || overflowed) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = limits.maximumOutputBytes - outputBytes;
          if (bytes.length > remaining) {
            const bounded = bytes.subarray(0, Math.max(0, remaining)).toString('utf8');
            if (target === 'stdout') stdout += bounded;
            else stderr += bounded;
            outputBytes = limits.maximumOutputBytes;
            overflowed = true;
            killWithFallback(1, 'E_PLUGIN_COMMAND_OUTPUT_OVERFLOW');
            return;
          }
          outputBytes += bytes.length;
          if (target === 'stdout') stdout += bytes.toString('utf8');
          else stderr += bytes.toString('utf8');
        };
        child.stdout?.on('data', (chunk: Buffer) => { capture(chunk, 'stdout'); });
        child.stderr?.on('data', (chunk: Buffer) => { capture(chunk, 'stderr'); });
        child.on('error', (error) => {
          finish(127, error.message);
        });
        child.on('close', (code) => {
          finish(
            timedOut ? 124 : overflowed ? 1 : code ?? 1,
            timedOut
              ? 'E_PLUGIN_COMMAND_TIMEOUT'
              : overflowed ? 'E_PLUGIN_COMMAND_OUTPUT_OVERFLOW' : '',
            terminationRequested,
          );
        });
        timer = setTimeout(() => {
          timedOut = true;
          killWithFallback(124, 'E_PLUGIN_COMMAND_TIMEOUT');
        }, limits.timeoutMs);
      });
    },
  };
}

function findPackageRoot(start: string): string {
  let current = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(current, 'plugin.json'))
      && fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(start, '../..');
}

function readPackageVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
