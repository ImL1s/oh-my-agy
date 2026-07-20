import { canonicalJson, sha256 } from '../runtime/atomic';
import { StopEventIdentity } from './event-identity';
import {
  AcceptedRevisionRefV1,
  AggregateCandidate,
  AutopilotPhase,
  SessionAggregateV1,
  StopEffectV1,
} from './session-aggregate';

export interface ProgressFingerprintInput {
  acceptedGateRevisions: readonly (number | AcceptedRevisionRefV1)[];
  acceptedTaskProgressRevisions: readonly (number | AcceptedRevisionRefV1)[];
  acceptedEvidenceRevisionsAndDigests: readonly Readonly<{ id?: string; revision: number; digest: string }>[];
  verifiedArtifactDigests: readonly (string | Readonly<{ path: string; digest: string }>)[];
}

export interface StopEligibilityV1 {
  fullyIdle: boolean;
  terminationReason: string;
  hasRetryableBlocker: boolean;
  hasInteractionBlocker: boolean;
  hasLiveCommand: boolean;
  continueReason?: string;
}

const TERMINAL_PHASES = new Set<AutopilotPhase>([
  'completed',
  'failed',
  'tripped',
  'cancelled',
]);

/**
 * 設計概念映射：官方 hooks 文件示例用 model_stop；
 * Antigravity CLI 1.1.4 live 實測正常結束常送 NO_TOOL_CALL（見 live hook-debug）。
 * 僅 allowlist 可進入 no-progress streak / continue；其餘 NonCounting allow。
 */
export const ELIGIBLE_TERMINATION_REASONS = new Set<string>([
  'model_stop',
  'NO_TOOL_CALL',
]);

export function isEligibleTerminationReason(reason: string): boolean {
  return ELIGIBLE_TERMINATION_REASONS.has(reason);
}

export class ProgressOracleV1 {
  fingerprint(input: Readonly<ProgressFingerprintInput>): string {
    const canonicalInput = {
      acceptedGateRevisions: input.acceptedGateRevisions.map(normalizeRevisionRef)
        .sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision),
      acceptedTaskProgressRevisions: input.acceptedTaskProgressRevisions.map(normalizeRevisionRef)
        .sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision),
      acceptedEvidenceRevisionsAndDigests: [...input.acceptedEvidenceRevisionsAndDigests]
        .map((item) => ({ id: item.id ?? `legacy-${item.revision}`, revision: item.revision, digest: item.digest }))
        .sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision || a.digest.localeCompare(b.digest)),
      verifiedArtifactDigests: input.verifiedArtifactDigests.map((item) => typeof item === 'string'
        ? { path: '', digest: item }
        : { path: item.path, digest: item.digest })
        .sort((a, b) => a.path.localeCompare(b.path) || a.digest.localeCompare(b.digest)),
    };
    return sha256(canonicalJson(canonicalInput));
  }

  reduceStop(
    snapshot: Readonly<SessionAggregateV1>,
    _identity: Readonly<StopEventIdentity>,
    fingerprint: string,
    eligibility: Readonly<StopEligibilityV1>,
  ): AggregateCandidate {
    const aggregate = structuredClone(snapshot) as SessionAggregateV1;
    aggregate.revision = snapshot.revision + 1;
    aggregate.autopilot.progressFingerprint = fingerprint;
    const beforePhase = snapshot.autopilot.phase;
    const beforeStreak = snapshot.autopilot.noProgressStreak;
    const eligible = eligibility.fullyIdle
      && isEligibleTerminationReason(eligibility.terminationReason)
      && !eligibility.hasRetryableBlocker
      && !eligibility.hasInteractionBlocker
      && !eligibility.hasLiveCommand
      && !TERMINAL_PHASES.has(beforePhase);

    if (!eligible) {
      return {
        kind: 'NonCounting',
        aggregate,
        decision: { decision: 'allow' },
        breakerEligible: false,
        effect: effect(snapshot, aggregate),
      };
    }

    const sameFingerprint = snapshot.autopilot.lastEligibleFingerprint === fingerprint;
    aggregate.autopilot.noProgressStreak = sameFingerprint ? beforeStreak + 1 : 1;
    aggregate.autopilot.lastEligibleFingerprint = fingerprint;
    if (aggregate.autopilot.noProgressStreak >= 3) {
      aggregate.autopilot.phase = 'tripped';
      return {
        kind: 'Trip',
        aggregate,
        decision: { decision: 'allow' },
        breakerEligible: true,
        effect: effect(snapshot, aggregate),
      };
    }

    return {
      kind: 'Continue',
      aggregate,
      decision: {
        decision: 'continue',
        reason: eligibility.continueReason ?? `Continue the next verified ${beforePhase} action.`,
      },
      breakerEligible: true,
      effect: effect(snapshot, aggregate),
    };
  }
}

function normalizeRevisionRef(
  value: number | AcceptedRevisionRefV1,
): AcceptedRevisionRefV1 {
  return typeof value === 'number'
    ? { id: `legacy-${value}`, revision: value }
    : { id: value.id, revision: value.revision };
}

function effect(
  before: Readonly<SessionAggregateV1>,
  after: Readonly<SessionAggregateV1>,
): StopEffectV1 {
  return {
    beforeRevision: before.revision,
    afterRevision: after.revision,
    streakBefore: before.autopilot.noProgressStreak,
    streakAfter: after.autopilot.noProgressStreak,
    phaseBefore: before.autopilot.phase,
    phaseAfter: after.autopilot.phase,
  };
}
