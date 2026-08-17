/**
 * hook 診斷寫檔契約。設計概念映射：OMX 把 hook 診斷收在明確的觀測命令後面、
 * OMG 對所有輸出做 bounded + redacted。
 *
 * 這組測試存在的理由：舊版無條件在每次 hook 觸發時寫檔，其中兩個目標是
 * **安裝目錄**底下、而且用了別的專案的目錄名（`.omx`）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HOOK_DEBUG_MAX_BYTES_V1,
  hookDebugEnabled,
  hookDebugTarget,
  trimHookDebugRing,
  writeHookDebug,
} from '../../src/hooks/debug-log';

const packageRoot = path.resolve(__dirname, '../..');

function withEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return run();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** 遞迴列出目錄下所有檔案的相對路徑。 */
function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full).map((child) => path.join(entry.name, child)));
    else out.push(entry.name);
  }
  return out;
}

describe('hook debug logging', () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-hook-debug-'));
  });

  afterEach(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  test('is disabled unless OMA_HOOK_DEBUG is explicitly 1 or true', () => {
    for (const value of [undefined, '', '0', 'false', 'yes', 'on', '2']) {
      expect(hookDebugEnabled({ OMA_HOOK_DEBUG: value } as NodeJS.ProcessEnv)).toBe(false);
    }
    for (const value of ['1', 'true', 'TRUE', ' True ']) {
      expect(hookDebugEnabled({ OMA_HOOK_DEBUG: value } as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  test('writes nothing at all when the gate is off', () => {
    withEnv({ OMA_HOOK_DEBUG: undefined, OMA_STATE_ROOT: stateRoot }, () => {
      writeHookDebug('preinvocation.start', { ok: true });
    });
    expect(listFiles(stateRoot)).toEqual([]);
  });

  test('writes only to <state-root>/logs/hook-debug.jsonl when enabled', () => {
    withEnv({ OMA_HOOK_DEBUG: '1', OMA_STATE_ROOT: stateRoot }, () => {
      writeHookDebug('preinvocation.start', { ok: true, sessionId: 'session-1' });
    });
    expect(listFiles(stateRoot)).toEqual([path.join('logs', 'hook-debug.jsonl')]);
    const body = fs.readFileSync(path.join(stateRoot, 'logs', 'hook-debug.jsonl'), 'utf8');
    const record = JSON.parse(body.trim());
    expect(record.store_kind).toBe('hook_debug_event');
    expect(record.event).toBe('preinvocation.start');
    expect(record.payload).toMatchObject({ ok: true, sessionId: 'session-1' });
  });

  test('never resolves a target outside the state root, and never falls back to the package root', () => {
    expect(hookDebugTarget({ OMA_STATE_ROOT: stateRoot } as NodeJS.ProcessEnv))
      .toBe(path.join(stateRoot, 'logs', 'hook-debug.jsonl'));
    // 沒有 state root 就沒有目標；不得退回安裝目錄（舊版會寫 package root 下的 .omx/）
    for (const environment of [{}, { OMA_STATE_ROOT: '' }, { OMA_STATE_ROOT: '   ' },
      { OMA_PACKAGE_ROOT: packageRoot }]) {
      expect(hookDebugTarget(environment as NodeJS.ProcessEnv)).toBeNull();
    }
  });

  test('does not throw when the gate is on but no state root resolves', () => {
    withEnv({ OMA_HOOK_DEBUG: '1', OMA_STATE_ROOT: undefined, OMA_PACKAGE_ROOT: packageRoot }, () => {
      expect(() => writeHookDebug('stop.start', { ok: false })).not.toThrow();
    });
  });

  /**
   * 結構性斷言，而非行為斷言。理由：舊版用 `path.resolve(__dirname, '../../..')`
   * 推導安裝目錄，而該路徑在 ts-jest（跑 src/）與編譯後（跑 dist/）指向**不同**位置，
   * 所以「檢查某個具體目錄有沒有長出檔案」的行為測試會漏掉真正的 regression ——
   * 實測確認過：把舊的 fallback 加回去，行為測試仍全綠。
   * 直接封死來源寫法才是可靠的守門。
   */
  test('the writer never targets an install-relative path or the .omx directory name', () => {
    const raw = fs.readFileSync(path.join(packageRoot, 'src', 'hooks', 'debug-log.ts'), 'utf8');
    // 只檢查程式碼；註解本來就會提到舊行為（`.omx`）以說明為何不能再那樣做。
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(code).toContain('hookDebugTarget');
    // `.omx` 是 oh-my-codex 的目錄名；OMA 的慣例是 `.agy`
    expect(code).not.toMatch(/\.omx/);
    // 由 __dirname 回推安裝目錄會寫進套件安裝位置（唯讀掛載、多使用者安裝下會失敗）
    expect(code).not.toMatch(/path\.resolve\(\s*__dirname/);
    // OMA_PACKAGE_ROOT 只能被「記錄」，不得用來組出寫入路徑
    expect(code).not.toMatch(/path\.join\([^)]*OMA_PACKAGE_ROOT/);
  });

  /**
   * append 與 ring 裁切必須在同一個鎖內。若 trim 落在鎖外，兩個並行的 hook process
   * 會各自讀檔、各自寫 temp、再依序 rename，後者覆蓋前者剛 append 的紀錄。
   * 這用結構性斷言守：真正的並行競態無法在單一 jest process 內穩定重現，
   * 而「trim 是否在鎖的 callback 內」是可以直接檢查的。
   */
  test('the append and the ring trim happen inside one lock', () => {
    const raw = fs.readFileSync(path.join(packageRoot, 'src', 'hooks', 'debug-log.ts'), 'utf8');
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    // 不得使用會自行取鎖的 appendJsonLineDurable（那會讓 trim 落在鎖外）
    expect(code).not.toMatch(/appendJsonLineDurable/);
    const lockCall = /withDurableJsonLineLock\(\s*target\s*,\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,/.exec(code);
    expect(lockCall).not.toBeNull();
    const insideLock = lockCall?.[1] ?? '';
    expect(insideLock).toMatch(/appendJsonLineUnderLock\(/);
    expect(insideLock).toMatch(/trimHookDebugRing\(/);
  });

  test('redacts the launch nonce to a fingerprint and never writes it in clear text', () => {
    const nonce = 'super-secret-launch-nonce-value';
    withEnv({
      OMA_HOOK_DEBUG: '1',
      OMA_STATE_ROOT: stateRoot,
      OMA_LAUNCH_NONCE: nonce,
    }, () => {
      writeHookDebug('preinvocation.bound', { ok: true });
    });
    const body = fs.readFileSync(path.join(stateRoot, 'logs', 'hook-debug.jsonl'), 'utf8');
    expect(body).not.toContain(nonce);
    const record = JSON.parse(body.trim());
    expect(typeof record.env.OMA_LAUNCH_NONCE_FP).toBe('string');
    expect(record.env.OMA_LAUNCH_NONCE_FP).not.toBe(nonce);
  });

  test('trims from the head on a line boundary so the newest record stays parseable', () => {
    const target = path.join(stateRoot, 'logs', 'hook-debug.jsonl');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const lines: string[] = [];
    for (let index = 0; index < 400; index += 1) {
      lines.push(JSON.stringify({ seq: index, filler: 'x'.repeat(200) }));
    }
    fs.writeFileSync(target, `${lines.join('\n')}\n`);
    const originalSize = fs.statSync(target).size;
    const limit = 20_000;
    expect(originalSize).toBeGreaterThan(limit);

    trimHookDebugRing(target, limit);

    const trimmed = fs.readFileSync(target, 'utf8');
    expect(fs.statSync(target).size).toBeLessThanOrEqual(limit);
    // 每一行都必須仍是完整 JSON —— 裁切點必須落在行邊界
    const kept = trimmed.split('\n').filter((line) => line !== '');
    for (const line of kept) expect(() => JSON.parse(line)).not.toThrow();
    // 保留的是最新的紀錄，不是最舊的
    expect(JSON.parse(kept[kept.length - 1]).seq).toBe(399);
    expect(JSON.parse(kept[0]).seq).toBeGreaterThan(0);
  });

  test('leaves a file already under the limit untouched', () => {
    const target = path.join(stateRoot, 'logs', 'hook-debug.jsonl');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify({ seq: 1 })}\n`);
    const before = fs.readFileSync(target);
    trimHookDebugRing(target, HOOK_DEBUG_MAX_BYTES_V1);
    expect(fs.readFileSync(target)).toEqual(before);
  });

  test('repeated writes stay bounded by the ring limit', () => {
    const target = path.join(stateRoot, 'logs', 'hook-debug.jsonl');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${'y'.repeat(HOOK_DEBUG_MAX_BYTES_V1 + 5_000)}\n`);
    withEnv({ OMA_HOOK_DEBUG: '1', OMA_STATE_ROOT: stateRoot }, () => {
      writeHookDebug('stop.start', { ok: true });
    });
    expect(fs.statSync(target).size).toBeLessThanOrEqual(HOOK_DEBUG_MAX_BYTES_V1);
    const kept = fs.readFileSync(target, 'utf8').split('\n').filter((line) => line !== '');
    expect(JSON.parse(kept[kept.length - 1]).event).toBe('stop.start');
  });
});
