import * as fs from 'fs';
import * as path from 'path';
import {
  ContractViolation,
  assertExactObjectKeys,
  assertVersionedStore,
  canonicalBytesV1,
} from '../contracts/state-schemas';
import { atomicWriteContractBytes, atomicWriteJson } from './atomic';
import { RuntimeError, runtimeError } from './errors';
import { acquireOwnerLock, releaseOwnerLock } from './lock';
import { Result, Snapshot, err, ok } from './types';
import { ensureContainedPath } from './state-root';

export interface ContractSnapshotV1<T> {
  store_kind: string;
  schema_version: number;
  revision: number;
  value: T;
}

export interface ContractStateStoreOptions<T> {
  storeKind: string;
  schemaVersion?: number;
  lockTimeoutMs?: number;
  validateValue?: (value: unknown) => void;
}

export type StateMutator<T> = (
  current: Readonly<T>,
  snapshot: Readonly<Snapshot<T>>,
) => T;

export interface StateStoreOptions {
  schemaVersion?: number;
  lockTimeoutMs?: number;
}

/** W0-native CAS store. Legacy StateStore remains only for pre-W0 schemas. */
export class ContractStateStore<T> {
  readonly root: string;
  readonly storeKind: string;
  readonly schemaVersion: number;
  private readonly lockTimeoutMs: number;
  private readonly validateValue?: (value: unknown) => void;

  constructor(root: string, options: ContractStateStoreOptions<T>) {
    if (options.storeKind.trim() === '') throw new Error('storeKind must be non-empty');
    this.root = path.resolve(root);
    this.storeKind = options.storeKind;
    this.schemaVersion = options.schemaVersion ?? 1;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.validateValue = options.validateValue;
  }

  async create(key: string, initial: T): Promise<Result<ContractSnapshotV1<T>, RuntimeError>> {
    const target = resolveStateKey(this.root, key);
    if (!target.ok) return target;
    const lock = await acquireOwnerLock(`${target.value}.lock`, { timeoutMs: this.lockTimeoutMs });
    if (!lock.ok) return lock;
    try {
      if (fs.existsSync(target.value)) {
        return err(runtimeError('E_ALREADY_EXISTS', 'Contract state already exists', { key }));
      }
      try { this.validateValue?.(initial); } catch (error) {
        return contractReadError(key, error);
      }
      const snapshot: ContractSnapshotV1<T> = {
        store_kind: this.storeKind,
        schema_version: this.schemaVersion,
        revision: 0,
        value: initial,
      };
      atomicWriteContractBytes(target.value, canonicalBytesV1(snapshot), { nextRevision: 0 });
      return ok(snapshot);
    } finally {
      releaseOwnerLock(lock.value);
    }
  }

  read(key: string): Result<ContractSnapshotV1<T>, RuntimeError> {
    const target = resolveStateKey(this.root, key);
    return target.ok ? this.readPath(target.value, key) : target;
  }

  async compareAndSwap(
    key: string,
    expectedRevision: number,
    mutate: (current: Readonly<T>, snapshot: Readonly<ContractSnapshotV1<T>>) => T,
  ): Promise<Result<ContractSnapshotV1<T>, RuntimeError>> {
    const target = resolveStateKey(this.root, key);
    if (!target.ok) return target;
    const lock = await acquireOwnerLock(`${target.value}.lock`, { timeoutMs: this.lockTimeoutMs });
    if (!lock.ok) return lock;
    try {
      const current = this.readPath(target.value, key);
      if (!current.ok) return current;
      if (current.value.revision !== expectedRevision) {
        return err(runtimeError('E_REVISION_CONFLICT', 'Contract state revision changed', {
          key, expectedRevision, actualRevision: current.value.revision,
        }));
      }
      let nextValue: T;
      try {
        nextValue = mutate(current.value.value, current.value);
        this.validateValue?.(nextValue);
      } catch (error) {
        return contractReadError(key, error);
      }
      const next: ContractSnapshotV1<T> = {
        ...current.value,
        revision: current.value.revision + 1,
        value: nextValue,
      };
      atomicWriteContractBytes(target.value, canonicalBytesV1(next), {
        expectedRevision,
        nextRevision: next.revision,
      });
      return ok(next);
    } finally {
      releaseOwnerLock(lock.value);
    }
  }

  private readPath(target: string, key: string): Result<ContractSnapshotV1<T>, RuntimeError> {
    if (!fs.existsSync(target)) return err(runtimeError('E_NOT_FOUND', 'Contract state does not exist', { key }));
    try {
      const source = fs.readFileSync(target, 'utf8');
      if (source.endsWith('\n') || source.endsWith('\r')) throw new Error('contract bytes contain trailing newline');
      const parsed = JSON.parse(source) as unknown;
      assertVersionedStore(parsed, this.storeKind, this.schemaVersion);
      assertExactObjectKeys(
        parsed as Record<string, unknown>,
        ['store_kind', 'schema_version', 'revision', 'value'],
        'contract state snapshot',
      );
      const candidate = parsed as unknown as ContractSnapshotV1<unknown>;
      if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 0) {
        throw new Error('contract revision is invalid');
      }
      this.validateValue?.(candidate.value);
      // Re-canonicalization rejects alternate JSON bytes before they can become
      // signed/projection authority.
      if (!canonicalBytesV1(candidate).equals(Buffer.from(source, 'utf8'))) {
        throw new Error('contract state bytes are not canonical JSON v1');
      }
      return ok(candidate as ContractSnapshotV1<T>);
    } catch (error) {
      return contractReadError(key, error);
    }
  }
}

function resolveStateKey(root: string, key: string): Result<string, RuntimeError> {
  if (key === '' || key.includes('\0') || path.isAbsolute(key)) {
    return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State key must be a non-empty relative path', { key }));
  }
  const normalized = path.normalize(key);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State key escapes the state root', { key }));
  }
  return ensureContainedPath(root, `${normalized}.json`);
}

function contractReadError<T>(key: string, error: unknown): Result<T, RuntimeError> {
  const code = error instanceof ContractViolation && error.code === 'E_FUTURE_SCHEMA'
    ? 'E_FUTURE_SCHEMA' : 'E_CORRUPT_STATE';
  return err(runtimeError(code, 'Contract state is invalid', {
    key,
    cause: error instanceof Error ? error.message : String(error),
  }));
}

export class StateStore<T> {
  readonly root: string;
  readonly schemaVersion: number;
  private readonly lockTimeoutMs: number;

  constructor(root: string, options: StateStoreOptions = {}) {
    this.root = path.resolve(root);
    this.schemaVersion = options.schemaVersion ?? 1;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  }

  async create(key: string, initial: T): Promise<Result<Snapshot<T>, RuntimeError>> {
    const target = this.resolveKey(key);
    if (!target.ok) return target;
    const lock = await acquireOwnerLock(`${target.value}.lock`, { timeoutMs: this.lockTimeoutMs });
    if (!lock.ok) return lock;

    try {
      if (fs.existsSync(target.value)) {
        return err(runtimeError('E_ALREADY_EXISTS', 'State already exists', { key }));
      }
      const snapshot: Snapshot<T> = {
        schemaVersion: this.schemaVersion,
        revision: 0,
        value: initial,
      };
      atomicWriteJson(target.value, snapshot, { nextRevision: 0 });
      return ok(snapshot);
    } finally {
      releaseOwnerLock(lock.value);
    }
  }

  read(key: string): Result<Snapshot<T>, RuntimeError> {
    const target = this.resolveKey(key);
    if (!target.ok) return target;
    return this.readPath(target.value, key);
  }

  async compareAndSwap(
    key: string,
    expectedRevision: number,
    mutate: StateMutator<T>,
  ): Promise<Result<Snapshot<T>, RuntimeError>> {
    const target = this.resolveKey(key);
    if (!target.ok) return target;
    const lock = await acquireOwnerLock(`${target.value}.lock`, { timeoutMs: this.lockTimeoutMs });
    if (!lock.ok) return lock;

    try {
      const current = this.readPath(target.value, key);
      if (!current.ok) return current;
      if (current.value.revision !== expectedRevision) {
        return err(runtimeError('E_REVISION_CONFLICT', 'State revision changed', {
          key,
          expectedRevision,
          actualRevision: current.value.revision,
        }));
      }
      let nextValue: T;
      try {
        nextValue = mutate(current.value.value, current.value);
      } catch (error) {
        return err(runtimeError('E_CORRUPT_STATE', 'State mutator failed', {
          key,
          cause: error instanceof Error ? error.message : String(error),
        }));
      }
      const next: Snapshot<T> = {
        schemaVersion: this.schemaVersion,
        revision: current.value.revision + 1,
        value: nextValue,
      };
      atomicWriteJson(target.value, next, {
        expectedRevision,
        nextRevision: next.revision,
      });
      return ok(next);
    } finally {
      releaseOwnerLock(lock.value);
    }
  }

  private resolveKey(key: string): Result<string, RuntimeError> {
    if (key === '' || key.includes('\0') || path.isAbsolute(key)) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State key must be a non-empty relative path', { key }));
    }
    const normalized = path.normalize(key);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State key escapes the state root', { key }));
    }
    const target = path.resolve(this.root, `${normalized}.json`);
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State key escapes the state root', { key }));
    }
    return ok(target);
  }

  private readPath(target: string, key: string): Result<Snapshot<T>, RuntimeError> {
    if (!fs.existsSync(target)) {
      return err(runtimeError('E_NOT_FOUND', 'State does not exist', { key }));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (error) {
      return err(runtimeError('E_CORRUPT_STATE', 'State JSON is corrupt', {
        key,
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return err(runtimeError('E_CORRUPT_STATE', 'State snapshot must be an object', { key }));
    }
    const candidate = parsed as Partial<Snapshot<T>>;
    if (typeof candidate.schemaVersion !== 'number') {
      return err(runtimeError('E_CORRUPT_STATE', 'State schemaVersion is missing', { key }));
    }
    if (candidate.schemaVersion > this.schemaVersion) {
      return err(runtimeError('E_FUTURE_SCHEMA', 'State schema is newer than this runtime', {
        key,
        schemaVersion: candidate.schemaVersion,
        supportedSchemaVersion: this.schemaVersion,
      }));
    }
    if (
      candidate.schemaVersion !== this.schemaVersion
      || !Number.isInteger(candidate.revision)
      || (candidate.revision as number) < 0
      || !Object.prototype.hasOwnProperty.call(candidate, 'value')
    ) {
      return err(runtimeError('E_CORRUPT_STATE', 'State snapshot shape is invalid', { key }));
    }
    return ok(candidate as Snapshot<T>);
  }
}
