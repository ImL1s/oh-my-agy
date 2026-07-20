import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
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

