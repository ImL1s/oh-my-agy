import {
  ResumeCandidateV1,
  ResumeSelectorKind,
  selectResumeCandidate,
} from '../contracts/resume';

export interface ResumeTargetV1 extends ResumeCandidateV1 {
  conversation_id?: string;
}

export interface ResumeSelectionOptions {
  bestEffort: boolean;
}

export interface ResumeLaunchPlanV1 {
  store_kind: 'resume_launch_plan';
  schema_version: 1;
  selector: ResumeSelectorKind;
  conversation_id: string | null;
  generation: number;
  argv: string[];
  verified: boolean;
  diagnostics_only: boolean;
}

/** Exact W0 selector: an invalid higher selector is terminal and never falls through. */
export function selectResumeTarget(
  candidates: readonly ResumeTargetV1[],
  options: ResumeSelectionOptions,
): ResumeTargetV1 {
  const selected = selectResumeCandidate(candidates, options);
  // W0 deliberately returns a diagnostics-only clone for best-effort search.
  // Recover the sole original candidate for the selected rank so OMA-specific
  // launch fields (notably conversation_id) cannot be lost at the bridge.
  const original = candidates.find((candidate) => candidate.kind === selected.kind);
  return original === undefined
    ? { ...selected } as ResumeTargetV1
    : { ...original, diagnostics_only: selected.diagnostics_only ?? original.diagnostics_only };
}

export function buildResumeLaunchPlan(target: Readonly<ResumeTargetV1>): ResumeLaunchPlanV1 {
  if (!target.valid || target.binding_count !== 1 || !Number.isSafeInteger(target.generation)
    || target.generation < 1) {
    throw new Error('E_RESUME_SELECTOR_CONFLICT: target is not exactly bound');
  }
  const bestEffort = target.kind === 'best_effort_repository_search';
  if (!bestEffort && (!target.conversation_id || target.conversation_id.trim() === '')) {
    throw new Error('E_RESUME_NOT_FOUND: exact Antigravity conversation is absent');
  }
  return {
    store_kind: 'resume_launch_plan',
    schema_version: 1,
    selector: target.kind,
    conversation_id: bestEffort ? null : target.conversation_id as string,
    generation: target.generation + 1,
    argv: bestEffort
      ? ['agy', '-c']
      : ['agy', '--conversation', target.conversation_id as string],
    verified: !bestEffort,
    diagnostics_only: bestEffort || target.diagnostics_only === true,
  };
}

export function quarantineStalePointer(
  pointer: Readonly<ResumeTargetV1>,
): ResumeTargetV1 {
  return {
    ...pointer,
    valid: false,
    diagnostics_only: true,
    invalid_reason: pointer.invalid_reason ?? 'stale_generation',
  };
}
