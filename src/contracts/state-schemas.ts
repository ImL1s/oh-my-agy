import * as path from 'path';

export type CanonicalPrimitive = null | boolean | string | number;
export type CanonicalValue =
  | CanonicalPrimitive
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export class ContractViolation extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'ContractViolation';
    this.code = code;
    this.details = details;
  }
}

export interface VersionedStore {
  store_kind: string;
  schema_version: number;
}

function assertUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ContractViolation('E_CANONICAL_JSON', `${label} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new ContractViolation('E_CANONICAL_JSON', `${label} contains an unpaired surrogate`);
    }
  }
}

export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) as number);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) as number);
  const count = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < count; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function serializeCanonical(value: unknown, seen: Set<object>, location: string): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, location);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ContractViolation(
        'E_CANONICAL_JSON',
        'Canonical JSON v1 accepts safe base-10 integers only',
        { location },
      );
    }
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value !== 'object') {
    throw new ContractViolation('E_CANONICAL_JSON', `Canonical JSON rejects ${typeof value}`, {
      location,
    });
  }
  if (seen.has(value)) {
    throw new ContractViolation('E_CANONICAL_JSON', 'Canonical JSON rejects cyclic values', {
      location,
    });
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => serializeCanonical(entry, seen, `${location}[${index}]`)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ContractViolation('E_CANONICAL_JSON', 'Canonical JSON accepts plain objects only', {
        location,
      });
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort(compareUnicodeCodePoints);
    return `{${keys.map((key) => {
      assertUnicodeScalarString(key, `${location} key`);
      if (object[key] === undefined) {
        throw new ContractViolation('E_CANONICAL_JSON', 'Canonical JSON rejects undefined values', {
          location: `${location}.${key}`,
        });
      }
      return `${JSON.stringify(key)}:${serializeCanonical(object[key], seen, `${location}.${key}`)}`;
    }).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJsonV1(value: unknown): string {
  return serializeCanonical(value, new Set<object>(), '$');
}

export function canonicalBytesV1(value: unknown): Buffer {
  return Buffer.from(canonicalJsonV1(value), 'utf8');
}

export function parseCanonicalJsonV1(bytes: string | Buffer): CanonicalValue {
  const source = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes;
  if (source.startsWith('\ufeff')) {
    throw new ContractViolation('E_CANONICAL_JSON', 'Canonical JSON must not contain a BOM');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ContractViolation('E_CANONICAL_JSON', 'Canonical JSON could not be parsed', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const canonical = canonicalJsonV1(parsed);
  if (canonical !== source) {
    throw new ContractViolation('E_CANONICAL_JSON', 'Input bytes are not canonical JSON v1');
  }
  return parsed as CanonicalValue;
}

export function assertVersionedStore(
  value: unknown,
  expectedKind: string,
  supportedVersion = 1,
): asserts value is VersionedStore & Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractViolation('E_SCHEMA_INVALID', 'Versioned store must be an object');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.store_kind !== expectedKind) {
    throw new ContractViolation('E_STORE_KIND', 'Unexpected store_kind', {
      expected: expectedKind,
      actual: candidate.store_kind,
    });
  }
  if (!Number.isInteger(candidate.schema_version) || (candidate.schema_version as number) <= 0) {
    throw new ContractViolation('E_SCHEMA_INVALID', 'schema_version must be a positive integer');
  }
  if ((candidate.schema_version as number) > supportedVersion) {
    throw new ContractViolation('E_FUTURE_SCHEMA', 'Schema is newer than this runtime', {
      supportedVersion,
      actualVersion: candidate.schema_version,
    });
  }
  if (candidate.schema_version !== supportedVersion) {
    throw new ContractViolation('E_SCHEMA_INVALID', 'Unsupported historic schema version', {
      supportedVersion,
      actualVersion: candidate.schema_version,
    });
  }
}

export function assertExactObjectKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(compareUnicodeCodePoints);
  const expected = [...expectedKeys].sort(compareUnicodeCodePoints);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ContractViolation('E_SCHEMA_INVALID', `${label} keys do not match the contract`, {
      expected,
      actual,
    });
  }
}

export function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ContractViolation('E_SCHEMA_INVALID', `${label} must be a non-empty string`);
  }
  assertUnicodeScalarString(value, label);
}

export function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ContractViolation('E_SCHEMA_INVALID', `${label} must be lowercase SHA-256 hex`);
  }
}

export function assertGitObjectId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new ContractViolation('E_SCHEMA_INVALID', `${label} must be a lowercase Git object ID`);
  }
}

export function assertCanonicalUtcTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new ContractViolation('E_SCHEMA_INVALID', `${label} must be a canonical UTC timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ContractViolation('E_SCHEMA_INVALID', `${label} must be a canonical UTC timestamp`);
  }
}

export function assertStringArray(
  value: unknown,
  label: string,
  options: { nonEmptyValues?: boolean; unique?: boolean } = {},
): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ContractViolation('E_SCHEMA_INVALID', `${label} must be a string array`);
  }
  if (options.nonEmptyValues && value.some((entry) => entry.trim() === '')) {
    throw new ContractViolation('E_SCHEMA_INVALID', `${label} cannot contain empty strings`);
  }
  if (options.unique && new Set(value).size !== value.length) {
    throw new ContractViolation('E_SCHEMA_INVALID', `${label} must contain unique entries`);
  }
}

export function assertSafeRepositoryWritePath(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if (path.isAbsolute(value) || value.includes('\0') || value.includes('\\')) {
    throw new ContractViolation('E_WRITE_SCOPE', `${label} is not a safe repository-relative path`);
  }
  const normalized = path.posix.normalize(value);
  const segments = normalized.split('/');
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.'
    || segments.some((segment) => segment.toLowerCase() === 'agents.md')) {
    throw new ContractViolation('E_WRITE_SCOPE', `${label} escapes scope or changes contributor guidance`);
  }
  const lower = normalized.toLowerCase();
  if (lower === '.git' || lower.startsWith('.git/')
    || /(?:^|\/)(?:verified|release-transaction|release)(?:\/|$)/.test(lower)
    || /^(?:\.agy|\.omg)\/state(?:\/|$)/.test(lower)) {
    throw new ContractViolation('E_WRITE_SCOPE', `${label} targets canonical or release authority state`);
  }
}

export function assertSafeArgvVector(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0
    || value.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new ContractViolation('E_ARGV_UNSAFE', `${label} must be a non-empty direct argv vector`);
  }
  const executable = path.basename(value[0]).toLowerCase().replace(/\.exe$/, '');
  if (['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'cmd', 'powershell', 'pwsh'].includes(executable)) {
    throw new ContractViolation('E_ARGV_UNSAFE', `${label} cannot invoke a shell interpreter`);
  }
  const unsafe = /\$\(|\$\{|`|\r|\n|&&|\|\||[;|<>]/;
  if (value.some((entry) => unsafe.test(entry))) {
    throw new ContractViolation('E_ARGV_UNSAFE', `${label} contains shell control or interpolation syntax`);
  }
}
