import * as crypto from 'crypto';

export const REDACTED = '<redacted>';
const SENSITIVE_KEY = /(?:authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|api[_-]?key|account|model|quota|prompt|command|argv|stdin|input|body)/i;
const ENV_CONTAINER_KEY = /^(?:env|environment|headers)$/i;
const SENSITIVE_ASSIGNMENT = /\b(authorization|cookie|token|secret|password|passwd|api[_-]?key|account|model|quota|prompt|command|argv|stdin|input|body)\s*([=:])\s*(?:bearer\s+)?[^\s,;]+/gi;
const BEARER = /\bbearer\s+[^\s,;]+/gi;
const QUERY_SECRET = /([?&](?:access_token|token|secret|password|api[_-]?key|account|model|quota)=)[^&#\s]*/gi;
const JSON_SENSITIVE = /"(authorization|cookie|token|secret|password|passwd|api[_-]?key|account|model|quota|prompt|command|argv|stdin|input|body)"(\s*:\s*)"(?:\\.|[^"])*"/gi;

export interface RedactionBounds {
  maxDepth?: number;
  maxEntries?: number;
  maxStringBytes?: number;
}

export function fingerprintSecret(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)}`;
}

export function redactDiagnostic(input: unknown, maximumBytes = 4096): string {
  const source = typeof input === 'string' ? input : safeStringify(redactValue(input));
  const redacted = source
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(SENSITIVE_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`)
    .replace(QUERY_SECRET, `$1${REDACTED}`)
    .replace(JSON_SENSITIVE, (_match, name: string, separator: string) => `"${name}"${separator}"${REDACTED}"`);
  return truncateUtf8(redacted, maximumBytes);
}

export function redactValue(
  value: unknown,
  bounds: RedactionBounds = {},
): unknown {
  const state = { entries: 0, seen: new WeakSet<object>() };
  return visit(value, '', 0, state, {
    maxDepth: bounds.maxDepth ?? 16,
    maxEntries: bounds.maxEntries ?? 256,
    maxStringBytes: bounds.maxStringBytes ?? 4096,
  });
}

function visit(
  value: unknown,
  key: string,
  depth: number,
  state: { entries: number; seen: WeakSet<object> },
  bounds: Required<RedactionBounds>,
): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactDiagnostic(value, bounds.maxStringBytes);
  if (typeof value !== 'object') return `<${typeof value}>`;
  if (depth >= bounds.maxDepth || state.entries >= bounds.maxEntries) return '<bounded>';
  if (state.seen.has(value)) return '<cycle>';
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, Math.max(0, bounds.maxEntries - state.entries)).map((entry) => {
        state.entries += 1;
        return visit(entry, '', depth + 1, state, bounds);
      });
    }
    const output: Record<string, unknown> = {};
    for (const childKey of Object.keys(value as Record<string, unknown>).sort()) {
      if (state.entries >= bounds.maxEntries) break;
      state.entries += 1;
      const child = (value as Record<string, unknown>)[childKey];
      if (ENV_CONTAINER_KEY.test(key) && /(?:token|secret|pass|key|auth|cookie|account|model|quota)/i.test(childKey)) {
        output[childKey] = REDACTED;
      } else {
        output[childKey] = visit(child, childKey, depth + 1, state, bounds);
      }
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

export function assertRedacted(value: unknown): void {
  if (!redactedTreeIsSafe(value, '', new WeakSet<object>())) {
    throw new Error('E_REDACTION_UNSAFE: value contains unredacted sensitive material');
  }
}

function redactedTreeIsSafe(value: unknown, key: string, seen: WeakSet<object>): boolean {
  if (SENSITIVE_KEY.test(key)) return value === REDACTED;
  if (typeof value === 'string') {
    const assignment = /\b(?:authorization|cookie|token|secret|password|passwd|api[_-]?key|account|model|quota|prompt|command|argv|stdin|input|body)\s*[=:]\s*(?!<redacted>)[^\s,;]+/i;
    const query = /[?&](?:access_token|token|secret|password|api[_-]?key|account|model|quota)=(?!<redacted>)[^&#\s]*/i;
    const jsonAssignment = /"(?:authorization|cookie|token|secret|password|passwd|api[_-]?key|account|model|quota|prompt|command|argv|stdin|input|body)"\s*:\s*"(?!<redacted>)(?:\\.|[^"])*"/i;
    return !assignment.test(value) && !/\bbearer\s+(?!<redacted>)\S+/i.test(value) && !query.test(value) && !jsonAssignment.test(value);
  }
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => redactedTreeIsSafe(entry, '', seen));
    return Object.entries(value as Record<string, unknown>)
      .every(([childKey, child]) => redactedTreeIsSafe(child, childKey, seen));
  } finally {
    seen.delete(value);
  }
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}
