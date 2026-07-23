import * as fs from 'fs';
import * as path from 'path';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import { sha256Hex } from '../contracts/writer-chain';

export const WIKI_INDEX_CONTRACT_V1 = 'oma.wiki-index/v1' as const;
export const MAX_WIKI_DOCUMENT_BYTES_V1 = 1_048_576;
export const MAX_WIKI_DOCUMENTS_V1 = 10_000;
export const MAX_WIKI_RESULTS_V1 = 50;

export interface WikiSourceDocumentV1 {
  path: string;
  content: string;
}

export interface WikiProvenanceV1 {
  source_path: string;
  source_sha256: string;
}

export interface WikiIndexRecordV1 {
  record_id: string;
  kind: 'page' | 'decision';
  decision_id: string | null;
  path: string;
  title: string;
  content: string;
  content_sha256: string;
  provenance: WikiProvenanceV1[];
}

export interface WikiIndexV1 {
  store_kind: 'oma_wiki_index';
  schema_version: 1;
  contract: typeof WIKI_INDEX_CONTRACT_V1;
  repository_id: 'OMA';
  records: WikiIndexRecordV1[];
  index_digest: string;
}

export interface WikiSearchResultV1 {
  record_id: string;
  kind: WikiIndexRecordV1['kind'];
  decision_id: string | null;
  path: string;
  title: string;
  score: number;
  snippet: string;
  provenance: WikiProvenanceV1[];
}

export interface WikiSearchResponseV1 {
  query: string;
  index_digest: string;
  total_matches: number;
  results: WikiSearchResultV1[];
}

export interface RepositoryWikiIndexOptionsV1 {
  repositoryRoot: string;
  roots?: readonly string[];
}

const DEFAULT_WIKI_ROOTS_V1 = Object.freeze([
  'docs',
  '.agy/wiki',
  '.agy/decisions',
]);

export function buildWikiIndex(
  sourceDocuments: readonly WikiSourceDocumentV1[],
): WikiIndexV1 {
  if (sourceDocuments.length > MAX_WIKI_DOCUMENTS_V1) {
    throw new Error('E_WIKI_LIMIT: document count exceeds the frozen bound');
  }
  const paths = new Set<string>();
  const records = sourceDocuments.map((source) => {
    const sourcePath = canonicalRelativePath(source.path);
    if (paths.has(sourcePath)) throw new Error(`E_WIKI_DUPLICATE: ${sourcePath}`);
    paths.add(sourcePath);
    const content = normalizeText(source.content);
    if (Buffer.byteLength(content, 'utf8') > MAX_WIKI_DOCUMENT_BYTES_V1) {
      throw new Error(`E_WIKI_LIMIT: ${sourcePath} exceeds the byte bound`);
    }
    const contentDigest = sha256Hex(Buffer.from(content, 'utf8'));
    const kind = classifyDocument(sourcePath, content);
    const decisionId = kind === 'decision' ? extractDecisionId(sourcePath, content) : null;
    const title = extractTitle(sourcePath, content);
    const recordMaterial = [kind, decisionId, sourcePath, title, contentDigest];
    return {
      record_id: sha256Hex(canonicalBytesV1(recordMaterial)),
      kind,
      decision_id: decisionId,
      path: sourcePath,
      title,
      content,
      content_sha256: contentDigest,
      provenance: [{ source_path: sourcePath, source_sha256: contentDigest }],
    } satisfies WikiIndexRecordV1;
  }).sort((left, right) => compareUtf8(left.path, right.path));

  const material = {
    store_kind: 'oma_wiki_index',
    schema_version: 1,
    contract: WIKI_INDEX_CONTRACT_V1,
    repository_id: 'OMA',
    records,
  } as const;
  return {
    ...material,
    index_digest: sha256Hex(canonicalBytesV1(material)),
  };
}

export function indexRepositoryWiki(options: RepositoryWikiIndexOptionsV1): WikiIndexV1 {
  const repositoryRoot = fs.realpathSync(path.resolve(options.repositoryRoot));
  const roots = options.roots ?? DEFAULT_WIKI_ROOTS_V1;
  const documents: WikiSourceDocumentV1[] = [];
  for (const configuredRoot of [...new Set(roots)].sort(compareUtf8)) {
    const relativeRoot = canonicalRelativePath(configuredRoot);
    const absoluteRoot = path.resolve(repositoryRoot, ...relativeRoot.split('/'));
    if (!contained(repositoryRoot, absoluteRoot) || !fs.existsSync(absoluteRoot)) continue;
    const resolvedRoot = fs.realpathSync(absoluteRoot);
    if (!contained(repositoryRoot, resolvedRoot)) {
      throw new Error(`E_WIKI_PATH: ${relativeRoot} resolves outside the repository`);
    }
    collectDocuments(repositoryRoot, resolvedRoot, documents);
  }
  return buildWikiIndex(documents);
}

export function searchWikiIndex(
  index: Readonly<WikiIndexV1>,
  query: string,
  limit = 20,
): WikiSearchResponseV1 {
  const normalizedQuery = normalizeQuery(query);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WIKI_RESULTS_V1) {
    throw new Error('E_WIKI_LIMIT: result limit is outside 1..50');
  }
  const tokens = [...new Set(tokenize(normalizedQuery))].sort(compareUtf8);
  if (tokens.length === 0) throw new Error('E_WIKI_QUERY: query has no searchable tokens');
  const matches = index.records.map((record) => {
    const lowerTitle = record.title.toLowerCase();
    const lowerContent = record.content.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      score += countOccurrences(lowerTitle, token) * 20;
      score += countOccurrences(lowerContent, token);
      if (record.decision_id?.toLowerCase() === token) score += 50;
    }
    if (lowerTitle.includes(normalizedQuery)) score += 25;
    if (lowerContent.includes(normalizedQuery)) score += 5;
    return { record, score, firstOffset: firstTokenOffset(lowerContent, tokens) };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score
      || compareUtf8(left.record.path, right.record.path));

  return {
    query: normalizedQuery,
    index_digest: index.index_digest,
    total_matches: matches.length,
    results: matches.slice(0, limit).map(({ record, score, firstOffset }) => ({
      record_id: record.record_id,
      kind: record.kind,
      decision_id: record.decision_id,
      path: record.path,
      title: record.title,
      score,
      snippet: snippet(record.content, firstOffset),
      provenance: record.provenance.map((entry) => ({ ...entry })),
    })),
  };
}

function collectDocuments(
  repositoryRoot: string,
  directory: string,
  output: WikiSourceDocumentV1[],
): void {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      collectDocuments(repositoryRoot, absolute, output);
      continue;
    }
    if (!stat.isFile() || !/\.(?:md|mdx|txt|json)$/i.test(entry.name)) continue;
    if (stat.size > MAX_WIKI_DOCUMENT_BYTES_V1) {
      throw new Error(`E_WIKI_LIMIT: ${entry.name} exceeds the byte bound`);
    }
    const resolved = fs.realpathSync(absolute);
    if (!contained(repositoryRoot, resolved)) {
      throw new Error('E_WIKI_PATH: document resolves outside the repository');
    }
    output.push({
      path: path.relative(repositoryRoot, resolved).split(path.sep).join('/'),
      content: fs.readFileSync(resolved, 'utf8'),
    });
    if (output.length > MAX_WIKI_DOCUMENTS_V1) {
      throw new Error('E_WIKI_LIMIT: document count exceeds the frozen bound');
    }
  }
}

function canonicalRelativePath(value: string): string {
  if (value === '' || value.includes('\0') || value.includes('\\') || path.isAbsolute(value)) {
    throw new Error('E_WIKI_PATH: path must be a confined repository-relative POSIX path');
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('E_WIKI_PATH: path escapes the repository');
  }
  return normalized;
}

function normalizeText(value: string): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error('E_WIKI_CONTENT: document must be NUL-free UTF-8 text');
  }
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

function normalizeQuery(value: string): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('E_WIKI_QUERY: invalid query');
  const normalized = value.trim().replace(/\s+/g, ' ').normalize('NFC').toLowerCase();
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > 512) {
    throw new Error('E_WIKI_QUERY: query must be 1..512 bytes');
  }
  return normalized;
}

function tokenize(value: string): string[] {
  return value.match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function classifyDocument(sourcePath: string, content: string): 'page' | 'decision' {
  return /(?:^|\/)(?:adr|adrs|decision|decisions)(?:\/|-)/i.test(sourcePath)
    || /^#{1,3}\s+(?:ADR|Decision)\b/im.test(content)
    ? 'decision' : 'page';
}

function extractDecisionId(sourcePath: string, content: string): string {
  const fromHeading = /^#{1,3}\s+(?:(?:ADR|Decision)[-\s:]*)?([A-Za-z0-9][A-Za-z0-9._-]*)\b/im.exec(content)?.[1];
  const stem = path.posix.basename(sourcePath, path.posix.extname(sourcePath));
  const fromPath = /^((?:adr|decision)[-_]?[0-9A-Za-z.-]+)$/i.exec(stem)?.[1];
  return (fromPath ?? fromHeading ?? path.posix.basename(sourcePath, path.posix.extname(sourcePath)))
    .toLowerCase();
}

function extractTitle(sourcePath: string, content: string): string {
  const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(content)?.[1]?.replace(/\s+#+\s*$/, '').trim();
  if (heading) return heading;
  return path.posix.basename(sourcePath, path.posix.extname(sourcePath))
    .replace(/[-_]+/g, ' ').trim();
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const next = haystack.indexOf(needle, offset);
    if (next < 0) break;
    count += 1;
    offset = next + Math.max(1, needle.length);
  }
  return count;
}

function firstTokenOffset(content: string, tokens: readonly string[]): number {
  return tokens.reduce((first, token) => {
    const offset = content.indexOf(token);
    return offset < 0 ? first : Math.min(first, offset);
  }, Number.MAX_SAFE_INTEGER);
}

function snippet(content: string, firstOffset: number): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized === '') return '';
  const offset = firstOffset === Number.MAX_SAFE_INTEGER ? 0 : Math.max(0, firstOffset - 80);
  const start = Math.min(offset, Math.max(0, normalized.length - 240));
  const body = normalized.slice(start, start + 240);
  return `${start > 0 ? '…' : ''}${body}${start + body.length < normalized.length ? '…' : ''}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
