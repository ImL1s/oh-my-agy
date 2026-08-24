#!/usr/bin/env node
/**
 * oh-my-agy CLI 進入點 (oma)
 * 
 * 設計概念映射：本模組實作了 Entrypoint CLI (oma)，負責解析命令列引數，
 * 攔截魔術關鍵字，並將未命中的一般指令透傳給實體 agy 程序。
 * 設計理念與結構參考了 oh-my-claudecode 中的 cli 進入點與 magic-keywords.ts 模組。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { checkContinuation, acquireLock, releaseLock } from '../src/enforcer';
import { ordinaryEnvironment } from '../src/cli/managed-invocation';
import { resolveLegacyStdio } from '../src/cli/legacy-stdio';
import { isStructuredNativeCommand } from '../src/cli/parser';

// 常用諮詢詞之正規表示式，用以過濾諮詢意圖，避免誤觸攔截
const INFORMATIONAL_INTENT_PATTERNS = [
  /what\s+is/i,
  /how\s+to\s+use/i,
  /如何使用/i,
  /解释/i,
  /解釋/i,
  /what\s+does/i,
  /explain/i,
  /meaning\s+of/i
];

/**
 * 移除 Markdown 程式碼區塊（包括多行與行內）以防範誤觸發
 * @param text 原始文字內容
 * @returns 移除程式碼區塊後的乾淨文字
 */
function removeCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[\s\S]*?`/g, '');
}

/**
 * 判定在關鍵字附近的 80 字元視窗內是否為諮詢意圖
 * @param keyword 命中的關鍵字
 * @param text 移除了程式碼區塊後的乾淨文字
 * @returns 若為諮詢意圖傳回 true，否則傳回 false
 */
function isInformationalIntent(keyword: string, text: string): boolean {
  const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return false;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + keyword.length + 40);
  const windowText = text.substring(start, end);
  return INFORMATIONAL_INTENT_PATTERNS.some(pattern => pattern.test(windowText));
}

/**
 * 判斷是否走結構化 CLI（Autopilot / Team / Setup / explicit managed modes）。
 *
 * 設計概念映射：
 * - `oma ralph -- <task>` → managed exact_env（結構化）
 * - `oma ralph <args…>` 無 `--` → legacy magic（e2e / 自然語言關鍵字相容；不注入 binding）
 * - 其餘透傳 → ordinaryEnvironment 剝除 managed binding env
 */
function shouldUseStructuredCli(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  const first = args[0];
  // bare `help`/`version` 仍透傳給 agy（e2e 與 legacy 相容）；只有 --help/-h/--version/-v 走 oma help。
  if ([
    '--help', '-h', '--version', '-v',
    'autopilot', 'team', 'setup', 'doctor', 'skill',
    'workflow', 'mcp-server', 'wiki', 'hud', 'session', 'cancel',
    'native-status', 'lsp-status', 'sidecar-status', 'notify',
    'resume', 'recovery', 'update', 'uninstall', 'parity', 'production',
  ].includes(first)) {
    return true;
  }
  if (isStructuredNativeCommand(args)) return true;
  // 明確 managed：mode 後必須有 `--` 分隔 task
  if (['ralph', 'ultrawork', 'search'].includes(first) && args.includes('--')) {
    return true;
  }
  return false;
}

/** 所有 legacy spawn 共用：剝除 managed binding，避免 capability 外洩到非 managed agy。 */
function childEnvWithPath(): NodeJS.ProcessEnv {
  const nodeBinDir = path.dirname(process.execPath);
  const extendedPath = nodeBinDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH || '');
  return {
    ...ordinaryEnvironment(process.env),
    PATH: extendedPath,
  };
}

async function main() {
  const args = process.argv.slice(2);

  // Always validate launcher-only flags vs owned first tokens (even when not launching).
  try {
    const { rejectLauncherFlagsAfterSubcommand } = await import('../src/cli/host-launch');
    rejectLauncherFlagsAfterSubcommand(args);
  } catch (error) {
    if (error && typeof error === 'object' && (error as { name?: string }).name === 'HostLaunchUsageError') {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exit((error as { exitCode?: number }).exitCode ?? 2);
    }
    throw error;
  }

  const todoPath = process.env.OMA_TODO_PATH || '.agy/todo.json';

  // 1. 啟動防禦與完成數記錄
  // 設計概念映射：此處使用與 Enforcer 相同的 Mutex 鎖機制保護 todo.json 的讀取，
  // 避免併發執行時解析到損壞的檔案。參考自 oh-my-openagent 的互斥訪問設計。
  let isTripped = false;
  let initialCompletedCount = 0;

  if (fs.existsSync(todoPath)) {
    const lockPath = todoPath + '.lock';
    try {
      await acquireLock(lockPath);
      if (fs.existsSync(todoPath)) {
        const content = fs.readFileSync(todoPath, 'utf8');
        if (content.trim() !== '') {
          const data = JSON.parse(content);
          if (data.status === 'tripped') {
            isTripped = true;
          }
          if (data.tasks && Array.isArray(data.tasks)) {
            initialCompletedCount = data.tasks.filter((t: any) => t.completed === true).length;
          }
        }
      }
    } catch (e) {
      // 忽略解析錯誤，後續交由 checkContinuation 完整處理
    } finally {
      releaseLock(lockPath);
    }
  }

  if (isTripped) {
    process.stderr.write('系統處於熔斷狀態\n[CIRCUIT BREAKER TRIPPED]\n');
    process.exit(1);
  }

  // Root host launch (OMX/Sol) after circuit-breaker, before structured/magic/continuation.
  // Ordinary argv stays on enforcer passthrough; only bare + launcher flags host-launch.
  try {
    const { shouldHostLaunch, runHostLaunch } = await import('../src/cli/host-launch');
    if (shouldHostLaunch(args)) {
      const code = await runHostLaunch(args, {});
      await checkContinuation(todoPath, initialCompletedCount, false);
      process.exit(code);
    }
  } catch (error) {
    if (error && typeof error === 'object' && (error as { name?: string }).name === 'HostLaunchUsageError') {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exit((error as { exitCode?: number }).exitCode ?? 2);
    }
    throw error;
  }

  // 結構化子命令（autopilot/team/setup 與 explicit mode --）走新 CLI wiring。
  // 自然語言魔術關鍵字路徑保留給既有 e2e 與 pass-through 行為。
  if (shouldUseStructuredCli(args)) {
    const { createDefaultServices } = await import('../src/cli/services');
    const { runCli } = await import('../src/cli/application');
    const configuredAgy = process.env.OMA_AGY_BIN?.trim();
    const code = await runCli(args, createDefaultServices(
      configuredAgy ? { agyCommand: configuredAgy } : {},
    ));
    process.exit(code);
  }

  const inputLine = args.join(' ');
  const cleanedLine = removeCodeBlocks(inputLine);

  // 3. 識別魔術關鍵字（優先順序：Ralph > Ultrawork > Search）
  const ralphRegex = /\bralph\b/i;
  const ultraworkRegex = /\b(ultrawork|uw|ulw)\b/i;
  const searchRegex = /\bsearch\b/i;

  let matchedMode: 'ralph' | 'ultrawork' | 'search' | null = null;
  let matchedKeyword = '';

  if (ralphRegex.test(cleanedLine)) {
    const kw = 'ralph';
    if (!isInformationalIntent(kw, cleanedLine)) {
      matchedMode = 'ralph';
      matchedKeyword = kw;
    }
  } else if (ultraworkRegex.test(cleanedLine)) {
    const match = cleanedLine.match(ultraworkRegex);
    if (match) {
      const kw = match[0];
      if (!isInformationalIntent(kw, cleanedLine)) {
        matchedMode = 'ultrawork';
        matchedKeyword = kw;
      }
    }
  } else if (searchRegex.test(cleanedLine)) {
    const kw = 'search';
    if (!isInformationalIntent(kw, cleanedLine)) {
      matchedMode = 'search';
      matchedKeyword = kw;
    }
  }

  // 4. 若命中模式，進行魔術攔截
  if (matchedMode) {
    // 剝離關鍵字，若其前有 'run'，亦一併剝離
    const remainingArgs: string[] = [];
    let i = 0;
    while (i < args.length) {
      const current = args[i].toLowerCase();
      const isTargetKeyword = current === matchedKeyword.toLowerCase() ||
        (matchedMode === 'ultrawork' && (current === 'ultrawork' || current === 'uw' || current === 'ulw'));

      if (isTargetKeyword) {
        if (remainingArgs.length > 0 && remainingArgs[remainingArgs.length - 1].toLowerCase() === 'run') {
          remainingArgs.pop();
        }
        i++;
      } else {
        remainingArgs.push(args[i]);
        i++;
      }
    }

    // 印出模式標誌與剝離後的剩餘引數
    const modePrompt = `[${matchedMode}-mode]`;
    if (remainingArgs.length > 0) {
      process.stdout.write(`${modePrompt} ${remainingArgs.join(' ')}\n`);
    } else {
      process.stdout.write(`${modePrompt}\n`);
    }

    // 執行實體 agy 子程序並同步等待 close（legacy magic：不注入 exact_env binding）
    // TTY-gated stdio：互動終端 inherit（對齊 OMX host launch / OMG 互動政策）；
    // 非 TTY（e2e/CI）保持 ignore。OMA_LEGACY_STDIO=inherit|ignore 可顯式覆寫。
    const legacyStdio = resolveLegacyStdio(process.env, Boolean(process.stdout.isTTY));

    const { guardDangerousArgv } = await import('../src/cli/dangerous-launch');
    const magicGuarded = await guardDangerousArgv(remainingArgs, {
      isTTY: Boolean(process.stdin.isTTY),
    });
    if (!magicGuarded.ok) {
      process.stderr.write(`${magicGuarded.error.code}: ${magicGuarded.error.message}\n`);
      process.exit(2);
    }
    const magicArgv = [...magicGuarded.value];

    let exitCode = 0;
    try {
      const child = spawn('agy', magicArgv, {
        stdio: legacyStdio,
        env: childEnvWithPath(),
      });

      // 註冊中斷信號 (SIGINT) 監聽器以轉發給子程序，避免背景程序洩漏
      const sigintHandler = () => {
        if (child.pid) {
          try {
            child.kill('SIGINT');
          } catch (e) {}
        }
      };
      process.on('SIGINT', sigintHandler);

      exitCode = await new Promise<number>((resolve) => {
        child.on('close', (code, signal) => {
          process.off('SIGINT', sigintHandler);
          resolve((code === 130 || signal === 'SIGINT') ? 130 : (code ?? 0));
        });
        child.on('error', (err) => {
          process.off('SIGINT', sigintHandler);
          resolve(1);
        });
      });
    } catch (e) {
      // 靜默忽略啟動錯誤
    }

    // 啟動任務延續檢驗，傳入 true 代表為魔術關鍵字攔截模式
    await checkContinuation(todoPath, initialCompletedCount, true);
    process.exit(exitCode);
  }

  // 5. 若無命中模式，正常進行指令透傳 (Pass-through)
  // 使用 spawn (而非 exec) 來防範 shell 命令注入漏洞
  // 宣告安全退出函式，確保大量資料 Buffer 透傳不被丟失
  function safeExit(exitCode: number) {
    let finished = 0;
    const done = () => {
      finished++;
      if (finished === 2) {
        // 額外延遲 200 毫秒，確保底層核心 pipe 中的資料被 parent 程序讀取完畢
        setTimeout(() => {
          process.exit(exitCode);
        }, 200);
      }
    };

    // 強制使用非同步寫入以等待前序緩衝區清空
    process.stdout.write('', () => done());
    process.stderr.write('', () => done());
  }

  // 5. 若無命中模式，正常進行指令透傳 (Pass-through)
  // 使用 spawn (而非 exec) 來防範 shell 命令注入漏洞；env 必剝 managed binding
  const timeoutMsStr = process.env.OMA_TIMEOUT_MS;
  const hasTimeout = timeoutMsStr && !isNaN(parseInt(timeoutMsStr, 10)) && parseInt(timeoutMsStr, 10) > 0;

  const spawnOptions: any = {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnvWithPath(),
  };

  if (hasTimeout) {
    spawnOptions.detached = true;
  }

  const { guardDangerousArgv: guardPassThrough } = await import('../src/cli/dangerous-launch');
  const passGuarded = await guardPassThrough(args, {
    isTTY: Boolean(process.stdin.isTTY),
  });
  if (!passGuarded.ok) {
    process.stderr.write(`${passGuarded.error.code}: ${passGuarded.error.message}\n`);
    process.exit(2);
  }
  const passArgv = [...passGuarded.value];

  const child = spawn('agy', passArgv, spawnOptions);

  // 建立虛擬的計時器以維持事件迴圈 (Event Loop) 活性，防止 Stream 因 backpressure 暫停時，因事件迴圈為空而導致主程序提前結束
  const keepAliveTimer = setInterval(() => {}, 1000);

  // 標準輸入、輸出與錯誤直連流傳送
  if (child.stdin) {
    process.stdin.pipe(child.stdin);
  }
  if (child.stdout) {
    child.stdout.pipe(process.stdout, { end: false });
  }
  if (child.stderr) {
    child.stderr.pipe(process.stderr, { end: false });
  }

  let isSigintReceived = false;

  // 轉發 SIGINT 信號給子程序，以防止背景程序洩漏
  const sigintHandler = () => {
    isSigintReceived = true;
    if (child.pid) {
      try {
        if (hasTimeout === true) {
          process.kill(-child.pid, 'SIGINT');
        } else {
          child.kill('SIGINT');
        }
      } catch (e) {}
    }
  };
  process.on('SIGINT', sigintHandler);

  let timeoutTimer: NodeJS.Timeout | undefined;
  let isTimeout = false;

  if (timeoutMsStr) {
    const timeoutMs = parseInt(timeoutMsStr, 10);
    if (!isNaN(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        isTimeout = true;
        process.stderr.write('執行超時\n');
        if (child.pid) {
          try {
            // 向程序組 PGID 發送 SIGKILL 訊號，徹底清除子程序及所有子孫程序
            // 設計概念映射：此處超時防禦設計參考了 oh-my-openagent 的物理程序樹超時清理機制。
            process.kill(-child.pid, 'SIGKILL');
          } catch (e) {
            try {
              child.kill('SIGKILL');
            } catch (err) {}
          }
        }
        // 不要直接呼叫 process.exit(1)，讓 child 觸發 close 事件，以修正超時繞過 enforcer 的漏洞
      }, timeoutMs);
    }
  }

  let isClosed = false;
  let isStdoutEnded = child.stdout ? false : true;
  let isStderrEnded = child.stderr ? false : true;
  let exitCode = 0;

  const handleExit = async () => {
    clearInterval(keepAliveTimer);
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    process.off('SIGINT', sigintHandler);

    // 執行完畢後，在 工作階段閒置 階段執行延續檢查，傳入 false 代表一般透傳模式
    await checkContinuation(todoPath, initialCompletedCount, false);

    safeExit(exitCode);
  };

  const tryExit = async () => {
    if (isClosed && isStdoutEnded && isStderrEnded) {
      await handleExit();
    }
  };

  // 監聽子程序的 close 事件（而非 exit），以確保 stdio 緩衝區被完全清空與寫出
  child.on('close', (code, signal) => {
    isClosed = true;
    // 子程序關閉時，強制將串流結束狀態標記為已結束，防範 detached 模式下 stdio EOF 無法正常觸發的漏洞
    // 設計概念映射：參考自 oh-my-openagent 的生命週期協調防禦設計
    isStdoutEnded = true;
    isStderrEnded = true;
    if (isTimeout) {
      exitCode = 1;
    } else if (isSigintReceived || signal === 'SIGINT' || code === 130) {
      exitCode = 130;
    } else {
      exitCode = code ?? 0;
    }
    tryExit().catch((e) => {
      process.exit(1);
    });
  });

  if (child.stdout) {
    child.stdout.on('end', () => {
      isStdoutEnded = true;
      tryExit().catch((e) => {
        process.exit(1);
      });
    });
  }

  if (child.stderr) {
    child.stderr.on('end', () => {
      isStderrEnded = true;
      tryExit().catch((e) => {
        process.exit(1);
      });
    });
  }

  child.on('error', (err) => {
    if (isClosed) return;
    isClosed = true;
    clearInterval(keepAliveTimer);
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    process.off('SIGINT', sigintHandler);
    process.stderr.write(`${err.message}\n`);
    safeExit(1);
  });
}

main().catch((e) => {
  process.stderr.write(`非預期錯誤: ${e.message}\n`);
  process.exit(1);
});
