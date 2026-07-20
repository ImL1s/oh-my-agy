import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 設計概念映射：live hook 是否被 host 呼叫必須有 durable 證據；
 * 寫入 OMA_STATE_ROOT 與 package .omx/artifacts，避免猜。
 * 安全：不寫明文 OMA_LAUNCH_NONCE；payload 只記 allowlist 欄位。
 */
export function writeHookDebug(event: string, payload: unknown): void {
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    event,
    pid: process.pid,
    cwd: process.cwd(),
    env: {
      OMA_SESSION_ID: process.env.OMA_SESSION_ID ?? null,
      OMA_LAUNCH_NONCE_FP: fingerprintSecret(process.env.OMA_LAUNCH_NONCE),
      OMA_INVOCATION_GENERATION: process.env.OMA_INVOCATION_GENERATION ?? null,
      OMA_STATE_ROOT: process.env.OMA_STATE_ROOT ?? null,
      OMA_PACKAGE_ROOT: process.env.OMA_PACKAGE_ROOT ?? null,
      OMA_WORKSPACE_PATH: process.env.OMA_WORKSPACE_PATH ?? null,
    },
    payload: redactPayload(payload),
  })}\n`;
  const targets = new Set<string>();
  if (process.env.OMA_STATE_ROOT) {
    targets.add(path.join(process.env.OMA_STATE_ROOT, 'hook-debug.jsonl'));
  }
  if (process.env.OMA_PACKAGE_ROOT) {
    targets.add(path.join(process.env.OMA_PACKAGE_ROOT, '.omx', 'artifacts', 'hook-debug.jsonl'));
  }
  // 從 compiled hook 位置回推 package root：dist/src/hooks -> ../../../
  try {
    const packageRoot = path.resolve(__dirname, '../../..');
    targets.add(path.join(packageRoot, '.omx', 'artifacts', 'hook-debug.jsonl'));
  } catch {
    // ignore
  }
  for (const target of targets) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.appendFileSync(target, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // 不阻斷 hook
    }
  }
}

function fingerprintSecret(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
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
