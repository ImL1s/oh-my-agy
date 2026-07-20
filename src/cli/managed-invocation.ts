import * as crypto from 'crypto';
import { RuntimeError } from '../runtime/errors';
import {
  HeadlessPolicy,
  InteractivePolicy,
  ProcessOutcome,
} from '../runtime/process';
import { OperationIdentity, ProcessIdentity, Result, err, ok } from '../runtime/types';
import { ManagedMode, ModeDirectiveRenderer } from '../modes/directives';
import { buildModeCommand } from '../modes/commands';
import { appendSkillProtocol } from '../modes/skill-protocol';
import { guardDangerousArgv } from './dangerous-launch';
import { wrapManagedSearchLaunch } from '../runtime/sandbox';
import * as path from 'path';

export interface PreparedManagedInvocation {
  readonly kind: 'launch' | 'resume';
  readonly launchTransactionId: string;
  readonly sessionId: string;
  readonly conversationId: string | null;
  readonly launchNonce: string;
  readonly invocationGeneration: number;
  readonly cwd: string;
  readonly operationIdentity: OperationIdentity;
}

export interface PrepareManagedLaunchInput {
  readonly mode: ManagedMode;
  readonly taskDigest: string;
}

export interface PrepareManagedResumeInput {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly expectedRevision: number;
}

export interface ManagedLaunchTransaction {
  prepareLaunch(
    input: Readonly<PrepareManagedLaunchInput>,
  ): Promise<Result<PreparedManagedInvocation, RuntimeError>>;
  prepareResume(
    input: Readonly<PrepareManagedResumeInput>,
  ): Promise<Result<PreparedManagedInvocation, RuntimeError>>;
  recordChildSpawned(
    prepared: Readonly<PreparedManagedInvocation>,
    identity: Readonly<ProcessIdentity>,
  ): Result<void, RuntimeError>;
  recordOutcome(
    prepared: Readonly<PreparedManagedInvocation>,
    outcome: Readonly<ProcessOutcome>,
  ): Promise<Result<void, RuntimeError>>;
}

export interface InteractiveRunner {
  foregroundInteractive(
    command: string,
    argv: readonly string[],
    identity: Readonly<OperationIdentity>,
    policy?: InteractivePolicy,
  ): Promise<Result<ProcessOutcome, RuntimeError>>;
  boundedHeadless?(
    command: string,
    argv: readonly string[],
    policy: Readonly<HeadlessPolicy>,
    identity: Readonly<OperationIdentity>,
  ): Promise<Result<ProcessOutcome, RuntimeError>>;
}

export interface ManagedInvocationDependencies {
  readonly agyCommand?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  /** package root；注入 OMA_PACKAGE_ROOT 供 hook debug 與診斷 */
  readonly packageRoot?: string;
  /** workspace path；注入 OMA_WORKSPACE_PATH，因 hook cwd 是 hooks.json 目錄 */
  readonly workspacePath?: string;
  /** 明確 state root；注入 OMA_STATE_ROOT 避免 hook 落到 platform-default */
  readonly stateRoot?: string;
  readonly preflight: () => Promise<Result<unknown, RuntimeError>>;
  readonly transaction: ManagedLaunchTransaction;
  readonly runner: InteractiveRunner;
  readonly nonceFactory?: () => string;
}

export class ManagedInvocationService {
  private readonly agyCommand: string;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly packageRoot: string | undefined;
  private readonly workspacePath: string | undefined;
  private readonly stateRoot: string | undefined;
  private readonly preflight: ManagedInvocationDependencies['preflight'];
  private readonly transaction: ManagedLaunchTransaction;
  private readonly runner: InteractiveRunner;
  private readonly nonceFactory: () => string;

  constructor(dependencies: Readonly<ManagedInvocationDependencies>) {
    this.agyCommand = dependencies.agyCommand ?? 'agy';
    this.environment = dependencies.environment ?? process.env;
    this.packageRoot = dependencies.packageRoot;
    this.workspacePath = dependencies.workspacePath;
    this.stateRoot = dependencies.stateRoot;
    this.preflight = dependencies.preflight;
    this.transaction = dependencies.transaction;
    this.runner = dependencies.runner;
    this.nonceFactory = dependencies.nonceFactory ?? (() => crypto.randomBytes(16).toString('hex'));
  }

  async launchMode(
    mode: ManagedMode,
    task: string,
  ): Promise<Result<ProcessOutcome, RuntimeError>> {
    const preflight = await this.preflight();
    if (!preflight.ok) return preflight;

    const taskBytes = Buffer.from(task, 'utf8');
    const command = buildModeCommand(
      { mode, task },
      new ModeDirectiveRenderer(this.nonceFactory),
    );
    if (!command.ok) return command;
    // session 內 skill protocol：附加在 OMA_TASK 分隔符外，讓 agy agent 必讀 workflow
    const directiveWithSkill = appendSkillProtocol(
      command.value.directive,
      mode,
      this.packageRoot,
    );
    const argvWithSkill = Object.freeze([
      ...command.value.argv.slice(0, -1),
      directiveWithSkill,
    ]);
    const prepared = await this.transaction.prepareLaunch({
      mode,
      taskDigest: crypto.createHash('sha256').update(taskBytes).digest('hex'),
    });
    if (!prepared.ok) return prepared;
    let argv: readonly string[] = argvWithSkill;
    let launchCommand = this.agyCommand;
    if (mode === 'search') {
      const plansDir = path.join(prepared.value.cwd, '.agy', 'plans');
      const sandboxed = wrapManagedSearchLaunch(this.agyCommand, argv, prepared.value.cwd, plansDir);
      if (!sandboxed.ok) return sandboxed;
      launchCommand = sandboxed.value.command;
      argv = sandboxed.value.argv;
    }
    return this.runManaged(prepared.value, argv, launchCommand, mode === 'search', mode);
  }

  async resumeConversation(
    sessionId: string,
    conversationId: string,
    expectedRevision: number,
  ): Promise<Result<ProcessOutcome, RuntimeError>> {
    const preflight = await this.preflight();
    if (!preflight.ok) return preflight;
    const prepared = await this.transaction.prepareResume({ sessionId, conversationId, expectedRevision });
    if (!prepared.ok) return prepared;
    if (
      prepared.value.kind !== 'resume'
      || prepared.value.conversationId !== conversationId
      || prepared.value.invocationGeneration < 2
    ) {
      return err({
        code: 'E_INVOCATION_GENERATION_MISMATCH',
        message: 'Resume transaction did not return the exact conversation and next generation',
      });
    }
    return this.runManaged(
      prepared.value,
      ['--conversation', conversationId],
      this.agyCommand,
      false,
      undefined,
    );
  }

  async passThrough(argv: readonly string[]): Promise<Result<ProcessOutcome, RuntimeError>> {
    const guarded = await guardDangerousArgv(argv, {
      isTTY: Boolean(process.stdin.isTTY),
    });
    if (!guarded.ok) return guarded;
    const nonce = crypto.randomBytes(16).toString('hex');
    return this.runner.foregroundInteractive(
      this.agyCommand,
      [...guarded.value],
      { operationId: `passthrough:${nonce}`, ownerNonce: nonce },
      { env: ordinaryEnvironment(this.environment) },
    );
  }

  private async runManaged(
    prepared: Readonly<PreparedManagedInvocation>,
    argv: readonly string[],
    command: string = this.agyCommand,
    preferHeadless = false,
    managedMode?: ManagedMode,
  ): Promise<Result<ProcessOutcome, RuntimeError>> {
    // defense-in-depth：managed final argv 亦過危險旗標 gate
    const guarded = await guardDangerousArgv(argv, {
      isTTY: Boolean(process.stdin.isTTY),
    });
    if (!guarded.ok) return guarded;
    const safeArgv = [...guarded.value];
    const env: NodeJS.ProcessEnv = {
      ...this.environment,
      OMA_SESSION_ID: prepared.sessionId,
      OMA_LAUNCH_NONCE: prepared.launchNonce,
      OMA_INVOCATION_GENERATION: String(prepared.invocationGeneration),
    };
    if (managedMode !== undefined) env.OMA_MANAGED_MODE = managedMode;
    // hook cwd ≠ workspace；必須把 workspace / package / state 顯式注入 child env
    const workspacePath = this.workspacePath ?? prepared.cwd;
    if (workspacePath) env.OMA_WORKSPACE_PATH = workspacePath;
    if (this.packageRoot) env.OMA_PACKAGE_ROOT = this.packageRoot;
    if (this.stateRoot) env.OMA_STATE_ROOT = this.stateRoot;
    let spawnRecordError: RuntimeError | undefined;
    const onSpawn = (identity: ProcessIdentity) => {
      const recorded = this.transaction.recordChildSpawned(prepared, identity);
      if (!recorded.ok) spawnRecordError = recorded.error;
      return recorded;
    };
    // search / OMA_MANAGED_HEADLESS=1：走 boundedHeadless 以套用 maxOutputBytes kill
    const useHeadless = preferHeadless || process.env.OMA_MANAGED_HEADLESS === '1';
    const maxOutputBytes = process.env.OMA_MAX_OUTPUT_BYTES
      ? Number(process.env.OMA_MAX_OUTPUT_BYTES)
      : undefined;
    const maxProcessCount = process.env.OMA_MAX_PROCESS_COUNT
      ? Number(process.env.OMA_MAX_PROCESS_COUNT)
      : undefined;
    let outcome: Result<ProcessOutcome, RuntimeError>;
    if (useHeadless && this.runner.boundedHeadless) {
      outcome = await this.runner.boundedHeadless(
        command,
        safeArgv,
        {
          deadlineMs: Number(process.env.OMA_TIMEOUT_MS ?? 3_600_000),
          maxOutputBytes: Number.isFinite(maxOutputBytes!) ? maxOutputBytes : 1024 * 1024,
          maxProcessCount: Number.isFinite(maxProcessCount!) ? maxProcessCount : undefined,
          cwd: prepared.cwd,
          env,
          onSpawn,
        },
        prepared.operationIdentity,
      );
    } else {
      outcome = await this.runner.foregroundInteractive(
        command,
        safeArgv,
        prepared.operationIdentity,
        { cwd: prepared.cwd, env, onSpawn },
      );
    }
    if (!outcome.ok) return outcome;
    if (spawnRecordError !== undefined) return err(spawnRecordError);
    const recorded = await this.transaction.recordOutcome(prepared, outcome.value);
    return recorded.ok ? ok(outcome.value) : recorded;
  }
}

export function ordinaryEnvironment(environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.OMA_SESSION_ID;
  delete sanitized.OMA_LAUNCH_NONCE;
  delete sanitized.OMA_INVOCATION_GENERATION;
  // ordinary pass-through 不可冒充 managed binding；保留 STATE/PACKAGE 診斷 env 無妨
  delete sanitized.OMA_WORKSPACE_PATH;
  return sanitized;
}
