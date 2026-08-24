/**
 * `oma doctor --fix`：只重跑已擁有的安全修復。
 * 設計概念映射：OMC/OMX doctor 補救路徑；OMA 僅 spawn/spawnSync + argv 陣列
 * 重跑 `setupCommand` 與 plugin readback，**永不**執行 git、不刪檔、不重試迴圈。
 */
import { spawnSync } from 'child_process';
import { agyPluginListArgs } from './transaction';
import { DoctorCheckStatus, DoctorReportV1 } from './doctor';

export const DOCTOR_FIX_SCHEMA = 'oma.doctor-fix/v1' as const;

export interface DoctorFixPlannedSpawnV1 {
  readonly host: 'agy';
  readonly args: readonly string[];
}

export interface DoctorFixPlanV1 {
  readonly schema: typeof DOCTOR_FIX_SCHEMA;
  readonly schemaVersion: 1;
  readonly mutatesGit: false;
  readonly plannedActions: readonly string[];
  readonly plannedSpawns: readonly DoctorFixPlannedSpawnV1[];
  readonly agyMissing: boolean;
  readonly message: string | null;
}

export interface DoctorFixSpawnResultV1 {
  readonly argv: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DoctorFixApplyResultV1 {
  readonly setupExitCode: number;
  readonly readback: DoctorFixSpawnResultV1 | null;
  readonly retried: false;
}

export interface DoctorCheckStatusChangeV1 {
  readonly id: string;
  readonly from: DoctorCheckStatus;
  readonly to: DoctorCheckStatus;
}

const GIT_EXECUTABLE = /(?:^|[\\/])git(?:\.exe)?$/i;

/** 任何 git 可執行檔或 argv 開頭為 git 都拒絕（`--fix` 雙重閘門之一）。 */
export function isGitSpawnArgv(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const command = argv[0] ?? '';
  if (command === 'git' || command === 'git.exe' || GIT_EXECUTABLE.test(command)) return true;
  return argv.slice(1).some((part) => part === 'git' || part === 'git.exe');
}

export function assertNoGitSpawn(argv: readonly string[]): void {
  if (isGitSpawnArgv(argv)) {
    throw new Error('oma doctor --fix refuses git spawns');
  }
}

export function buildDoctorFixPlan(input: {
  readonly agyCommand: string;
  readonly agyMissing: boolean;
}): DoctorFixPlanV1 {
  const plannedActions: string[] = [
    'Print this plan first (owned repairs only; never git, never delete files)',
    input.agyMissing
      ? 'Skip agy plugin install/readback (agy missing; no retry)'
      : 'Re-run oma setup once (slash host install + agy plugin install/enable)',
    input.agyMissing
      ? 'Re-run oma setup once for slash-capable hosts (agy fail-soft; no retry loop)'
      : 'Plugin readback via spawn argv: agy plugin list',
    'Re-run oma doctor and report before/after',
  ];
  const plannedSpawns: DoctorFixPlannedSpawnV1[] = [];
  let message: string | null = null;
  if (input.agyMissing) {
    message = `agy is not runnable (${input.agyCommand}); --fix will not retry agy plugin install. `
      + 'Install agy on PATH for managed hooks, or use slash-only: oma setup --host claude';
  } else {
    plannedSpawns.push({
      host: 'agy',
      args: [input.agyCommand, ...agyPluginListArgs()],
    });
  }
  return {
    schema: DOCTOR_FIX_SCHEMA,
    schemaVersion: 1,
    mutatesGit: false,
    plannedActions,
    plannedSpawns,
    agyMissing: input.agyMissing,
    message,
  };
}

export function doctorFixPlanToLines(plan: DoctorFixPlanV1): string[] {
  const lines = ['oma doctor --fix planned actions (never git):'];
  for (const action of plan.plannedActions) {
    lines.push(`  - ${action}`);
  }
  for (const spawned of plan.plannedSpawns) {
    assertNoGitSpawn(spawned.args);
    lines.push(`  spawn argv: ${spawned.args.join(' ')}`);
  }
  if (plan.message !== null) lines.push(plan.message);
  return lines;
}

export function doctorAgyMissing(report: DoctorReportV1): boolean {
  const check = report.checks.find((item) => item.id === 'agy_path');
  return check !== undefined && check.status !== 'pass';
}

export function doctorStatusDiff(
  before: DoctorReportV1,
  after: DoctorReportV1,
): readonly DoctorCheckStatusChangeV1[] {
  const afterById = new Map(after.checks.map((check) => [check.id, check]));
  const changed: DoctorCheckStatusChangeV1[] = [];
  for (const check of before.checks) {
    const next = afterById.get(check.id);
    if (next === undefined || next.status === check.status) continue;
    changed.push({ id: check.id, from: check.status, to: next.status });
  }
  for (const check of after.checks) {
    if (before.checks.some((item) => item.id === check.id)) continue;
    changed.push({ id: check.id, from: 'pass', to: check.status });
  }
  return changed;
}

export function doctorFixDiffToLines(
  changed: readonly DoctorCheckStatusChangeV1[],
): string[] {
  if (changed.length === 0) return ['Changed: none'];
  return ['Changed:', ...changed.map((item) => `  ${item.id}: ${item.from} → ${item.to}`)];
}

/**
 * 預設 plugin readback：spawnSync(agy, ['plugin', 'list'])。
 * 禁止 git；測試可注入 adapter 攔截 argv。
 */
export function spawnSyncAgyArgv(
  agyCommand: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): DoctorFixSpawnResultV1 {
  const fullArgv = [agyCommand, ...argv];
  assertNoGitSpawn(fullArgv);
  const result = spawnSync(agyCommand, [...argv], {
    encoding: 'utf8',
    timeout: 30_000,
    env,
  });
  return {
    argv: fullArgv,
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error?.message ?? ''),
  };
}

/**
 * 執行一次 owned setup +（agy 可用時）一次 plugin list readback。
 * 禁止迴圈重試；agy 缺失時略過 readback 並留下 plan.message。
 */
export async function applyOwnedDoctorFix(input: {
  readonly plan: DoctorFixPlanV1;
  readonly runSetup: (argv: readonly string[]) => Promise<number>;
  readonly pluginReadback: () => Promise<DoctorFixSpawnResultV1>;
}): Promise<DoctorFixApplyResultV1> {
  for (const spawned of input.plan.plannedSpawns) {
    assertNoGitSpawn(spawned.args);
  }
  const setupExitCode = await input.runSetup([]);
  if (input.plan.agyMissing) {
    return { setupExitCode, readback: null, retried: false };
  }
  const readback = await input.pluginReadback();
  assertNoGitSpawn(readback.argv);
  return { setupExitCode, readback, retried: false };
}

export function doctorFixResultToJsonValue(input: {
  readonly plan: DoctorFixPlanV1;
  readonly setupExitCode: number;
  readonly setupOutput: string;
  readonly before: DoctorReportV1;
  readonly after: DoctorReportV1;
  readonly changed: readonly DoctorCheckStatusChangeV1[];
  readonly retried: false;
}): Record<string, unknown> {
  return {
    schema: input.plan.schema,
    schemaVersion: input.plan.schemaVersion,
    mutatesGit: false,
    plannedActions: [...input.plan.plannedActions],
    plannedSpawns: input.plan.plannedSpawns.map((item) => ({
      host: item.host,
      args: [...item.args],
    })),
    agyMissing: input.plan.agyMissing,
    message: input.plan.message,
    setupExitCode: input.setupExitCode,
    setupOutput: input.setupOutput,
    retried: false,
    before: input.before,
    after: input.after,
    changed: input.changed.map((item) => ({
      id: item.id,
      from: item.from,
      to: item.to,
    })),
  };
}
