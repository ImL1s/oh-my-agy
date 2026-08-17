import * as fs from 'fs';
import * as path from 'path';
import { appendJsonLineUnderLock, withDurableJsonLineLock } from '../runtime/atomic';
import { fingerprintSecret, redactValue } from '../runtime/redaction';

/**
 * 設計概念映射：OMX 把 hook 診斷收在 `omx hooks status|validate|test` 後面而非 always-on
 * 寫檔；OMG `omg_cli/redaction.py` 對所有輸出做 bounded + redacted。
 *
 * OMA 的取捨：
 * - 預設**完全不寫**，需以 `OMA_HOOK_DEBUG=1` 明確開啟。
 * - 只寫 `<state-root>/logs/hook-debug.jsonl`；**絕不**寫入安裝目錄
 *   （舊版會寫 package root 底下的 `.omx/artifacts/`，那既是別的專案的目錄名，
 *   也讓全域安裝在唯讀掛載或多使用者環境下每個 turn 都嘗試寫安裝目錄）。
 * - bounded ring：超過上限時裁掉最舊的整行，避免無限成長。
 * 安全：不寫明文 OMA_LAUNCH_NONCE；payload 只記 allowlist 欄位。
 */

/** 診斷檔上限；超過時由檔頭裁掉整行。 */
export const HOOK_DEBUG_MAX_BYTES_V1 = 1_048_576;

/** 是否啟用 hook 診斷寫檔。未設或非 `1`/`true` 一律關閉。 */
export function hookDebugEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = environment.OMA_HOOK_DEBUG;
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/**
 * 解析診斷檔路徑。只認 `OMA_STATE_ROOT`；沒有可解析的 state root 就不寫，
 * 而不是退回安裝目錄。
 */
export function hookDebugTarget(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const stateRoot = environment.OMA_STATE_ROOT;
  if (typeof stateRoot !== 'string' || stateRoot.trim() === '') return null;
  return path.join(stateRoot, 'logs', 'hook-debug.jsonl');
}

export function writeHookDebug(event: string, payload: unknown): void {
  if (!hookDebugEnabled()) return;
  const target = hookDebugTarget();
  if (target === null) return;
  const record = {
    store_kind: 'hook_debug_event',
    schema_version: 1,
    ts: new Date().toISOString(),
    event,
    pid: process.pid,
    cwd: process.cwd(),
    env: {
      OMA_SESSION_ID: process.env.OMA_SESSION_ID ?? null,
      OMA_LAUNCH_NONCE_FP: process.env.OMA_LAUNCH_NONCE
        ? fingerprintSecret(process.env.OMA_LAUNCH_NONCE) : null,
      OMA_INVOCATION_GENERATION: process.env.OMA_INVOCATION_GENERATION ?? null,
      OMA_STATE_ROOT: process.env.OMA_STATE_ROOT ?? null,
      OMA_PACKAGE_ROOT: process.env.OMA_PACKAGE_ROOT ?? null,
      OMA_WORKSPACE_PATH: process.env.OMA_WORKSPACE_PATH ?? null,
    },
    payload: redactValue(redactPayload(payload)),
  };
  try {
    // append 與 ring 裁切必須在**同一個鎖內**：若 trim 在鎖外，兩個並行的 hook
    // process 可能同時讀檔、各自寫 temp、再依序 rename，後者會覆蓋掉前者剛 append
    // 的紀錄；append 與 trim 交錯也會有同樣的遺失。共用鎖後，temp 檔名的唯一性也
    // 不再依賴 pid（同一時間只有一個持鎖者）。
    withDurableJsonLineLock(target, () => {
      appendJsonLineUnderLock(target, record);
      trimHookDebugRing(target, HOOK_DEBUG_MAX_BYTES_V1);
    }, { lockTimeoutMs: 250 });
  } catch {
    // 不阻斷 hook
  }
}

/**
 * 由檔頭裁掉整行，直到大小落在上限內。永遠以行邊界切割，
 * 因此最後一行必定仍是完整可解析的 JSON。
 */
export function trimHookDebugRing(target: string, maxBytes: number): void {
  let size: number;
  try {
    size = fs.statSync(target).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  const content = fs.readFileSync(target);
  // 保留尾端 maxBytes，再往後推到第一個換行之後，避免留下半行。
  let start = content.length - maxBytes;
  const newlineIndex = content.indexOf(0x0a, start);
  start = newlineIndex === -1 ? content.length : newlineIndex + 1;
  const kept = content.subarray(start);
  const temporary = `${target}.trim.${process.pid}`;
  fs.writeFileSync(temporary, kept, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function redactPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map((item) => redactPayload(item));
  const input = payload as Record<string, unknown>;
  // 允許的診斷鍵；避免整包 stdin / 明文 capability 落盤
  const allow = [
    'conversationId',
    'executionNum',
    'invocationNum',
    'invocationGeneration',
    'terminationReason',
    'fullyIdle',
    'modelName',
    'workspacePaths',
    'workspaceKeys',
    'workspaceKey',
    'source',
    'path',
    'ok',
    'bindingRoute',
    'sessionId',
    'decision',
    'kind',
    'revision',
    'injectSteps',
    'message',
    'code',
    'out',
    'error',
  ] as const;
  const out: Record<string, unknown> = {};
  for (const key of allow) {
    if (key in input) out[key] = input[key];
  }
  // RuntimeError 形狀
  if (typeof input.message === 'string' && !('message' in out)) out.message = input.message;
  if (typeof input.code === 'string' && !('code' in out)) out.code = input.code;
  // 若完全不是已知形狀，只記 keys
  if (Object.keys(out).length === 0) {
    return { keys: Object.keys(input).slice(0, 32) };
  }
  return out;
}
