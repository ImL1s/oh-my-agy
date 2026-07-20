import * as fs from 'fs';
import * as path from 'path';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { StateStore } from '../runtime/state-store';
import { Result, err, ok } from '../runtime/types';
import {
  RecoveryForkResolver,
  RecoveryForkSelectionEvidenceV1,
  RecoveryTaskAggregateV1,
} from './recovery-fork';
import { RuntimeContext, TeamActorIdentityV1 } from './types';
import { resolveGitWorktreeIdentity } from './worktree';
import { validateTeamManifest } from './manifest';

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
    };

/**
 * 設計概念映射：Lane B 只做 argv→typed API 轉接；
 * resolve-fork 語意與 CAS 判定完全交給 RecoveryForkResolver（Lane C）。
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
    const workerMode = flags.value.get('--worker-mode') ?? 'interactive';
    if (workerMode !== 'interactive' && workerMode !== 'headless') {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'worker-mode must be interactive or headless'));
    }
    return ok({
      kind: 'start',
      manifestPath: flags.value.get('--manifest')!,
      workerMode,
    });
  }
  return err(runtimeError('E_VALIDATOR_REJECTED', 'Unknown team command'));
}

export interface TeamCommandOptions {
  context: RuntimeContext;
  storeRoot?: string;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
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
    stderr(`${parsed.error.code}: ${parsed.error.message}\n`);
    return 2;
  }
  if (parsed.value.kind === 'start') {
    // CLI start 僅做 manifest 契約驗證；完整 tmux/worker 生命週期走 typed Team APIs + unit fixtures。
    if (!fs.existsSync(parsed.value.manifestPath)) {
      stderr(`E_MANIFEST_INVALID: manifest not found: ${parsed.value.manifestPath}\n`);
      return 1;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(parsed.value.manifestPath, 'utf8'));
    } catch (error) {
      stderr(`E_MANIFEST_INVALID: cannot parse manifest: ${
        error instanceof Error ? error.message : String(error)
      }\n`);
      return 1;
    }
    const validated = validateTeamManifest(raw, options.context.workspaceRoot);
    if (!validated.ok) {
      stderr(`${validated.error.code}: ${validated.error.message}\n`);
      return 1;
    }
    stdout(JSON.stringify({
      ok: true,
      kind: 'manifest-validated',
      teamId: validated.value.teamId,
      revision: validated.value.revision,
      taskCount: validated.value.tasks.length,
      workerMode: parsed.value.workerMode,
      note: 'tmux worker lifecycle is started via typed Team APIs, not this CLI stub',
    }) + '\n');
    return 0;
  }

  let evidence: RecoveryForkSelectionEvidenceV1;
  try {
    evidence = JSON.parse(fs.readFileSync(parsed.value.evidencePath, 'utf8')) as RecoveryForkSelectionEvidenceV1;
  } catch (error) {
    stderr(`E_CORRUPT_STATE: cannot read recovery evidence: ${
      error instanceof Error ? error.message : String(error)
    }\n`);
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
    stderr(`${context.error.code}: ${context.error.message}\n`);
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
    stderr(`${result.error.code}: ${result.error.message}\n`);
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
