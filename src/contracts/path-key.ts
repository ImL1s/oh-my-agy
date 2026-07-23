import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ContractViolation } from './state-schemas';

export const SAFE_KEY_PATTERN = /^[0-9a-f]{64}$/;

export function validateExternalIdentifier(value: string, label = 'identifier'): void {
  if (value.length === 0) {
    throw new ContractViolation('E_UNSAFE_IDENTIFIER', `${label} must not be empty`);
  }
  for (const character of value) {
    const point = character.codePointAt(0) as number;
    if (point <= 0x1f || point === 0x7f || (point >= 0xd800 && point <= 0xdfff)) {
      throw new ContractViolation('E_UNSAFE_IDENTIFIER', `${label} contains a forbidden code point`);
    }
  }
}

export function safePathKey(value: string): string {
  validateExternalIdentifier(value);
  return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

export function assertSafePathKey(value: string): void {
  if (!SAFE_KEY_PATTERN.test(value)) {
    throw new ContractViolation('E_UNSAFE_PATH_KEY', 'Path key must be lowercase SHA-256 hex');
  }
}

function nearestExistingAncestor(input: string): { ancestor: string; suffix: string[] } {
  let ancestor = path.resolve(input);
  const suffix: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return { ancestor, suffix };
}

export function resolveConfinedPath(rootPath: string, relativePath: string): string {
  validateExternalIdentifier(relativePath, 'relativePath');
  if (path.isAbsolute(relativePath)) {
    throw new ContractViolation('E_PATH_OUTSIDE_ROOT', 'Path must be relative');
  }
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new ContractViolation('E_PATH_OUTSIDE_ROOT', 'Path escapes the root');
  }
  const rootInfo = nearestExistingAncestor(rootPath);
  const root = path.join(fs.realpathSync(rootInfo.ancestor), ...rootInfo.suffix);
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new ContractViolation('E_PATH_OUTSIDE_ROOT', 'Path escapes the root');
  }

  let cursor = root;
  for (const segment of normalized.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new ContractViolation('E_PATH_OUTSIDE_ROOT', 'Path contains a symbolic-link component', {
        entry: cursor,
      });
    }
  }
  return target;
}

export function safeRunRelativePath(runId: string, suffix: string): string {
  const runKey = safePathKey(runId);
  return path.join(runKey, suffix);
}
