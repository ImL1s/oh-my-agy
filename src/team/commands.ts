import * as fs from 'fs';
import * as path from 'path';
import { formatCliError } from '../runtime/error-catalog';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { StateStore } from '../runtime/state-store';
import { Result, err, ok } from '../runtime/types';
import {
  executeTeamApiOperation,
  isTeamApiOperationP0,
  TEAM_API_OPERATIONS_P0,
  wrapTeamApiCliEnvelope,
} from './api-interop';
import {
  RecoveryForkResolver,
  RecoveryForkSelectionEvidenceV1,
  RecoveryTaskAggregateV1,
} from './recovery-fork';
import {
  HUD_WATCH_INTERVAL_MS_MAX,
  HUD_WATCH_INTERVAL_MS_MIN,
} from '../hud/watch';
import { TeamOrchestrator, TeamOrchestratorOptions, TeamWaitOptionsV1 } from './orchestrator';
import { isCanonicalTeamIdentifier, readTeamManifest } from './manifest';
import {
  DEFAULT_CAPTURE_LINES,
  TmuxSpawnFn,
  capturePane,
  listOwnedPanes,
  parseCaptureLineCount,
  printAttachArgv,
  sessionNameFromHeartbeat,
} from './pane-observe';
import { TeamStateStore } from './state';
import { RuntimeContext, SupervisorHeartbeatV1, TeamActorIdentityV1 } from './types';
import { resolveGitWorktreeIdentity } from './worktree';
import { runTeamWorker } from './worker-runtime';

export type ParsedTeamCommand =
  | {
      kind: 'resolve-fork';
      teamId: string;
      forkId: string;
      winnerGeneration: number;
      expectedRevision: number;
      evidencePath: string;
    }
  | {
      kind: 'start';
      manifestPath: string;
      workerMode: 'interactive' | 'headless';
      maxParallel?: number;
    }
  | {
      kind: 'status';
      teamId: string;
    }
  | {
      kind: 'stop';
      teamId: string;
    }
  | {
      kind: 'supervise';
      teamId: string;
    }
  | {
      kind: 'reclaim';
      teamId: string;
      taskId: string;
      expectedRevision: number;
      pane: 'alive' | 'dead' | 'unknown';
      process: 'alive' | 'dead' | 'unknown';
    }
  | {
      kind: 'deliver';
      teamId: string;
      taskId: string;
      expectedRevision: number;
      claimToken: string;
      generation: number;
      worktreePath: string;
    }
  | {
      kind: 'tick';
      teamId: string;
      workerMode: 'interactive' | 'headless';
      maxParallel?: number;
    }
  | {
      kind: 'wait';
      teamId: string;
      timeoutMs?: number;
      pollIntervalMs?: number;
      json: boolean;
    }
  | {
      kind: 'resume';
      teamId: string;
      expectedRevision: number;
      json: boolean;
    }
  | {
      kind: 'api';
      operation: string;
      inputJson: string;
      json: boolean;
    }
  | {
      kind: 'panes';
      teamId: string;
    }
  | {
      kind: 'capture';
      teamId: string;
      taskId: string;
      lines: number;
    }
  | {
      kind: 'view';
      teamId: string;
      taskId?: string;
      printArgv: true;
    }
  | {
      kind: 'worker-run';
      teamId: string;
      taskId: string;
      claimToken: string;
      generation: number;
    };

/**
 * 設計概念映射：Lane B 只做 argv→typed API 轉接；
 * start/status/stop/wait/resume 委派 TeamOrchestrator；resolve-fork 委派 RecoveryForkResolver。
 */
export function parseTeamCommand(argv: readonly string[]): Result<ParsedTeamCommand, RuntimeError> {
  const subcommand = argv[0];
  if (subcommand === 'resolve-fork') {
    const flags = parseStrictFlags(argv.slice(1));
    if (!flags.ok) return flags;
    const required = [
      '--team', '--fork', '--winner-generation', '--expected-revision', '--evidence',
    ];
    if (
      flags.value.size !== required.length
      || required.some((key) => !flags.value.has(key))
    ) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'Invalid or missing flags for team resolve-fork'));
    }
    const winnerGeneration = Number(flags.value.get('--winner-generation'));
    const expectedRevision = Number(flags.value.get('--expected-revision'));
    if (!Number.isSafeInteger(winnerGeneration) || winnerGeneration < 1) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'winner-generation must be a positive integer'));
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'expected-revision must be a non-negative integer'));
    }
    return ok({
      kind: 'resolve-fork',
      teamId: flags.value.get('--team')!,
      forkId: flags.value.get('--fork')!,
      winnerGeneration,
      expectedRevision,
      evidencePath: flags.value.get('--evidence')!,
    });
  }
  if (subcommand === 'start') {
    const flags = parseStrictFlags(argv.slice(1));
    if (!flags.ok) return flags;
    if (!flags.value.has('--manifest')) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'team start requires --manifest'));
    }
    // Headless is the only public CLI default with a complete profile-backed
    // readiness path. Interactive tmux remains explicit and fail-closed until
    // the caller supplies a fresh bounded readiness receipt.
    const workerMode = flags.value.get('--worker-mode') ?? 'headless';
    if (workerMode !== 'interactive' && workerMode !== 'headless') {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'worker-mode must be interactive or headless'));
    }
    // 設計概念映射：start 與 tick 共用 --max-parallel 驗證；OMC team --count / OMX team N / OMG team --workers。
    let maxParallel: number | undefined;
    if (flags.value.has('--max-parallel')) {
      const parsedMax = parseMaxParallelFlag(flags.value.get('--max-parallel')!);
      if (!parsedMax.ok) return parsedMax;
      maxParallel = parsedMax.value;
    }
    return ok({
      kind: 'start',
      manifestPath: flags.value.get('--manifest')!,
      workerMode,
      ...(maxParallel === undefined ? {} : { maxParallel }),
    });
  }
  if (subcommand === 'status') {
    const flags = parseStrictFlags(argv.slice(1));
    if (!flags.ok) return flags;
    if (flags.value.size !== 1 || !flags.value.has('--team')) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'team status requires --team'));
    }
    return ok({ kind: 'status', teamId: flags.value.get('--team')! });
  }
  if (subcommand === 'stop') {
    const flags = parseStrictFlags(argv.slice(1));
    if (!flags.ok) return flags;
    if (flags.value.size !== 1 || !flags.value.has('--team')) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'team stop requires --team'));
    }
    return ok({ kind: 'stop', teamId: flags.value.get('--team')! });
  }
  if (subcommand === 'supervise') {
    const flags = parseStrictFlags(argv.slice(1));
    if (!flags.ok) return flags;
    if (!flags.value.has('--team') || flags.value.size !== 1) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'team supervise requires --team'));
    }
    return ok({ kind: 'supervise', teamId: flags.value.get('--team')! });
  }
  if (subcommand === 'reclaim') {
    const flags = parseStrictFlags(argv.slice(1));
    if (!flags.ok) return flags;
    const required = ['--team', '--task', '--expected-revision', '--pane', '--process'];
    if (flags.value.size !== required.length || required.some((key) => !flags.value.has(key))) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'Invalid or missing flags for team reclaim'));
    }
    const expectedRevision = Number(flags.value.get('--expected-revision'));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'expected-revision must be a non-negative integer'));
    }
    const pane = flags.value.get('--pane')!;
    const processLive = flags.value.get('--process')!;
    if (!isLiveness(pane) || !isLiveness(processLive)) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'pane/process must be alive|dead|unknown'));
    }
    return ok({
      kind: 'reclaim',
      teamId: flags.value.get('--team')!,
      taskId: flags.value.get('--task')!,
      expectedRevision,
      pane,
      process: processLive,
    });
  }
  if (subcommand === 'deliver') {
    const flags = parseStrictFlags(argv.slice(1));
    if (!flags.ok) return flags;
    const required = [
      '--team', '--task', '--expected-revision', '--claim-token', '--generation', '--worktree',
    ];
    if (flags.value.size !== required.length || required.some((key) => !flags.value.has(key))) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'Invalid or missing flags for team deliver'));
    }
    const expectedRevision = Number(flags.value.get('--expected-revision'));
    const generation = Number(flags.value.get('--generation'));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'expected-revision must be a non-negative integer'));
    }
    if (!Number.isSafeInteger(generation) || generation < 1) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'generation must be a positive integer'));
    }
    return ok({
      kind: 'deliver',
      teamId: flags.value.get('--team')!,
      taskId: flags.value.get('--task')!,
      expectedRevision,
      claimToken: flags.value.get('--claim-token')!,
      generation,
      worktreePath: flags.value.get('--worktree')!,
    });
  }
  if (subcommand === 'wait') {
    return parseTeamWaitCommand(argv.slice(1));
  }
  if (subcommand === 'resume') {
    return parseTeamResumeCommand(argv.slice(1));
  }
  if (subcommand === 'tick') {
    const flags = parseStrictFlags(argv.slice(1));
    if (!flags.ok) return flags;
    if (!flags.value.has('--team')) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'team tick requires --team'));
    }
    const workerMode = flags.value.get('--worker-mode') ?? 'headless';
    if (workerMode !== 'interactive' && workerMode !== 'headless') {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'worker-mode must be interactive or headless'));
    }
    let maxParallel: number | undefined;
    if (flags.value.has('--max-parallel')) {
      const parsedMax = parseMaxParallelFlag(flags.value.get('--max-parallel')!);
      if (!parsedMax.ok) return parsedMax;
      maxParallel = parsedMax.value;
    }
    return ok({
      kind: 'tick',
      teamId: flags.value.get('--team')!,
      workerMode,
      maxParallel,
    });
  }
  if (subcommand === 'api') {
    return parseTeamApiCommand(argv.slice(1));
  }
  if (subcommand === 'panes') {
    return parseTeamPanesCommand(argv.slice(1));
  }
  if (subcommand === 'capture') {
    return parseTeamCaptureCommand(argv.slice(1));
  }
  if (subcommand === 'view') {
    return parseTeamViewCommand(argv.slice(1));
  }
  if (subcommand === 'worker') {
    return parseTeamWorkerRunCommand(argv.slice(1));
  }
  return err(runtimeError('E_VALIDATOR_REJECTED', 'Unknown team command'));
}

function parseTeamApiCommand(argv: readonly string[]): Result<ParsedTeamCommand, RuntimeError> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return err(runtimeError(
      'E_VALIDATOR_REJECTED',
      `team api requires <op> --input JSON [--json]. P0 ops: ${TEAM_API_OPERATIONS_P0.join(', ')}`,
    ));
  }
  const operation = argv[0];
  if (operation.startsWith('--')) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'team api requires <op> before flags'));
  }
  let inputJson: string | undefined;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--input') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return err(runtimeError('E_VALIDATOR_REJECTED', 'team api --input requires a JSON value'));
      }
      inputJson = value;
      index += 1;
      continue;
    }
    return err(runtimeError('E_VALIDATOR_REJECTED', `Unknown team api flag: ${token}`));
  }
  if (inputJson === undefined) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'team api requires --input JSON'));
  }
  return ok({ kind: 'api', operation, inputJson, json });
}

/**
 * 設計概念映射：OMC `omc team resume` / OMX `omx team resume`。
 * `--json` 為布林旗標，不可走 parseStrictFlags 的 name/value 成對解析。
 */
function parseTeamResumeCommand(argv: readonly string[]): Result<ParsedTeamCommand, RuntimeError> {
  let teamId: string | undefined;
  let expectedRevision: number | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') {
      if (json) {
        return err(runtimeError('E_VALIDATOR_REJECTED', 'duplicate option --json'));
      }
      json = true;
      continue;
    }
    if (token === '--team' || token === '--expected-revision') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return err(runtimeError('E_VALIDATOR_REJECTED', `team resume ${token} requires a value`));
      }
      index += 1;
      if (token === '--team') {
        if (teamId !== undefined) {
          return err(runtimeError('E_VALIDATOR_REJECTED', 'duplicate option --team'));
        }
        teamId = value;
        continue;
      }
      if (expectedRevision !== undefined) {
        return err(runtimeError('E_VALIDATOR_REJECTED', 'duplicate option --expected-revision'));
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        return err(runtimeError('E_VALIDATOR_REJECTED', 'expected-revision must be a non-negative integer'));
      }
      expectedRevision = parsed;
      continue;
    }
    return err(runtimeError('E_VALIDATOR_REJECTED', `Unknown team resume flag: ${token}`));
  }
  if (teamId === undefined || expectedRevision === undefined) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'team resume requires --team and --expected-revision'));
  }
  return ok({ kind: 'resume', teamId, expectedRevision, json });
}

/**
 * 設計概念映射：OMC `omc team wait [--timeout-ms] [--json]`。
 * `--json` 為布林旗標，不可走 parseStrictFlags 的 name/value 成對解析。
 */
function parseTeamWaitCommand(argv: readonly string[]): Result<ParsedTeamCommand, RuntimeError> {
  let teamId: string | undefined;
  let timeoutMs: number | undefined;
  let pollIntervalMs: number | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') {
      if (json) {
        return err(runtimeError('E_VALIDATOR_REJECTED', 'duplicate option --json'));
      }
      json = true;
      continue;
    }
    if (token === '--team' || token === '--timeout-ms' || token === '--poll-interval-ms') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return err(runtimeError('E_VALIDATOR_REJECTED', `team wait ${token} requires a value`));
      }
      index += 1;
      if (token === '--team') {
        if (teamId !== undefined) {
          return err(runtimeError('E_VALIDATOR_REJECTED', 'duplicate option --team'));
        }
        teamId = value;
        continue;
      }
      const parsed = Number(value);
      if (token === '--timeout-ms') {
        if (timeoutMs !== undefined) {
          return err(runtimeError('E_VALIDATOR_REJECTED', 'duplicate option --timeout-ms'));
        }
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          return err(runtimeError('E_VALIDATOR_REJECTED', 'timeout-ms must be a positive integer'));
        }
        timeoutMs = parsed;
        continue;
      }
      if (pollIntervalMs !== undefined) {
        return err(runtimeError('E_VALIDATOR_REJECTED', 'duplicate option --poll-interval-ms'));
      }
      if (!Number.isSafeInteger(parsed)
        || parsed < HUD_WATCH_INTERVAL_MS_MIN
        || parsed > HUD_WATCH_INTERVAL_MS_MAX) {
        return err(runtimeError(
          'E_VALIDATOR_REJECTED',
          `poll-interval-ms must be between ${HUD_WATCH_INTERVAL_MS_MIN} and ${HUD_WATCH_INTERVAL_MS_MAX}`,
        ));
      }
      pollIntervalMs = parsed;
      continue;
    }
    return err(runtimeError('E_VALIDATOR_REJECTED', `Unknown team wait flag: ${token}`));
  }
  if (teamId === undefined) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'team wait requires --team'));
  }
  return ok({
    kind: 'wait',
    teamId,
    json,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  });
}

function parseTeamPanesCommand(argv: readonly string[]): Result<ParsedTeamCommand, RuntimeError> {
  const flags = parseStrictFlags(argv);
  if (!flags.ok) return flags;
  if (flags.value.size !== 1 || !flags.value.has('--team')) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'team panes requires --team'));
  }
  return ok({ kind: 'panes', teamId: flags.value.get('--team')! });
}

function parseTeamCaptureCommand(argv: readonly string[]): Result<ParsedTeamCommand, RuntimeError> {
  const flags = parseStrictFlags(argv);
  if (!flags.ok) return flags;
  if (!flags.value.has('--team') || !flags.value.has('--task')) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'team capture requires --team and --task'));
  }
  const allowed = new Set(['--team', '--task', '--lines']);
  for (const key of flags.value.keys()) {
    if (!allowed.has(key)) {
      return err(runtimeError('E_VALIDATOR_REJECTED', `Unknown team capture flag: ${key}`));
    }
  }
  let lines = DEFAULT_CAPTURE_LINES;
  if (flags.value.has('--lines')) {
    const parsed = parseCaptureLineCount(flags.value.get('--lines')!);
    if (!parsed.ok) return parsed;
    lines = parsed.value;
  }
  return ok({
    kind: 'capture',
    teamId: flags.value.get('--team')!,
    taskId: flags.value.get('--task')!,
    lines,
  });
}

/**
 * 設計概念映射：OMG `team view --print`；OMA 僅支援 `--print-argv`，永不 attach。
 */
function parseTeamViewCommand(argv: readonly string[]): Result<ParsedTeamCommand, RuntimeError> {
  const printCount = argv.filter((token) => token === '--print-argv').length;
  if (printCount !== 1) {
    return err(runtimeError(
      'E_VALIDATOR_REJECTED',
      'team view requires --print-argv (read-only; never attaches)',
    ));
  }
  const flags = parseStrictFlags(argv.filter((token) => token !== '--print-argv'));
  if (!flags.ok) return flags;
  if (!flags.value.has('--team')) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'team view requires --team'));
  }
  const allowed = new Set(['--team', '--task']);
  for (const key of flags.value.keys()) {
    if (!allowed.has(key)) {
      return err(runtimeError('E_VALIDATOR_REJECTED', `Unknown team view flag: ${key}`));
    }
  }
  const taskId = flags.value.get('--task');
  return ok({
    kind: 'view',
    teamId: flags.value.get('--team')!,
    ...(taskId === undefined ? {} : { taskId }),
    printArgv: true,
  });
}

/**
 * 設計概念映射：OMX `$worker` / OMG `omg worker own` 的 CLI 進入點。
 * 協定階段由 `runWorkerProtocolLoop` 決定，而非 prompt。
 */
function parseTeamWorkerRunCommand(argv: readonly string[]): Result<ParsedTeamCommand, RuntimeError> {
  if (argv[0] !== 'run') {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'team worker requires run'));
  }
  const flags = parseStrictFlags(argv.slice(1));
  if (!flags.ok) return flags;
  const required = ['--team', '--task', '--claim-token', '--generation'];
  if (flags.value.size !== required.length || required.some((key) => !flags.value.has(key))) {
    return err(runtimeError(
      'E_VALIDATOR_REJECTED',
      'team worker run requires --team, --task, --claim-token, and --generation',
    ));
  }
  const generation = Number(flags.value.get('--generation'));
  if (!Number.isSafeInteger(generation) || generation < 1) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'generation must be a positive integer'));
  }
  return ok({
    kind: 'worker-run',
    teamId: flags.value.get('--team')!,
    taskId: flags.value.get('--task')!,
    claimToken: flags.value.get('--claim-token')!,
    generation,
  });
}

function isLiveness(value: string): value is 'alive' | 'dead' | 'unknown' {
  return value === 'alive' || value === 'dead' || value === 'unknown';
}

export interface TeamCommandOptions {
  context: RuntimeContext;
  storeRoot?: string;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  /**
   * 測試注入點；production 使用 defaultOrchestrator。
   * 設計概念映射：CLI 不內嵌編排細節，委派 TeamOrchestrator。
   */
  orchestratorFactory?: (context: RuntimeContext) => TeamOrchestrator;
  /** CLI composition supplies evidence-bearing profiles; Team owns routing. */
  providerProfileFactory?: TeamOrchestratorOptions['providerProfileFactory'];
  /**
   * 測試注入：攔截 tmux argv。production 走 spawnSync('tmux', argv)。
   * 設計概念映射：OMG operator adapter；observe 路徑不得 send-keys。
   */
  tmuxSpawn?: TmuxSpawnFn;
  /**
   * 測試注入：wait 的有界輪詢時鐘 / sleep / AbortSignal。
   * production 以 SIGINT 轉 AbortSignal，不得留下 timer 或 listener。
   */
  waitRuntime?: Pick<TeamWaitOptionsV1, 'sleep' | 'nowMs' | 'signal' | 'maxIterations'> & {
    attachAbort?: (abort: () => void) => () => void;
  };
}

function defaultOrchestrator(
  context: RuntimeContext,
  providerProfileFactory: TeamOrchestratorOptions['providerProfileFactory'],
): TeamOrchestrator {
  const managedRoot = path.join(context.stateRoot, 'managed-worktrees');
  // 生產預設 worker-bootstrap（進入 oma team worker run，不再裸 spawn agy）
  const bootstrapEntry = path.resolve(__dirname, 'worker-bootstrap.js');
  return new TeamOrchestrator({
    stateRoot: context.stateRoot,
    workspaceRoot: context.workspaceRoot,
    repoKey: context.repoKey,
    workspaceKey: context.workspaceKey,
    managedWorktreesRoot: managedRoot,
    tokenFactory: context.tokenFactory,
    workerHoldEntryPath: bootstrapEntry,
    providerProfileFactory,
  });
}

/**
 * typed teamCommand surface：CLI 唯一呼叫點。
 */
export async function teamCommand(
  argv: readonly string[],
  options: Readonly<TeamCommandOptions>,
): Promise<number> {
  const stdout = options.stdout ?? ((value) => process.stdout.write(value));
  const stderr = options.stderr ?? ((value) => process.stderr.write(value));
  const parsed = parseTeamCommand(argv);
  if (!parsed.ok) {
    stderr(formatCliError(parsed.error.code, parsed.error.message));
    return 2;
  }
  const getOrchestrator = (): TeamOrchestrator => options.orchestratorFactory?.(options.context)
    ?? defaultOrchestrator(options.context, options.providerProfileFactory);
  if (parsed.value.kind === 'start') {
    const orchestrator = getOrchestrator();
    const resolvedParallel = resolveTeamStartMaxParallel({
      cliMaxParallel: parsed.value.maxParallel,
      manifestPath: parsed.value.manifestPath,
      repoRoot: options.context.workspaceRoot,
    });
    if (!resolvedParallel.ok) {
      stderr(formatCliError(resolvedParallel.error.code, resolvedParallel.error.message));
      return teamStartErrorExitCode(resolvedParallel.error.code);
    }
    orchestrator.setMaxParallelWorkers(resolvedParallel.value);
    const result = await orchestrator.startFromManifest(
      parsed.value.manifestPath,
      parsed.value.workerMode,
    );
    if (!result.ok) {
      stderr(formatCliError(result.error.code, result.error.message));
      return teamStartErrorExitCode(result.error.code);
    }
    // claimToken 僅單次回傳於 JSON；勿寫入 durable 日誌以外的儲存
    stdout(`${JSON.stringify({
      ok: true,
      kind: 'team-started',
      teamId: result.value.teamId,
      aggregateRevision: result.value.aggregateRevision,
      workers: result.value.workers.map((worker) => ({
        taskId: worker.taskId,
        generation: worker.generation,
        sessionName: worker.sessionName,
        paneId: worker.paneId,
        worktreePath: worker.worktreePath,
        branchName: worker.branchName,
        claimToken: worker.claimToken,
        markerPath: worker.markerPath,
      })),
    })}\n`);
    return 0;
  }

  if (parsed.value.kind === 'status') {
    const orchestrator = getOrchestrator();
    const result = await orchestrator.status(parsed.value.teamId);
    if (!result.ok) {
      stderr(formatCliError(result.error.code, result.error.message));
      return 1;
    }
    stdout(`${JSON.stringify({ ok: true, kind: 'team-status', ...result.value })}\n`);
    return 0;
  }

  if (parsed.value.kind === 'stop') {
    const result = await getOrchestrator().stop(parsed.value.teamId);
    if (!result.ok) {
      stderr(formatCliError(result.error.code, result.error.message));
      return 1;
    }
    stdout(`${JSON.stringify({ ok: true, kind: 'team-stopped', ...result.value })}\n`);
    return 0;
  }

  if (parsed.value.kind === 'supervise') {
    const result = await getOrchestrator().superviseOnce(parsed.value.teamId);
    if (!result.ok) {
      stderr(formatCliError(result.error.code, result.error.message));
      return 1;
    }
    stdout(`${JSON.stringify({ ok: true, kind: 'team-supervise-report', ...result.value })}\n`);
    return 0;
  }

  if (parsed.value.kind === 'reclaim') {
    const result = await getOrchestrator().reclaimTask(
      parsed.value.teamId,
      parsed.value.taskId,
      parsed.value.expectedRevision,
      parsed.value.pane,
      parsed.value.process,
    );
    if (!result.ok) {
      stderr(formatCliError(result.error.code, result.error.message));
      return result.error.code === 'E_RECLAIM_IDENTITY_UNPROVEN' || result.error.code === 'E_VALIDATOR_REJECTED'
        ? 2
        : 1;
    }
    stdout(`${JSON.stringify({ ok: true, kind: 'team-reclaimed', ...result.value })}\n`);
    return 0;
  }

  if (parsed.value.kind === 'deliver') {
    const result = await getOrchestrator().deliverTask({
      teamId: parsed.value.teamId,
      taskId: parsed.value.taskId,
      expectedRevision: parsed.value.expectedRevision,
      claimToken: parsed.value.claimToken,
      generation: parsed.value.generation,
      worktreePath: parsed.value.worktreePath,
    });
    if (!result.ok) {
      stderr(formatCliError(result.error.code, result.error.message));
      return 1;
    }
    stdout(`${JSON.stringify({ ok: true, kind: 'team-delivered', ...result.value })}\n`);
    return 0;
  }

  if (parsed.value.kind === 'wait') {
    return runTeamWaitCommand(parsed.value, options, stdout, stderr);
  }

  if (parsed.value.kind === 'resume') {
    return runTeamResumeCommand(parsed.value, options, stdout, stderr);
  }

  if (parsed.value.kind === 'tick') {
    const orch = getOrchestrator();
    if (parsed.value.maxParallel !== undefined) {
      orch.setMaxParallelWorkers(parsed.value.maxParallel);
    }
    const result = await orch.tick(parsed.value.teamId, parsed.value.workerMode);
    if (!result.ok) {
      stderr(formatCliError(result.error.code, result.error.message));
      return 1;
    }
    stdout(`${JSON.stringify({
      ok: true,
      kind: 'team-tick',
      teamId: result.value.teamId,
      aggregateRevision: result.value.aggregateRevision,
      started: result.value.started.map((worker) => ({
        taskId: worker.taskId,
        generation: worker.generation,
        sessionName: worker.sessionName,
        paneId: worker.paneId,
        worktreePath: worker.worktreePath,
        claimToken: worker.claimToken,
      })),
    })}\n`);
    return 0;
  }

  if (parsed.value.kind === 'api') {
    return runTeamApiCommand(parsed.value, options, stdout, stderr);
  }

  if (parsed.value.kind === 'panes' || parsed.value.kind === 'capture' || parsed.value.kind === 'view') {
    return runTeamObserveCommand(parsed.value, options, stdout, stderr);
  }

  if (parsed.value.kind === 'worker-run') {
    return runTeamWorkerCommand(parsed.value, options, stdout, stderr);
  }

  let evidence: RecoveryForkSelectionEvidenceV1;
  try {
    evidence = JSON.parse(fs.readFileSync(parsed.value.evidencePath, 'utf8')) as RecoveryForkSelectionEvidenceV1;
  } catch (error) {
    stderr(formatCliError(
      'E_CORRUPT_STATE',
      `cannot read recovery evidence: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return 1;
  }

  const storeRoot = options.storeRoot ?? options.context.stateRoot;
  const store = new StateStore<RecoveryTaskAggregateV1>(storeRoot);
  const key = `recovery/${parsed.value.teamId}/${evidence.taskId}`;
  // production CLI 往往未注入 actor；從 durable recovery aggregate 還原 canonical leader。
  // 若 caller 已明確注入 actor（例如 worker 負面測試），則尊重既有 actor。
  const context = options.context.actor === undefined
    ? attachLeaderActorFromRecovery(options.context, store, key)
    : ok(options.context);
  if (!context.ok) {
    stderr(formatCliError(context.error.code, context.error.message));
    return 1;
  }
  const resolver = new RecoveryForkResolver(store, key);
  const result = await resolver.resolve({
    forkId: parsed.value.forkId,
    winnerGeneration: parsed.value.winnerGeneration,
    expectedRevision: parsed.value.expectedRevision,
    evidence,
  }, context.value);

  if (result.kind === 'Rejected') {
    stderr(formatCliError(result.error.code, result.error.message));
    return 1;
  }
  // issuedClaimToken 僅 Selected 單次回傳；durable 狀態只存 digest
  stdout(JSON.stringify({
    ok: true,
    kind: result.kind,
    revision: result.revision,
    forkId: parsed.value.forkId,
    selectedGeneration: result.resolution.selectedGeneration,
    freshClaimTokenDigest: result.resolution.freshClaimTokenDigest,
    ...(result.kind === 'Selected' && result.issuedClaimToken
      ? { issuedClaimToken: result.issuedClaimToken }
      : {}),
  }) + '\n');
  return 0;
}

/**
 * 設計概念映射：leader-only recovery-fork。
 * 不得從 aggregate「偽造」leader；必須以 caller cwd worktree 證明與 canonical leader 一致後才附 actor。
 */
export function attachLeaderActorFromRecovery(
  base: Readonly<RuntimeContext>,
  store: StateStore<RecoveryTaskAggregateV1>,
  key: string,
): Result<RuntimeContext, RuntimeError> {
  const snapshot = store.read(key);
  if (!snapshot.ok) return snapshot;
  const aggregate = snapshot.value.value;

  let callerWorktree;
  try {
    callerWorktree = resolveGitWorktreeIdentity(base.workspaceRoot);
  } catch (error) {
    return err(runtimeError(
      'E_TEAM_LEADER_REQUIRED',
      'Caller worktree identity cannot be proven for recovery-fork resolution',
      { cause: error instanceof Error ? error.message : String(error) },
    ));
  }

  // 以 durable leader worktree 與 caller 真實 git identity 交叉證明，而非信任任意 state-root reader。
  if (
    callerWorktree.canonicalRealpath !== aggregate.leaderWorktree.canonicalRealpath
    || callerWorktree.repoKey !== aggregate.leaderWorktree.repoKey
    || callerWorktree.gitCommonDir !== aggregate.leaderWorktree.gitCommonDir
    || callerWorktree.workspaceKey !== aggregate.leaderWorktree.workspaceKey
    || aggregate.repoKey !== callerWorktree.repoKey
  ) {
    return err(runtimeError(
      'E_TEAM_LEADER_REQUIRED',
      'Caller is not the canonical Team leader worktree for this recovery fork',
      {
        caller: callerWorktree,
        leader: aggregate.leaderWorktree,
      },
    ));
  }

  const actor: TeamActorIdentityV1 = {
    kind: 'leader',
    teamId: aggregate.teamId,
    repoKey: aggregate.repoKey,
    workspaceKey: aggregate.leaderWorkspaceKey,
    ownerNonce: aggregate.ownerNonce,
    worktree: aggregate.leaderWorktree,
  };
  return ok({
    ...base,
    repoKey: aggregate.repoKey,
    workspaceKey: aggregate.leaderWorkspaceKey,
    actor,
    tokenFactory: base.tokenFactory,
  });
}

const MAX_PARALLEL_FLAG_MESSAGE = 'max-parallel must be a positive integer';

/** 與 tick 同一驗證：Number.isSafeInteger 且 >= 1。 */
function parseMaxParallelFlag(raw: string): Result<number, RuntimeError> {
  const maxParallel = Number(raw);
  if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) {
    return err(runtimeError('E_VALIDATOR_REJECTED', MAX_PARALLEL_FLAG_MESSAGE));
  }
  return ok(maxParallel);
}

/**
 * 設計概念映射：start 平行度優先序 CLI flag > manifest.max_parallel > 1
 * （OMC team --count / OMX team N / OMG team --workers）。
 */
function resolveTeamStartMaxParallel(input: {
  cliMaxParallel: number | undefined;
  manifestPath: string;
  repoRoot: string;
}): Result<number, RuntimeError> {
  if (input.cliMaxParallel !== undefined) return ok(input.cliMaxParallel);
  const loaded = readTeamManifest(input.manifestPath, input.repoRoot);
  if (!loaded.ok) return loaded;
  return ok(loaded.value.max_parallel ?? 1);
}

function teamStartErrorExitCode(code: string): number {
  return code === 'E_VALIDATOR_REJECTED' || code === 'E_MANIFEST_INVALID' ? 2 : 1;
}

function parseStrictFlags(argv: readonly string[]): Result<Map<string, string>, RuntimeError> {
  if (argv.length % 2 !== 0) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'Every team flag requires one value'));
  }
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--') || value === undefined || value.startsWith('--') || flags.has(key)) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'Team flags must be unique --name value pairs'));
    }
    flags.set(key, value);
  }
  return ok(flags);
}

function defaultWaitSigintAttach(abort: () => void): () => void {
  const handler = () => abort();
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGINT', handler);
  };
}

async function runTeamResumeCommand(
  parsed: Extract<ParsedTeamCommand, { kind: 'resume' }>,
  options: Readonly<TeamCommandOptions>,
  stdout: (value: string) => void,
  stderr: (value: string) => void,
): Promise<number> {
  const orchestrator = options.orchestratorFactory?.(options.context)
    ?? defaultOrchestrator(options.context, options.providerProfileFactory);
  const result = await orchestrator.resume(parsed.teamId, parsed.expectedRevision);
  if (!result.ok) {
    stderr(formatCliError(result.error.code, result.error.message));
    return result.error.code === 'E_VALIDATOR_REJECTED' ? 2 : 1;
  }
  stdout(`${JSON.stringify({
    ok: true,
    kind: 'team-resumed',
    teamId: result.value.teamId,
    revision: result.value.revision,
    supervisorGeneration: result.value.supervisorGeneration,
    adopted: result.value.adopted,
    fenced: result.value.fenced,
    reclaimable: result.value.reclaimable,
    leaderContextPath: result.value.leaderContextPath,
    leaderContextBytes: result.value.leaderContextBytes,
    leaderContextTruncated: result.value.leaderContextTruncated,
  })}\n`);
  return 0;
}

async function runTeamWaitCommand(
  parsed: Extract<ParsedTeamCommand, { kind: 'wait' }>,
  options: Readonly<TeamCommandOptions>,
  stdout: (value: string) => void,
  stderr: (value: string) => void,
): Promise<number> {
  const orchestrator = options.orchestratorFactory?.(options.context)
    ?? defaultOrchestrator(options.context, options.providerProfileFactory);
  const controller = new AbortController();
  const signal = options.waitRuntime?.signal ?? controller.signal;
  const detach = options.waitRuntime?.signal !== undefined
    ? () => undefined
    : (options.waitRuntime?.attachAbort ?? defaultWaitSigintAttach)(() => controller.abort());
  try {
    const result = await orchestrator.waitForConvergence(parsed.teamId, {
      signal,
      ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
      ...(parsed.pollIntervalMs === undefined ? {} : { pollIntervalMs: parsed.pollIntervalMs }),
      ...(options.waitRuntime?.sleep === undefined ? {} : { sleep: options.waitRuntime.sleep }),
      ...(options.waitRuntime?.nowMs === undefined ? {} : { nowMs: options.waitRuntime.nowMs }),
      ...(options.waitRuntime?.maxIterations === undefined
        ? {}
        : { maxIterations: options.waitRuntime.maxIterations }),
    });
    if (!result.ok) {
      stderr(formatCliError(result.error.code, result.error.message));
      return result.error.code === 'E_VALIDATOR_REJECTED' ? 2 : 1;
    }
    stdout(`${JSON.stringify({
      ok: result.value.stopped_by === 'converged',
      kind: 'team-wait',
      teamId: result.value.teamId,
      revision: result.value.revision,
      stopped_by: result.value.stopped_by,
      iterations: result.value.iterations,
      elapsed_ms: result.value.elapsed_ms,
      tasks: result.value.tasks,
    })}\n`);
    if (result.value.stopped_by === 'converged') return 0;
    if (result.value.stopped_by === 'aborted') return 130;
    return 1;
  } finally {
    detach();
  }
}

function observeErrorExit(code: string): number {
  return code === 'E_VALIDATOR_REJECTED' ? 2 : 1;
}

function runTeamObserveCommand(
  parsed: Extract<ParsedTeamCommand, { kind: 'panes' | 'capture' | 'view' }>,
  options: Readonly<TeamCommandOptions>,
  stdout: (value: string) => void,
  stderr: (value: string) => void,
): number {
  const store = new TeamStateStore(
    options.context.stateRoot,
    options.context.repoKey,
    options.context.workspaceKey,
    parsed.teamId,
  );
  const snapshot = store.read();
  if (!snapshot.ok) {
    stderr(`${snapshot.error.code}: ${snapshot.error.message}\n`);
    return observeErrorExit(snapshot.error.code);
  }
  const aggregate = snapshot.value.value;

  if (parsed.kind === 'view') {
    // `--print-argv` 零 spawn：只從 durable heartbeat 組 argv，不碰 tmux。
    const target = resolveObserveTarget(aggregate, parsed.taskId);
    if (!target.ok) {
      stderr(`${target.error.code}: ${target.error.message}\n`);
      return observeErrorExit(target.error.code);
    }
    const argv = printAttachArgv({
      sessionName: target.value.sessionName,
      paneId: target.value.paneId,
    });
    if (!argv.ok) {
      stderr(`${argv.error.code}: ${argv.error.message}\n`);
      return observeErrorExit(argv.error.code);
    }
    stdout(`${JSON.stringify({
      ok: true,
      kind: 'team-view-argv',
      teamId: parsed.teamId,
      taskId: target.value.taskId,
      argv: argv.value,
    })}\n`);
    return 0;
  }

  const spawn = options.tmuxSpawn;
  if (parsed.kind === 'panes') {
    const listed = listOwnedPanes({
      teamId: parsed.teamId,
      aggregate,
      ...(spawn === undefined ? {} : { spawn }),
    });
    if (!listed.ok) {
      stderr(`${listed.error.code}: ${listed.error.message}\n`);
      return observeErrorExit(listed.error.code);
    }
    stdout(`${JSON.stringify({
      ok: true,
      kind: 'team-panes',
      teamId: parsed.teamId,
      panes: listed.value,
    })}\n`);
    return 0;
  }

  const target = resolveObserveTarget(aggregate, parsed.taskId);
  if (!target.ok) {
    stderr(`${target.error.code}: ${target.error.message}\n`);
    return observeErrorExit(target.error.code);
  }
  const captured = capturePane({
    pane: target.value.paneId,
    sessionName: target.value.sessionName,
    expectedOwnerNonce: aggregate.ownerNonce,
    lines: parsed.lines,
    ...(spawn === undefined ? {} : { spawn }),
  });
  if (!captured.ok) {
    stderr(`${captured.error.code}: ${captured.error.message}\n`);
    return observeErrorExit(captured.error.code);
  }
  stdout(`${JSON.stringify({
    ok: true,
    kind: 'team-capture',
    teamId: parsed.teamId,
    taskId: target.value.taskId,
    paneId: captured.value.paneId,
    sessionName: captured.value.sessionName,
    lines: captured.value.lines,
    text: captured.value.text,
  })}\n`);
  return 0;
}

function resolveObserveTarget(
  aggregate: { teamId: string; heartbeats: Readonly<Record<string, SupervisorHeartbeatV1>> },
  taskId: string | undefined,
): Result<{ taskId: string; sessionName: string; paneId: string }, RuntimeError> {
  if (taskId !== undefined) {
    const heartbeat = aggregate.heartbeats[taskId];
    if (heartbeat === undefined) {
      return err(runtimeError('E_NOT_FOUND', 'Team task pane does not exist', { taskId }));
    }
    return ok({
      taskId,
      sessionName: sessionNameFromHeartbeat(aggregate.teamId, heartbeat),
      paneId: heartbeat.paneId,
    });
  }
  const heartbeats = Object.values(aggregate.heartbeats);
  const heartbeat = heartbeats[0];
  if (heartbeat === undefined) {
    return err(runtimeError('E_NOT_FOUND', 'Team has no owned panes to view'));
  }
  if (heartbeats.length !== 1) {
    return err(runtimeError(
      'E_VALIDATOR_REJECTED',
      'team view requires --task when the team has multiple panes',
    ));
  }
  return ok({
    taskId: heartbeat.workerId,
    sessionName: sessionNameFromHeartbeat(aggregate.teamId, heartbeat),
    paneId: heartbeat.paneId,
  });
}

/**
 * 設計概念映射：`oma team worker run` 是協定 loop 的唯一 production host。
 * claim-token / generation 不符時沿用 E_REVISION_CONFLICT，且不得寫入狀態。
 */
async function runTeamWorkerCommand(
  parsed: Extract<ParsedTeamCommand, { kind: 'worker-run' }>,
  options: Readonly<TeamCommandOptions>,
  stdout: (value: string) => void,
  stderr: (value: string) => void,
): Promise<number> {
  const store = new TeamStateStore(
    options.context.stateRoot,
    options.context.repoKey,
    options.context.workspaceKey,
    parsed.teamId,
  );
  const worktreePath = process.env.OMA_WORKSPACE_PATH?.trim() || options.context.workspaceRoot;
  const providerEnv = process.env.OMA_WORKER_PROVIDER;
  const provider = providerEnv === 'tmux_agy' || providerEnv === 'agy_headless'
    ? providerEnv
    : undefined;
  const receipt = process.env.OMA_ROUTE_RECEIPT_DIGEST;
  const result = await runTeamWorker({
    store,
    teamId: parsed.teamId,
    taskId: parsed.taskId,
    claimToken: parsed.claimToken,
    generation: parsed.generation,
    worktreePath,
    managedWorktreesRoot: path.join(options.context.stateRoot, 'managed-worktrees'),
    ...(options.context.clock === undefined ? {} : { nowMs: () => options.context.clock!.now() }),
    ...(provider === undefined ? {} : { provider }),
    ...(typeof receipt === 'string' && /^[a-f0-9]{64}$/u.test(receipt)
      ? { providerReceiptHash: receipt }
      : {}),
  });
  if (!result.ok) {
    stderr(formatCliError(result.error.code, result.error.message));
    return result.error.code === 'E_VALIDATOR_REJECTED' ? 2 : 1;
  }
  stdout(`${JSON.stringify({
    ok: true,
    kind: 'team-worker-run',
    teamId: parsed.teamId,
    taskId: parsed.taskId,
    generation: parsed.generation,
    outcome: result.value.outcome,
    deliveryDigest: result.value.deliveryDigest,
    integrationReceiptHash: result.value.integrationReceiptHash,
    mailboxCursor: result.value.mailboxCursor,
    commandCount: result.value.commandCount,
  })}\n`);
  return 0;
}

async function runTeamApiCommand(
  parsed: Extract<ParsedTeamCommand, { kind: 'api' }>,
  options: Readonly<TeamCommandOptions>,
  stdout: (value: string) => void,
  stderr: (value: string) => void,
): Promise<number> {
  let input: Record<string, unknown>;
  try {
    const parsedJson = JSON.parse(parsed.inputJson) as unknown;
    if (parsedJson === null || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
      stderr(formatCliError('E_VALIDATOR_REJECTED', 'team api --input must be a JSON object'));
      return 2;
    }
    input = parsedJson as Record<string, unknown>;
  } catch (error) {
    stderr(formatCliError(
      'E_VALIDATOR_REJECTED',
      `team api --input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return 2;
  }

  const teamId = typeof input.team_name === 'string' && input.team_name.trim() !== ''
    ? input.team_name.trim()
    : typeof input.team_id === 'string' && input.team_id.trim() !== ''
      ? input.team_id.trim()
      : '';
  if (teamId === '') {
    const envelope = wrapTeamApiCliEnvelope({
      ok: false,
      operation: isTeamApiOperationP0(parsed.operation) ? parsed.operation : 'unknown',
      error: { code: 'E_TEAM_API_INVALID_INPUT', message: 'team_name (or team_id) is required in --input' },
    });
    stdout(`${JSON.stringify(envelope)}\n`);
    return 2;
  }
  if (!isCanonicalTeamIdentifier(teamId)) {
    const envelope = wrapTeamApiCliEnvelope({
      ok: false,
      operation: isTeamApiOperationP0(parsed.operation) ? parsed.operation : 'unknown',
      error: {
        code: 'E_TEAM_API_INVALID_INPUT',
        message: 'team_name must be a canonical team identifier (no path separators or traversal)',
        details: { team_name: teamId },
      },
    });
    stdout(`${JSON.stringify(envelope)}\n`);
    return 2;
  }

  const store = new TeamStateStore(
    options.context.stateRoot,
    options.context.repoKey,
    options.context.workspaceKey,
    teamId,
  );

  const result = await executeTeamApiOperation(parsed.operation, input, {
    store,
    tokenFactory: options.context.tokenFactory,
  });
  const envelope = wrapTeamApiCliEnvelope(result);
  stdout(`${JSON.stringify(envelope)}\n`);
  if (!result.ok) {
    if (result.error.code === 'E_TEAM_API_UNKNOWN' || result.error.code === 'E_TEAM_API_INVALID_INPUT') {
      return 2;
    }
    return 1;
  }
  return 0;
}
