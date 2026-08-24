/**
 * SKILL.md YAML frontmatter 子集解析器（#53）。
 * 設計概念映射：OMC `scripts/keyword-detector.mjs` 消費的 skill YAML
 *（`name` / `description` / `argument-hint`）與 OMX `$skill` list/search、
 * `omx list --json` 的 packaged skill 欄位。OMA 不引入 YAML 相依，只支援
 * 單行 `key: value` 與引號字串；格式錯誤 fail-open 回 `null`，不得讓 list/search 整段失敗。
 */

export interface SkillFrontmatterV1 {
  readonly name: string | null;
  readonly description: string | null;
  readonly argumentHint: string | null;
}

/** `oma skill list|search --json` 每一列的穩定欄位順序（#53）。 */
export interface SkillDiscoveryRowV1 {
  readonly name: string;
  readonly path: string;
  readonly description: string | null;
  readonly argumentHint: string | null;
}

const KEY_VALUE_LINE = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const MULTILINE_INDICATOR = /^[|>][+-]?$/;
const ARGUMENT_HINT_KEYS = Object.freeze(['argument-hint', 'argumentHint'] as const);

/**
 * 解析 SKILL.md 開頭的 YAML frontmatter。
 * 缺失、未閉合、重複鍵、或超出子集的寫法一律回 `null`（不丟例外）。
 */
export function parseSkillFrontmatter(markdown: string): SkillFrontmatterV1 | null {
  try {
    return parseSkillFrontmatterStrict(markdown);
  } catch {
    return null;
  }
}

function parseSkillFrontmatterStrict(markdown: string): SkillFrontmatterV1 | null {
  const text = stripBom(markdown);
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      close = index;
      break;
    }
  }
  if (close < 0) return null;

  const fields = new Map<string, string>();
  for (let index = 1; index < close; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    const parsed = parseKeyValueLine(line);
    if (parsed === null) return null;
    if (fields.has(parsed.key)) return null;
    fields.set(parsed.key, parsed.value);
  }
  if (fields.has('argument-hint') && fields.has('argumentHint')) return null;
  return {
    name: emptyToNull(fields.get('name')),
    description: emptyToNull(fields.get('description')),
    argumentHint: emptyToNull(firstPresent(fields, ARGUMENT_HINT_KEYS)),
  };
}

/** 由 markdown（或讀檔失敗的 `null`）組出 list/search 列；matter 失敗時欄位為 `null`。 */
export function skillDiscoveryRowFromMarkdown(
  name: string,
  markdown: string | null,
): SkillDiscoveryRowV1 {
  const parsed = markdown === null ? null : parseSkillFrontmatter(markdown);
  return {
    name,
    path: `skills/${name}/SKILL.md`,
    description: parsed === null ? null : parsed.description,
    argumentHint: parsed === null ? null : parsed.argumentHint,
  };
}

/**
 * 比對 name / description（OMC skill search / OMX `$skill` search）。
 * 空 query（含只含空白）視為 miss，不得回傳全清單。
 */
export function skillMatchesSearchQuery(
  row: Pick<SkillDiscoveryRowV1, 'name' | 'description'>,
  query: string,
): boolean {
  const needle = foldSkillSearchText(query.trim());
  if (needle === '') return false;
  if (foldSkillSearchText(row.name).includes(needle)) return true;
  if (row.description !== null && foldSkillSearchText(row.description).includes(needle)) {
    return true;
  }
  return false;
}

/** UTF-8 byte 序，避免 locale 影響 search 排序穩定性。 */
export function compareSkillNamesV1(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * 過濾並以 name 的 UTF-8 byte 序穩定排序。
 * 相同輸入必須產生 byte 級相同的列順序與欄位。
 */
export function searchSkillDiscoveryRows(
  rows: readonly SkillDiscoveryRowV1[],
  query: string,
): SkillDiscoveryRowV1[] {
  return rows
    .filter((row) => skillMatchesSearchQuery(row, query))
    .slice()
    .sort((left, right) => compareSkillNamesV1(left.name, right.name));
}

export function foldSkillSearchText(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

function parseKeyValueLine(line: string): { key: string; value: string } | null {
  const match = KEY_VALUE_LINE.exec(line);
  if (match === null) return null;
  const value = parseYamlScalar(match[2]);
  if (value === null) return null;
  return { key: match[1], value };
}

/** 僅支援純量：引號字串與單行 unquoted；`|`/`>` / flow 集合 fail-open。 */
function parseYamlScalar(raw: string): string | null {
  if (raw.length === 0) return '';
  if (raw.startsWith('"')) return parseDoubleQuoted(raw);
  if (raw.startsWith("'")) return parseSingleQuoted(raw);
  const unquoted = raw.trim();
  if (MULTILINE_INDICATOR.test(unquoted)) return null;
  if (unquoted.startsWith('[') || unquoted.startsWith('{')) return null;
  return unquoted;
}

function parseDoubleQuoted(raw: string): string | null {
  let index = 1;
  let out = '';
  while (index < raw.length) {
    const char = raw[index];
    if (char === '"') {
      if (raw.slice(index + 1).trim() !== '') return null;
      return out;
    }
    if (char === '\\') {
      const next = raw[index + 1];
      if (next === undefined) return null;
      if (next === '\\' || next === '"') out += next;
      else if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else return null;
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return null;
}

function parseSingleQuoted(raw: string): string | null {
  let index = 1;
  let out = '';
  while (index < raw.length) {
    const char = raw[index];
    if (char === "'") {
      if (raw[index + 1] === "'") {
        out += "'";
        index += 2;
        continue;
      }
      if (raw.slice(index + 1).trim() !== '') return null;
      return out;
    }
    out += char;
    index += 1;
  }
  return null;
}

function emptyToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value.trim() === '' ? null : value;
}

function firstPresent(
  fields: ReadonlyMap<string, string>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    if (fields.has(key)) return fields.get(key);
  }
  return undefined;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
