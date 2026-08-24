/**
 * 設計概念映射：tmux worker 就緒階段，對齊 OMG `omg_cli/team/startup.py`
 * `StartupPhase`（pane_created → provider_spawned → provider_ready →
 * task_dispatched，單調不倒退）與 OMX/OMC worker-health 的 provider
 * basename 比對。無 phase 的舊 binding 視為 legacy（OMG
 * `wrapper_ready_legacy`），不得當成 provider-ready。
 */
import * as path from 'path';
import {
  WorkerAuthorityBindingV1,
  WorkerExecutionStateV1,
  WorkerReadinessPhaseV1,
} from './types';

export const WORKER_READINESS_PHASES_V1 = [
  'pane_created',
  'provider_spawned',
  'provider_ready',
  'task_dispatched',
] as const satisfies readonly WorkerReadinessPhaseV1[];

export const WORKER_READINESS_PHASE_RANK_V1: Readonly<Record<WorkerReadinessPhaseV1, number>> = {
  pane_created: 10,
  provider_spawned: 20,
  provider_ready: 30,
  task_dispatched: 40,
};

/** Darwin `comm` 欄位上限（MAXCOMLEN）；長 basename 可能被截斷。 */
const DARWIN_COMM_MAX = 16;

export function isWorkerReadinessPhaseV1(value: unknown): value is WorkerReadinessPhaseV1 {
  return value === 'pane_created'
    || value === 'provider_spawned'
    || value === 'provider_ready'
    || value === 'task_dispatched';
}

export type WorkerReadinessViewV1 =
  | { readonly kind: 'legacy' }
  | { readonly kind: 'phased'; readonly phase: WorkerReadinessPhaseV1 };

export function workerReadinessFromBinding(
  binding: Readonly<Pick<WorkerAuthorityBindingV1, 'readinessPhase'>>,
): WorkerReadinessViewV1 {
  if (!isWorkerReadinessPhaseV1(binding.readinessPhase)) return { kind: 'legacy' };
  return { kind: 'phased', phase: binding.readinessPhase };
}

export function advanceWorkerReadinessPhase(
  current: WorkerReadinessPhaseV1 | undefined,
  next: WorkerReadinessPhaseV1,
): WorkerReadinessPhaseV1 {
  if (current === undefined) return next;
  return WORKER_READINESS_PHASE_RANK_V1[next] < WORKER_READINESS_PHASE_RANK_V1[current]
    ? current
    : next;
}

/** 以亂序輸入驗證單調性：結果永遠是出現過的最高階 phase。 */
export function foldWorkerReadinessPhases(
  phases: readonly WorkerReadinessPhaseV1[],
): WorkerReadinessPhaseV1 | undefined {
  let current: WorkerReadinessPhaseV1 | undefined;
  for (const phase of phases) {
    current = advanceWorkerReadinessPhase(current, phase);
  }
  return current;
}

export function withMonotonicReadinessPhase(
  binding: WorkerAuthorityBindingV1,
  next: WorkerReadinessPhaseV1,
): WorkerAuthorityBindingV1 {
  const current = isWorkerReadinessPhaseV1(binding.readinessPhase)
    ? binding.readinessPhase
    : undefined;
  return {
    ...binding,
    readinessPhase: advanceWorkerReadinessPhase(current, next),
  };
}

/**
 * 將 worker 執行態映到就緒階段。僅在 binding 已有合法 phase 時由
 * `transitionWorkerAuthority` 單調推進；無 phase 的 legacy 保持省略。
 */
export function readinessPhaseForExecutionState(
  state: WorkerExecutionStateV1,
): WorkerReadinessPhaseV1 | undefined {
  switch (state) {
    case 'claimed':
      return 'pane_created';
    case 'launched':
      return 'provider_spawned';
    case 'running':
      return 'provider_ready';
    case 'verifying':
    case 'delivery_ready':
    case 'integration_requested':
    case 'terminal':
      return 'task_dispatched';
    default:
      return undefined;
  }
}

export function providerCommMatchesBasename(comm: string, expectedBasename: string): boolean {
  const actual = basenameToken(comm);
  const expected = basenameToken(expectedBasename);
  if (actual === '' || expected === '') return false;
  if (actual === expected) return true;
  return actual.length === DARWIN_COMM_MAX && expected.startsWith(actual);
}

/**
 * 生產 pane 主體是 `workerExecutablePath`（#45：`node` + `oma team worker run`），
 * 不是路由後的 `agy`。比對時兩者都算身分，避免 live worker 被誤判 orphan。
 * 設計概念映射：OMG process_stable / Codex PR94 P1。
 */
export function teamWorkerLivenessBasenames(
  workerExecutablePath: string,
  routeExecutablePath?: string,
): readonly string[] {
  const names: string[] = [];
  for (const raw of [workerExecutablePath, routeExecutablePath]) {
    const token = basenameToken(raw ?? '');
    if (token !== '' && !names.includes(token)) names.push(token);
  }
  return names;
}

export function providerCommMatchesAnyBasename(
  comm: string,
  expectedBasenames: readonly string[],
): boolean {
  return expectedBasenames.some((expected) => providerCommMatchesBasename(comm, expected));
}

function basenameToken(value: string): string {
  return path.basename(value.trim()).toLowerCase();
}
