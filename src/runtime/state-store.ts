import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson } from './atomic';
import { RuntimeError, runtimeError } from './errors';
import { acquireOwnerLock, releaseOwnerLock } from './lock';
import { Result, Snapshot, err, ok } from './types';

export type StateMutator<T> = (
  current: Readonly<T>,
  snapshot: Readonly<Snapshot<T>>,
) => T;

export interface StateStoreOptions {
  schemaVersion?: number;
  lockTimeoutMs?: number;
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

