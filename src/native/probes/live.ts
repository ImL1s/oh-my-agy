import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { redactDiagnostic } from '../../runtime/redaction';
import { CapabilityObservationV1 } from '../capability-profile';
import { HOST_CAPABILITY_POLICY_REGISTRY_V1 } from '../capability-profile';
import { BoundedProbeRunnerV1, LiveProbeContextV1, ProbeResultV1 } from './types';
import { runBoundedProbe } from './runner';
import { probeStructuredInitOutput } from './structured-init';

const MANAGED_KEYS = ['OMA_SESSION_ID', 'OMA_LAUNCH_NONCE', 'OMA_INVOCATION_GENERATION', 'OMA_CONVERSATION_ID'] as const;
export const LIVE_MODEL_CANARY_PRINT_TIMEOUT_MS = 45_000;
export const LIVE_MODEL_CANARY_OUTER_TIMEOUT_MS = 60_000;

export const LIVE_CAPABILITY_PROBE_PLAN_V1 = Object.freeze(
  HOST_CAPABILITY_POLICY_REGISTRY_V1
    .filter(({ sideEffect, sourceCeilings }) => sideEffect !== 'passive-cache-only' && sourceCeilings.live_probe !== undefined)
    .map(({ key, sideEffect, limits }) => Object.freeze({
      capability: key,
      sideEffect,
      timeoutMs: limits.timeoutMs,
      maximumOutputBytes: limits.maximumOutputBytes,
      maximumProcesses: limits.maximumProcesses,
    })),
);

export interface LiveProbeRequestV1 {
  live: boolean;
  executable: string;
  argv: readonly string[];
  capability: string;
  expectedToken: string;
  outputContract?: 'exact_text' | 'agy_json';
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  context: LiveProbeContextV1;
  runner?: BoundedProbeRunnerV1;
}

export async function runExplicitLiveProbe(request: Readonly<LiveProbeRequestV1>): Promise<ProbeResultV1> {
  if (request.live !== true || request.context.mode !== 'live' || request.context.liveOptIn !== true) {
    throw new Error('E_LIVE_OPT_IN_REQUIRED: live probes require literal --live');
  }
  const policy = HOST_CAPABILITY_POLICY_REGISTRY_V1.find(({ key }) => key === request.capability);
  if (policy === undefined || policy.sourceCeilings.live_probe === undefined) {
    throw new Error(`E_LIVE_PROBE_UNREGISTERED: ${request.capability}`);
  }
  const timeoutMs = request.timeoutMs ?? policy.limits.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > policy.limits.timeoutMs) {
    throw new Error(`E_LIVE_PROBE_LIMIT: ${request.capability}`);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-live-'));
  fs.chmodSync(scratch, 0o700);
  const environment = { ...(request.environment ?? process.env) };
  for (const key of MANAGED_KEYS) delete environment[key];
  try {
    const outcome = await (request.runner ?? runBoundedProbe)({
      command: request.executable,
      argv: request.argv,
      cwd: scratch,
      environment,
      timeoutMs,
      maximumOutputBytes: policy.limits.maximumOutputBytes,
      maximumProcesses: policy.limits.maximumProcesses,
    });
    const exact = outcome.status === 0 && !outcome.timedOut && !outcome.outputOverflow
      && !outcome.processCountOverflow && outcome.error === undefined
      && outcome.stderr === '' && liveOutputMatches(
        outcome.stdout,
        request.expectedToken,
        request.outputContract ?? 'exact_text',
      );
    const detailCode = outcome.timedOut ? 'LIVE_TIMEOUT' : outcome.outputOverflow ? 'LIVE_OVERFLOW'
      : outcome.processCountOverflow ? 'LIVE_PROCESS_OVERFLOW'
        : outcome.error === 'E_PROBE_PROCESS_COUNT_UNAVAILABLE' ? 'LIVE_PROCESS_LIMIT_UNAVAILABLE'
          : exact ? 'LIVE_VERIFIED' : 'LIVE_MALFORMED';
    const observation: CapabilityObservationV1 = {
      capability: request.capability,
      source: 'live_probe',
      tier: 'verified',
      result: exact ? 'positive' : 'indeterminate',
      observedAt: request.context.evaluationTimestamp,
      identityDigest: request.context.identityDigest,
      detailCode,
      diagnostic: exact ? null : redactDiagnostic(`${outcome.stderr}\n${outcome.error ?? ''}`, 4096),
    };
    const structured = exact && request.outputContract === 'agy_json'
      ? probeStructuredInitOutput(outcome.stdout, request.context, new Set([request.capability]))
      : { observations: [], cacheable: exact, detailCode: 'STRUCTURED_INIT_NOT_APPLICABLE' };
    return {
      observations: [observation, ...structured.observations],
      cacheable: exact && structured.cacheable,
      detailCode,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * `native probe --live` v1 只執行有公開、可界定輸出的 headless canary。
 * 其餘具副作用 domain 必須留下 live_probe/indeterminate 證據，不能用 help
 * 宣稱已驗證，也不能因 executor 尚未公開而從 profile 消失。
 */
export function completeLiveCapabilityProbeCoverage(
  observations: readonly CapabilityObservationV1[],
  context: Readonly<LiveProbeContextV1>,
): CapabilityObservationV1[] {
  const covered = new Set(
    observations
      .filter(({ source }) => source === 'live_probe')
      .map(({ capability }) => capability),
  );
  const unavailable = LIVE_CAPABILITY_PROBE_PLAN_V1
    .filter(({ capability }) => !covered.has(capability))
    .map(({ capability, sideEffect }): CapabilityObservationV1 => ({
      capability,
      source: 'live_probe',
      tier: 'configured',
      result: 'indeterminate',
      observedAt: context.evaluationTimestamp,
      identityDigest: context.identityDigest,
      detailCode: `LIVE_${sideEffect.toUpperCase()}_PROBE_UNAVAILABLE`,
      diagnostic: null,
    }));
  return [...observations, ...unavailable];
}

function liveOutputMatches(
  stdout: string,
  expectedToken: string,
  contract: NonNullable<LiveProbeRequestV1['outputContract']>,
): boolean {
  if (contract === 'exact_text') return stdout.trim() === expectedToken;
  try {
    const value = JSON.parse(stdout) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.conversation_id === 'string'
      && record.conversation_id.trim() !== ''
      && typeof record.status === 'string'
      && !['ERROR', 'FAILED'].includes(record.status.toUpperCase())
      && typeof record.response === 'string'
      && record.response.trim() === expectedToken
      && (record.error === undefined || record.error === null || record.error === '');
  } catch (_) {
    return false;
  }
}
