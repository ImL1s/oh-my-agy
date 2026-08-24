/**
 * Session skill catalog SSOT（#41）。
 * 設計概念映射：OMX `templates/catalog-manifest.json`（versioned name + visibility +
 * category）、OMG `operation_catalog.py`（implemented == handler keys 的 golden set）、
 * OMC plugin `skills[]` 與 skill-bodies 必須同名。OMA 以凍結表同時餵型別、CLI list、
 * markdown generator 與 doctor 雙向漂移檢查。
 */

export type OmaSkillVisibilityV1 = 'public' | 'internal';

export type OmaSkillCategoryV1 =
  | 'delivery'
  | 'planning'
  | 'quality'
  | 'orchestration'
  | 'research'
  | 'session'
  | 'index'
  | 'canary';

export interface OmaSkillCatalogRecordV1 {
  readonly name: string;
  readonly visibility: OmaSkillVisibilityV1;
  readonly category: OmaSkillCategoryV1;
  readonly hostSlashForm: string;
}

function skill<
  Name extends string,
  Visibility extends OmaSkillVisibilityV1,
  Category extends OmaSkillCategoryV1,
>(
  name: Name,
  visibility: Visibility,
  category: Category,
): Readonly<{
  name: Name;
  visibility: Visibility;
  category: Category;
  hostSlashForm: `/oh-my-agy:${Name}`;
}> {
  return Object.freeze({
    name,
    visibility,
    category,
    hostSlashForm: `/oh-my-agy:${name}` as const,
  });
}

/**
 * 凍結 catalog v1。順序即 markdown generator 的 preferred order
 *（對齊既有 slash catalog：oma-runtime 置尾）。
 */
export const OMA_SKILL_CATALOG_V1 = Object.freeze([
  skill('autopilot', 'public', 'delivery'),
  skill('deep-interview', 'public', 'planning'),
  skill('plan', 'public', 'planning'),
  skill('ralplan', 'public', 'planning'),
  skill('ultragoal', 'public', 'delivery'),
  skill('code-review', 'public', 'quality'),
  skill('ultraqa', 'public', 'quality'),
  skill('ralph', 'public', 'delivery'),
  skill('ultrawork', 'public', 'delivery'),
  skill('search', 'public', 'research'),
  skill('team', 'public', 'orchestration'),
  skill('cancel', 'public', 'session'),
  skill('verify', 'public', 'quality'),
  skill('trace', 'public', 'research'),
  skill('ask', 'public', 'research'),
  skill('wiki', 'public', 'research'),
  skill('hud', 'public', 'session'),
  skill('setup', 'public', 'session'),
  skill('workflow', 'public', 'orchestration'),
  skill('discovery-proof', 'internal', 'canary'),
  skill('oma-runtime', 'public', 'index'),
] as const);

export type OmaSkillCatalogEntryV1 = (typeof OMA_SKILL_CATALOG_V1)[number];

/** 由 catalog 推導；禁止再手寫 union（避免 ghost `'doctor'`）。 */
export type OmaWorkflowSkill = OmaSkillCatalogEntryV1['name'];

const CATALOG_BY_NAME = Object.freeze(
  Object.fromEntries(OMA_SKILL_CATALOG_V1.map((entry) => [entry.name, entry])),
) as Readonly<Record<string, OmaSkillCatalogEntryV1>>;

export function catalogEntryForSkill(name: string): OmaSkillCatalogEntryV1 | undefined {
  return CATALOG_BY_NAME[name];
}

export function listCatalogSkillNames(): OmaWorkflowSkill[] {
  return OMA_SKILL_CATALOG_V1.map((entry) => entry.name);
}

export function listPublicCatalogSkillNames(): OmaWorkflowSkill[] {
  return OMA_SKILL_CATALOG_V1
    .filter((entry) => entry.visibility === 'public')
    .map((entry) => entry.name);
}

export function isInternalCatalogSkill(name: string): boolean {
  return catalogEntryForSkill(name)?.visibility === 'internal';
}

/**
 * `.claude-plugin/plugin.json` 的 `skills[]` 條目正規化：
 * 去掉 `./skills/` 前綴與結尾 `/`。
 */
export function normalizeClaudePluginSkillEntry(entry: string): string {
  return entry.replace(/^\.\//, '').replace(/^skills\//, '').replace(/\/+$/, '');
}
