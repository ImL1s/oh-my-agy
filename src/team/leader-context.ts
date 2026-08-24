/**
 * 設計概念映射：OMX `.omx/state/team/<name>/preflight-context.json` 壓縮安全脈絡、
 * OMG `RESUME.md` 續傳包。OMA 在 team 目錄寫有界且經中央 redaction 的
 * `leader-context.json`，供回歸 leader 讀取；不含 claim token 明文，禁止 git。
 */
import * as path from 'path';
import { atomicWriteFile, canonicalJson, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { assertRedacted, redactValue } from '../runtime/redaction';
import { Result, err, ok } from '../runtime/types';

export const LEADER_CONTEXT_FILE_NAME = 'leader-context.json';
/** 有界脈絡上限（位元組）；超出則改寫 truncated 摘要或 UTF-8 截斷。 */
export const LEADER_CONTEXT_MAX_BYTES = 16_384;

export interface TeamLeaderContextWorkerRefV1 {
  taskId: string;
  generation: number;
}

export interface TeamLeaderContextFencedRefV1 extends TeamLeaderContextWorkerRefV1 {
  reason: 'block_identity_unproven' | 'fence_stale_observation';
}

export interface TeamLeaderContextV1 {
  schemaVersion: 1;
  store_kind: 'team_leader_context';
  teamId: string;
  revision: number;
  supervisorGeneration: number;
  recordedAtMs: number;
  truncated?: true;
  adopted: readonly TeamLeaderContextWorkerRefV1[];
  fenced: readonly TeamLeaderContextFencedRefV1[];
  reclaimable: readonly TeamLeaderContextWorkerRefV1[];
}

export function leaderContextPath(teamDirectory: string): string {
  return path.join(teamDirectory, LEADER_CONTEXT_FILE_NAME);
}

/**
 * 寫入有界、已 redaction 的 leader-context.json（atomic rename）。
 * 設計概念映射：OMC/OMX resume 脈絡不得攜帶明文 secret，亦不得無上限膨脹。
 */
export function writeBoundedLeaderContext(
  targetPath: string,
  value: unknown,
  maxBytes: number = LEADER_CONTEXT_MAX_BYTES,
): Result<{ bytes: number; truncated: boolean }, RuntimeError> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'leader-context max bytes is invalid'));
  }
  try {
    const packed = packLeaderContextBytes(value, maxBytes);
    atomicWriteFile(targetPath, packed.bytes, { mode: 0o600 });
    return ok({ bytes: packed.bytes.length, truncated: packed.truncated });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('E_REDACTION_UNSAFE')) {
      return err(runtimeError('E_REDACTION_UNSAFE', 'leader-context.json failed redaction'));
    }
    return err(runtimeError('E_CORRUPT_STATE', 'leader-context.json could not be written', {
      cause: message,
    }));
  }
}

function packLeaderContextBytes(
  value: unknown,
  maxBytes: number,
): { bytes: Buffer; truncated: boolean } {
  const redacted = redactValue(value, {
    maxDepth: 6,
    maxEntries: 48,
    maxStringBytes: 256,
  });
  assertRedacted(redacted);
  const canonical = `${canonicalJson(redacted)}\n`;
  const full = Buffer.from(canonical, 'utf8');
  if (full.length <= maxBytes) return { bytes: full, truncated: false };

  const compact = redactValue(compactLeaderContext(redacted, canonical), {
    maxDepth: 4,
    maxEntries: 16,
    maxStringBytes: 128,
  });
  assertRedacted(compact);
  const compactBytes = Buffer.from(`${canonicalJson(compact)}\n`, 'utf8');
  if (compactBytes.length <= maxBytes) return { bytes: compactBytes, truncated: true };
  return { bytes: truncateUtf8(compactBytes, maxBytes), truncated: true };
}

function compactLeaderContext(value: unknown, originalCanonical: string): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  return {
    schemaVersion: 1,
    store_kind: 'team_leader_context',
    truncated: true,
    teamId: typeof record.teamId === 'string' ? record.teamId : 'unknown',
    revision: typeof record.revision === 'number' ? record.revision : 0,
    supervisorGeneration: typeof record.supervisorGeneration === 'number'
      ? record.supervisorGeneration
      : 0,
    recordedAtMs: typeof record.recordedAtMs === 'number' ? record.recordedAtMs : 0,
    digest: sha256(originalCanonical),
    adoptedCount: Array.isArray(record.adopted) ? record.adopted.length : 0,
    fencedCount: Array.isArray(record.fenced) ? record.fenced.length : 0,
    reclaimableCount: Array.isArray(record.reclaimable) ? record.reclaimable.length : 0,
  };
}

function truncateUtf8(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
