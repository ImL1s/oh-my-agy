import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import { JsonValue } from './types';

export type AtomicFaultPoint =
  | 'record-only-candidate'
  | 'state-only-candidate'
  | 'temp-fsync-before-rename'
  | 'rename-before-reply';

export interface AtomicFaultContext {
  targetPath: string;
  transactionId: string;
  expectedRevision?: number;
  nextRevision?: number;
}

export interface FaultInjector {
  inject(point: AtomicFaultPoint, context: Readonly<AtomicFaultContext>): void;
}

export const NO_FAULTS: FaultInjector = {
  inject: () => undefined,
};

function canonicalize(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Canonical JSON rejects cyclic values');
    seen.add(value);
    const result = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new TypeError('Canonical JSON rejects cyclic values');
    seen.add(object);
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(object).sort()) {
      const child = object[key];
      if (child !== undefined) result[key] = canonicalize(child, seen);
    }
    seen.delete(object);
    return result;
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export interface AtomicWriteOptions {
  mode?: number;
  transactionId?: string;
  expectedRevision?: number;
  nextRevision?: number;
  faultInjector?: FaultInjector;
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function atomicWriteFile(
  targetPath: string,
  bytes: Buffer,
  options: AtomicWriteOptions = {},
): void {
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const transactionId = options.transactionId ?? crypto.randomBytes(16).toString('hex');
  const tempPath = path.join(directory, `.${path.basename(targetPath)}.${transactionId}.tmp`);
  const context: AtomicFaultContext = {
    targetPath,
    transactionId,
    expectedRevision: options.expectedRevision,
    nextRevision: options.nextRevision,
  };
  let descriptor: number | undefined;
  let renamed = false;

  try {
    descriptor = fs.openSync(tempPath, 'wx', options.mode ?? 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    options.faultInjector?.inject('temp-fsync-before-rename', context);
    fs.renameSync(tempPath, targetPath);
    renamed = true;
    fs.chmodSync(targetPath, options.mode ?? 0o600);
    fsyncDirectory(directory);
    options.faultInjector?.inject('rename-before-reply', context);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (!renamed && fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

export function atomicWriteJson(
  targetPath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): void {
  atomicWriteFile(targetPath, Buffer.from(`${canonicalJson(value)}\n`, 'utf8'), options);
}

/**
 * W0 contract bytes are already canonicalized by `canonicalBytesV1`.  This
 * entrypoint deliberately does not append the legacy newline used by
 * `atomicWriteJson`, so signatures and content hashes bind the exact bytes.
 */
export function atomicWriteContractBytes(
  targetPath: string,
  bytes: Buffer,
  options: AtomicWriteOptions = {},
): void {
  if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a || bytes[bytes.length - 1] === 0x0d) {
    throw new TypeError('Canonical contract bytes must be non-empty and must not have a trailing newline');
  }
  atomicWriteFile(targetPath, bytes, { ...options, mode: options.mode ?? 0o600 });
}

/** Write a content-addressed recovery source and make it immutable to the owner. */
export function writeImmutableFile(targetPath: string, bytes: Buffer): void {
  assertNoSymlinkComponents(targetPath);
  if (fs.existsSync(targetPath)) {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Immutable recovery target must be a regular non-symlink file');
    }
    const existing = fs.readFileSync(targetPath);
    if (!existing.equals(bytes)) throw new Error('Immutable recovery path already contains different bytes');
    fs.chmodSync(targetPath, 0o400);
    return;
  }
  atomicWriteFile(targetPath, bytes, { mode: 0o400 });
}

export interface DurableJsonLineOptions {
  lockTimeoutMs?: number;
  staleAfterMs?: number;
}

/** Hold the same cooperative per-stream lock used by durable JSONL append. */
export function withDurableJsonLineLock<T>(
  targetPath: string,
  callback: () => T,
  options: DurableJsonLineOptions = {},
): T {
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const lockPath = `${targetPath}.append.lock`;
  const token = crypto.randomBytes(16).toString('hex');
  const started = Date.now();
  const timeoutMs = options.lockTimeoutMs ?? 5_000;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  let locked = false;
  while (!locked) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        token,
        pid: process.pid,
        createdAtMs: Date.now(),
      }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      locked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      tryReapAppendLock(lockPath, staleAfterMs);
      if (Date.now() - started > timeoutMs) throw new Error('Durable JSONL append lock timed out');
      synchronousSleep(5);
    }
  }

  try {
    return callback();
  } finally {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as { token?: string };
      if (owner.token === token) fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // A missing/mismatched lock fails closed by leaving any evidence behind.
    }
  }
}

/** Caller must hold `withDurableJsonLineLock(targetPath, ...)`. */
export function appendJsonLineUnderLock(targetPath: string, value: unknown): void {
  const directory = path.dirname(targetPath);
  let descriptor: number | undefined;
  try {
    const line = Buffer.concat([canonicalBytesV1(value), Buffer.from('\n', 'utf8')]);
    descriptor = fs.openSync(
      targetPath,
      fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY,
      0o600,
    );
    const written = fs.writeSync(descriptor, line, 0, line.length);
    if (written !== line.length) throw new Error('Durable JSONL append was not one complete write');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(targetPath, 0o600);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/**
 * Append one complete JSONL record with one O_APPEND write and fsync.  A
 * per-stream owner record prevents interleaving across hook processes.
 */
export function appendJsonLineDurable(
  targetPath: string,
  value: unknown,
  options: DurableJsonLineOptions = {},
): void {
  withDurableJsonLineLock(targetPath, () => appendJsonLineUnderLock(targetPath, value), options);
}

function synchronousSleep(milliseconds: number): void {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, milliseconds);
}

function tryReapAppendLock(lockPath: string, staleAfterMs: number): void {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as {
      pid?: number;
      createdAtMs?: number;
    };
    if (!Number.isSafeInteger(owner.pid) || !Number.isSafeInteger(owner.createdAtMs)
      || Date.now() - (owner.createdAtMs as number) <= staleAfterMs) return;
    try {
      process.kill(owner.pid as number, 0);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
    }
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Corrupt locks are not reaped without dead-owner proof.
  }
}

function assertNoSymlinkComponents(targetPath: string): void {
  const absolute = path.resolve(targetPath);
  let ancestor = absolute;
  const suffix: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) {
    throw new Error('Immutable recovery path contains a symbolic-link component');
  }
  let cursor = ancestor;
  for (const segment of suffix) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) continue;
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error('Immutable recovery path contains a symbolic-link component');
    }
  }
}
