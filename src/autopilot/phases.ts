/**
 * 設計概念映射：OMX Autopilot 五階段 canonical 名稱；
 * 舊 OMA requirements/planning/executing/review/qa 為相容別名。
 */
export const OMX_PHASE_CYCLE = [
  'deep-interview',
  'ralplan',
  'ultragoal',
  'code-review',
  'ultraqa',
] as const;

export type OmxActivePhase = (typeof OMX_PHASE_CYCLE)[number];

export type LegacyActivePhase =
  | 'requirements'
  | 'planning'
  | 'executing'
  | 'review'
  | 'qa';

const LEGACY_TO_OMX: Readonly<Record<LegacyActivePhase, OmxActivePhase>> = Object.freeze({
  requirements: 'deep-interview',
  planning: 'ralplan',
  executing: 'ultragoal',
  review: 'code-review',
  qa: 'ultraqa',
});

const OMX_TO_LEGACY: Readonly<Record<OmxActivePhase, LegacyActivePhase>> = Object.freeze({
  'deep-interview': 'requirements',
  ralplan: 'planning',
  ultragoal: 'executing',
  'code-review': 'review',
  ultraqa: 'qa',
});

const ALL_ACTIVE = new Set<string>([
  ...OMX_PHASE_CYCLE,
  'requirements',
  'planning',
  'executing',
  'review',
  'qa',
]);

export function isOmxOrLegacyActivePhase(value: string): boolean {
  return ALL_ACTIVE.has(value);
}

/** 將 phase / gate kind 正規化為 OMX canonical（未知值原樣回傳）。 */
export function toOmxPhaseName(value: string): string {
  if ((OMX_PHASE_CYCLE as readonly string[]).includes(value)) return value;
  if (value in LEGACY_TO_OMX) return LEGACY_TO_OMX[value as LegacyActivePhase];
  return value;
}

/** 將 OMX 名映回舊 gate kind（evidence 檔可能仍用舊字串）。 */
export function toLegacyGateKind(value: string): string {
  if (value in OMX_TO_LEGACY) return OMX_TO_LEGACY[value as OmxActivePhase];
  return value;
}

/**
 * gate evidence kind 是否與目前 phase 匹配（OMX 或 legacy 雙向）。
 */
export function gateMatchesPhase(phase: string, evidenceKind: string): boolean {
  const p = toOmxPhaseName(phase);
  const k = toOmxPhaseName(evidenceKind);
  return p === k;
}

export function skillNameForPhase(phase: string): string {
  const omx = toOmxPhaseName(phase);
  if ((OMX_PHASE_CYCLE as readonly string[]).includes(omx)) return omx;
  return 'autopilot';
}

export function nextOmxPhaseAfterGate(
  currentPhase: string,
  gateKind: string,
): { phase: string; active: OmxActivePhase } {
  const gate = toOmxPhaseName(gateKind);
  // production 仍為 OMA 終端因果 gate
  if (gate === 'production') return { phase: 'completed', active: 'ultraqa' };
  if (gate === 'ultraqa' || gate === 'qa') return { phase: 'ultraqa', active: 'ultraqa' };
  if (gate === 'code-review' || gate === 'review') {
    return { phase: 'ultraqa', active: 'ultraqa' };
  }
  if (gate === 'ultragoal' || gate === 'executing') {
    return { phase: 'code-review', active: 'code-review' };
  }
  if (gate === 'ralplan' || gate === 'planning') {
    return { phase: 'ultragoal', active: 'ultragoal' };
  }
  if (gate === 'deep-interview' || gate === 'requirements') {
    return { phase: 'ralplan', active: 'ralplan' };
  }
  const active = toOmxPhaseName(currentPhase);
  const activeOmx = (OMX_PHASE_CYCLE as readonly string[]).includes(active)
    ? (active as OmxActivePhase)
    : 'deep-interview';
  return { phase: currentPhase === 'completed' ? 'completed' : activeOmx, active: activeOmx };
}
