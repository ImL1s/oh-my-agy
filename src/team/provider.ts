import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { canonicalJson, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { WorkerProvider } from '../contracts/worker-envelope';
import { AGY_REQUIRED_HELP_FLAGS, AGY_WORKER_VERSION, validateAgy115Help } from './agy-argv';
import { NativeConversationReceiptV1 } from './types';

export const PROVIDER_EVIDENCE_MAX_AGE_MS = 300_000;

export interface AgyCanaryReceiptV1 {
  schemaVersion: 1;
  kind: 'headless_exit' | 'interactive_attach';
  argvHash: string;
  exitCode: number | null;
  attachable: boolean;
  orphanFree: boolean;
  observedAtMs: number;
}

export interface AgyCliProbeV1 {
  schemaVersion: 1;
  installed: boolean;
  executableRealpath: string;
  executableSha256: string;
  version: string;
  versionOutputHash: string;
  helpOutputHash: string;
  requiredFlags: readonly string[];
  observedAtMs: number;
  headlessCanary?: AgyCanaryReceiptV1;
  interactiveCanary?: AgyCanaryReceiptV1;
}

export interface AntigravityNativeEvidenceV1 {
  schemaVersion: 1;
  advertised: boolean;
  documentedPublic: boolean;
  invokeSubagentObserved: boolean;
  healthy: boolean;
  hostVersion: string;
  documentationHash: string;
  observedAtMs: number;
  conversationReceipt?: NativeConversationReceiptV1;
}

export interface TmuxAgyEvidenceV1 {
  schemaVersion: 1;
  explicitlyEnabled: boolean;
  tmuxObserved: boolean;
  tmuxVersionHash: string;
  observedAtMs: number;
  agy: AgyCliProbeV1;
}

export interface WorkerProviderEvidenceV1 {
  antigravityNative?: AntigravityNativeEvidenceV1;
  agyHeadless?: AgyCliProbeV1;
  tmuxAgy?: TmuxAgyEvidenceV1;
}

export interface ProviderSelectionV1 {
  schemaVersion: 1;
  provider: WorkerProvider;
  generation: number;
  evidenceHash: string;
  observedAtMs: number;
  conversationReceipt?: NativeConversationReceiptV1;
}

export interface SelectProviderInputV1 {
  generation: number;
  launchMode: 'headless' | 'interactive';
  nowMs: number;
  maxEvidenceAgeMs?: number;
}

/**
 * Exact, fail-closed provider order.  An advertised/installed provider with
 * unhealthy evidence is a blocker; selection never silently retries a lower
 * provider after a failed launch.
 */
export function selectWorkerProvider(
  evidence: Readonly<WorkerProviderEvidenceV1>,
  input: Readonly<SelectProviderInputV1>,
): Result<ProviderSelectionV1, RuntimeError> {
  if (!Number.isSafeInteger(input.generation) || input.generation < 1
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Worker provider selection identity is invalid'));
  }
  const maxAge = input.maxEvidenceAgeMs ?? PROVIDER_EVIDENCE_MAX_AGE_MS;
  const native = evidence.antigravityNative;
  if (native?.advertised === true) {
    const receipt = native.conversationReceipt;
    const valid = native.schemaVersion === 1
      && native.documentedPublic
      && native.invokeSubagentObserved
      && native.healthy
      && fresh(native.observedAtMs, input.nowMs, maxAge)
      && digest(native.documentationHash)
      && receipt !== undefined
      && validNativeReceipt(receipt, input.generation, input.nowMs, maxAge);
    if (!valid) return providerBlocked('antigravity_native', 'advertised native invoke_subagent evidence is stale or unhealthy');
    return selected('antigravity_native', input.generation, native, native.observedAtMs, receipt);
  }

  if (input.launchMode === 'headless') {
    const headless = evidence.agyHeadless;
    if (headless?.installed === true) {
      const validated = validateAgyProbe(headless, input.nowMs, maxAge, 'headless');
      if (!validated.ok) return validated;
      return selected('agy_headless', input.generation, headless, headless.observedAtMs);
    }
  }

  const tmux = evidence.tmuxAgy;
  if (tmux?.explicitlyEnabled === true) {
    if (tmux.schemaVersion !== 1 || !tmux.tmuxObserved || !digest(tmux.tmuxVersionHash)
      || !fresh(tmux.observedAtMs, input.nowMs, maxAge)) {
      return providerBlocked('tmux_agy', 'explicit tmux provider evidence is stale or unhealthy');
    }
    const validated = validateAgyProbe(tmux.agy, input.nowMs, maxAge, 'interactive');
    if (!validated.ok) return validated;
    return selected('tmux_agy', input.generation, tmux, tmux.observedAtMs);
  }

  return err(runtimeError(
    'E_CAPABILITY_UNPROVEN',
    'No verified Antigravity worker provider is available; Claude, Codex, and Grok fallback is forbidden',
  ));
}

/** Bounded, read-only version/help probe.  It deliberately does not invent canary proof. */
// 15s, not 5s: `--version`/`--help` are effectively instant, but fork+exec of a
// fresh interpreter can stall well past 5s on a memory-pressured host (observed
// with a multi-GB sibling agy session), which would spuriously block the
// provider. The generous bound still fails fast on a genuine hang.
const AGY_PROBE_TIMEOUT_MS = 15_000;
export function probeAgy115(executable = 'agy', nowMs = Date.now()): Result<AgyCliProbeV1, RuntimeError> {
  const resolved = resolveExecutable(executable);
  if (resolved === null) return providerBlocked('agy_headless', 'Antigravity CLI executable is not installed');
  const version = spawnSync(resolved, ['--version'], { encoding: 'utf8', timeout: AGY_PROBE_TIMEOUT_MS, shell: false });
  const help = spawnSync(resolved, ['--help'], { encoding: 'utf8', timeout: AGY_PROBE_TIMEOUT_MS, shell: false });
  if (version.status !== 0 || help.status !== 0 || version.error !== undefined || help.error !== undefined) {
    return providerBlocked('agy_headless', 'Antigravity CLI version/help probe failed');
  }
  // agy 1.1.5 writes its help text to stderr even on exit 0.  Treat both
  // captured streams as bounded probe evidence rather than assuming stdout.
  const versionOutput = `${version.stdout}${version.stderr}`;
  const helpOutput = `${help.stdout}${help.stderr}`;
  const valid = validateAgy115Help(versionOutput, helpOutput);
  if (!valid.ok) return valid;
  const bytes = fs.readFileSync(resolved);
  return ok({
    schemaVersion: 1,
    installed: true,
    executableRealpath: resolved,
    executableSha256: sha256(bytes),
    version: AGY_WORKER_VERSION,
    versionOutputHash: sha256(versionOutput),
    helpOutputHash: sha256(helpOutput),
    requiredFlags: [...AGY_REQUIRED_HELP_FLAGS],
    observedAtMs: nowMs,
  });
}

export function withVerifiedCanary(
  probe: Readonly<AgyCliProbeV1>,
  receipt: Readonly<AgyCanaryReceiptV1>,
): AgyCliProbeV1 {
  return receipt.kind === 'headless_exit'
    ? { ...probe, headlessCanary: { ...receipt } }
    : { ...probe, interactiveCanary: { ...receipt } };
}

function validateAgyProbe(
  probe: Readonly<AgyCliProbeV1>,
  nowMs: number,
  maxAgeMs: number,
  canaryKind: 'headless' | 'interactive',
): Result<void, RuntimeError> {
  const common = probe.schemaVersion === 1
    && probe.installed
    && probe.version === AGY_WORKER_VERSION
    && path.isAbsolute(probe.executableRealpath)
    && digest(probe.executableSha256)
    && digest(probe.versionOutputHash)
    && digest(probe.helpOutputHash)
    && AGY_REQUIRED_HELP_FLAGS.every((flag) => probe.requiredFlags.includes(flag))
    && fresh(probe.observedAtMs, nowMs, maxAgeMs);
  const canary = canaryKind === 'headless' ? probe.headlessCanary : probe.interactiveCanary;
  const canaryValid = canary?.schemaVersion === 1
    && digest(canary.argvHash)
    && fresh(canary.observedAtMs, nowMs, maxAgeMs)
    && canary.orphanFree
    && (canaryKind === 'headless'
      ? canary.kind === 'headless_exit' && canary.exitCode === 0
      : canary.kind === 'interactive_attach' && canary.attachable);
  if (!common || !canaryValid) {
    return providerBlocked(
      canaryKind === 'headless' ? 'agy_headless' : 'tmux_agy',
      `Antigravity 1.1.5 ${canaryKind} probe/canary is missing, stale, or unhealthy`,
    );
  }
  return ok(undefined);
}

function validNativeReceipt(
  receipt: Readonly<NativeConversationReceiptV1>,
  generation: number,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  return receipt.schemaVersion === 1
    && receipt.provider === 'antigravity_native'
    && receipt.generation === generation
    && receipt.conversationId.trim() !== ''
    && receipt.receiptId.trim() !== ''
    && digest(receipt.capabilityDigest)
    && fresh(receipt.observedAtMs, nowMs, maxAgeMs);
}

function selected(
  provider: WorkerProvider,
  generation: number,
  material: unknown,
  observedAtMs: number,
  conversationReceipt?: NativeConversationReceiptV1,
): Result<ProviderSelectionV1, RuntimeError> {
  return ok({
    schemaVersion: 1,
    provider,
    generation,
    evidenceHash: sha256(canonicalJson(material)),
    observedAtMs,
    ...(conversationReceipt === undefined ? {} : { conversationReceipt }),
  });
}

function providerBlocked<T>(provider: WorkerProvider, reason: string): Result<T, RuntimeError> {
  return err(runtimeError('E_CAPABILITY_UNPROVEN', `Worker provider ${provider} blocked: ${reason}`, { provider }));
}

function fresh(observedAtMs: number, nowMs: number, maxAgeMs: number): boolean {
  return Number.isSafeInteger(observedAtMs) && observedAtMs >= 0
    && observedAtMs <= nowMs && nowMs - observedAtMs <= maxAgeMs;
}

function digest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function resolveExecutable(command: string): string | null {
  if (command.includes(path.sep)) {
    try {
      const resolved = fs.realpathSync(path.resolve(command));
      return fs.statSync(resolved).isFile() ? resolved : null;
    } catch (_) { return null; }
  }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue;
    const candidate = path.join(directory, command);
    try {
      if (fs.statSync(candidate).isFile() && (fs.statSync(candidate).mode & 0o111) !== 0) {
        return fs.realpathSync(candidate);
      }
    } catch (_) { /* continue */ }
  }
  return null;
}
