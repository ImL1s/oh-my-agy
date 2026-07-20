import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ContinuationResult } from './types';
import {
  LockHandle,
  acquireOwnerLock,
  releaseOwnerLock,
} from './runtime/lock';
import { RuntimeContractError } from './runtime/errors';

/**
 * 任務結構介面
 * 參考自 oh-my-claudecode 的待辦事項定義
 */
interface Task {
  id: number | string;
  description?: string;
  completed: boolean;
  [key: string]: any;
}

/**
 * 待辦事項資料結構介面
 * 參考自 oh-my-claudecode 的共享帳本設計
 */
interface TodoData {
  status?: string;
  remainingRetries?: number;
  tasks?: Task[];
  stableCommit?: string;
  [key: string]: any;
}

/**
 * 獲取最新穩定 commit 雜湊值
 * 設計概念映射：參考自 oh-my-claudecode 中獲取 Git 版本控制標記的實作設計
 * 
 * @returns 穩定 commit 雜湊值，若失敗則傳回 undefined
 */
function getHeadCommit(): string | undefined {
  try {
    const gitResult = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (gitResult.status === 0) {
      return gitResult.stdout.trim();
    }
  } catch (e) {}
  return undefined;
}

/**
 * 判斷當前工作區是否為有效的 Git 儲存庫
 * 設計概念映射：參考自 oh-my-claudecode 檢測工作區狀態之設計
 */
/**
 * 獲取檔案鎖（非同步互斥鎖，藉由原子性建立鎖目錄實作）
 * 設計概念映射：此處參考了 oh-my-openagent 專案中 `todo-continuation-enforcer.ts` 模組的非同步互斥鎖設計理念。
 * 
 * @param lockPath 鎖目錄的實體路徑
 * @param timeoutMs 超時時間（毫秒）
 */
const legacyLockHandles = new Map<string, LockHandle>();

export async function acquireLock(lockPath: string, timeoutMs: number = 5000): Promise<void> {
  const result = await acquireOwnerLock(lockPath, { timeoutMs });
  if (!result.ok) throw new RuntimeContractError(result.error);
  legacyLockHandles.set(path.resolve(lockPath), result.value);
}

/**
 * 釋放檔案鎖
 * 設計概念映射：此處參考了 oh-my-openagent 專案中 `todo-continuation-enforcer.ts` 模組的釋放鎖設計理念。
 * 
 * @param lockPath 鎖目錄的實體路徑
 */
export function releaseLock(lockPath: string): void {
  const resolved = path.resolve(lockPath);
  const handle = legacyLockHandles.get(resolved);
  if (handle === undefined) return;
  const released = releaseOwnerLock(handle);
  if (released.ok) legacyLockHandles.delete(resolved);
}

/**
 * 檢查待辦事項狀態以判定是否延續執行。
 * 此函式為 Continuation Enforcer 的核心邏輯，符合 CLI 與 Enforcer 的介面契約。
 * 設計概念映射：此處參考了 oh-my-claudecode 的任務狀態管理與自動重試防禦設計。
 * 
 * @param todoPath 待辦事項 JSON 檔案的實體路徑（例如 `.agy/todo.json`）
 * @param initialCompletedCount 執行前已完成任務的數量
 * @returns 傳回包含延續狀態、提示詞與剩餘重試次數的 Promise<ContinuationResult>
 */
export async function checkContinuation(
  todoPath: string,
  initialCompletedCount?: number,
  isMagicMode?: boolean
): Promise<ContinuationResult> {
  // 1. 偵測路徑類型衝突與檔案權限
  try {
    const stat = fs.statSync(todoPath);
    if (stat.isDirectory()) {
      process.stderr.write('路徑類型衝突\n');
      process.exit(1);
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      // 權限不足等其他錯誤，如果是 EACCES 則輸出 Permission denied
      if (e.code === 'EACCES') {
        process.stderr.write('Permission denied\n');
      } else {
        process.stderr.write(`${e.message}\n`);
      }
      process.exit(1);
    }
  }

  const lockPath = todoPath + '.lock';
  const todoDir = path.dirname(todoPath);
  if (!fs.existsSync(todoDir)) {
    fs.mkdirSync(todoDir, { recursive: true });
  }
  await acquireLock(lockPath);

  try {
    // 2. 若檔案不存在，進行預設初始化
    if (!fs.existsSync(todoPath)) {
      const args = process.argv.slice(2);
      const hasStatus = args.some(arg => arg.toLowerCase() === 'status');
      const isHelpCommand = args.some(arg => arg.toLowerCase() === 'help');

      // 避免一般透傳命令無條件初始化 todo.json
      // 設計概念映射：若無 todo.json 檔案且非 status 查詢或魔術攔截模式，不應自動建立檔案
      if (!isMagicMode && !hasStatus) {
        releaseLock(lockPath);
        return {
          shouldContinue: false,
          status: 'idle',
          remainingRetries: 3
        };
      }

      if (isHelpCommand) {
        releaseLock(lockPath);
        return {
          shouldContinue: false,
          status: 'idle',
          remainingRetries: 3
        };
      }

      const todoDir = path.dirname(todoPath);
      if (!fs.existsSync(todoDir)) {
        fs.mkdirSync(todoDir, { recursive: true });
      }
      const defaultTodo: TodoData = {
        status: 'idle',
        remainingRetries: 3,
        stableCommit: getHeadCommit()
      };
      fs.writeFileSync(todoPath, JSON.stringify(defaultTodo, null, 2), 'utf8');
      releaseLock(lockPath);
      return {
        shouldContinue: false,
        status: 'idle',
        remainingRetries: 3
      };
    }

    // 3. 讀取檔案內容
    let rawContent = '';
    try {
      rawContent = fs.readFileSync(todoPath, 'utf8');
    } catch (e: any) {
      if (e.code === 'EACCES') {
        process.stderr.write('Permission denied\n');
      } else {
        process.stderr.write(`${e.message}\n`);
      }
      releaseLock(lockPath);
      process.exit(1);
    }

    // 4. 若檔案為空，安全初始化
    if (rawContent.trim() === '') {
      const defaultTodo: TodoData = {
        status: 'idle',
        remainingRetries: 3,
        stableCommit: getHeadCommit()
      };
      fs.writeFileSync(todoPath, JSON.stringify(defaultTodo, null, 2), 'utf8');
      releaseLock(lockPath);
      return {
        shouldContinue: false,
        status: 'idle',
        remainingRetries: 3
      };
    }

    // 5. 解析 JSON 內容
    let todoData: TodoData;
    try {
      todoData = JSON.parse(rawContent);
    } catch (e: any) {
      process.stderr.write('JSON 解析錯誤\n');
      releaseLock(lockPath);
      process.exit(1);
    }

    // 6. 若僅包含 {}，安全初始化
    if (Object.keys(todoData).length === 0) {
      const defaultTodo: TodoData = {
        status: 'idle',
        remainingRetries: 3,
        stableCommit: getHeadCommit()
      };
      fs.writeFileSync(todoPath, JSON.stringify(defaultTodo, null, 2), 'utf8');
      releaseLock(lockPath);
      return {
        shouldContinue: false,
        status: 'idle',
        remainingRetries: 3
      };
    }

    // 7. 格式檢驗：tasks 欄位型別異常判定
    if (todoData.tasks !== undefined && !Array.isArray(todoData.tasks)) {
      process.stderr.write('tasks 格式異常\n');
      releaseLock(lockPath);
      process.exit(1);
    }

    // 8. 狀態與重試次數之安全回退
    const validStatuses = ['idle', 'continuing', 'tripped'];
    if (!todoData.status || !validStatuses.includes(todoData.status)) {
      todoData.status = 'idle';
    }
    if (todoData.remainingRetries === undefined) {
      todoData.remainingRetries = 3;
    }

    // 9. 統計已完成任務之識別碼 (ID) 列表
    const afterCompletedIds: (number | string)[] = [];
    if (todoData.tasks) {
      for (const task of todoData.tasks) {
        if (task.completed === true) {
          afterCompletedIds.push(task.id);
        }
      }
    }

    // 10. 讀取快取檔案中已完成之識別碼列表
    const completedCachePath = todoPath + '.completed';
    let cachedCompletedIds: (number | string)[] = [];
    if (fs.existsSync(completedCachePath)) {
      try {
        const cachedContent = fs.readFileSync(completedCachePath, 'utf8');
        cachedCompletedIds = JSON.parse(cachedContent);
        if (!Array.isArray(cachedCompletedIds)) {
          cachedCompletedIds = [];
        }
      } catch (e) {
        cachedCompletedIds = [];
      }
    }

    // 11. 進度推進判定邏輯
    let hasProgress = false;
    // (a) 執行後與執行前已完成任務 ID 的數量變化
    if (initialCompletedCount !== undefined && afterCompletedIds.length > initialCompletedCount) {
      hasProgress = true;
    }
    // (b) 執行前與快取檔案中已完成任務 ID 的變化
    for (const id of afterCompletedIds) {
      if (!cachedCompletedIds.includes(id)) {
        hasProgress = true;
        break;
      }
    }

    // 若有推進，重置重試計數器為 3，並記錄當前穩定 commit 雜湊值
    // 設計概念映射：參考自 oh-my-openagent 的穩定 commit 記錄機制，用以提供還原所需之安全基準點
    if (hasProgress) {
      todoData.remainingRetries = 3;
      todoData.stableCommit = getHeadCommit();
    }

    // 12. 檢查是否仍有未完成任務
    const hasUncompleted = todoData.tasks && todoData.tasks.some(task => !task.completed);

    if (!hasUncompleted || !todoData.tasks || todoData.tasks.length === 0) {
      // 所有任務均已完成或 tasks 欄位不存在
      const wasNotAllCompleted = todoData.tasks && todoData.tasks.length > 0 && cachedCompletedIds.length < todoData.tasks.length;
      if (wasNotAllCompleted && hasProgress) {
        process.stdout.write('[ALL TASKS COMPLETED]\n');
      }

      todoData.status = 'idle';
      fs.writeFileSync(todoPath, JSON.stringify(todoData, null, 2), 'utf8');
      fs.writeFileSync(completedCachePath, JSON.stringify(afterCompletedIds), 'utf8');
      releaseLock(lockPath);

      return {
        shouldContinue: false,
        status: 'idle',
        remainingRetries: todoData.remainingRetries
      };
    }

    // 13. 仍有未完成任務，遞減重試次數
    todoData.remainingRetries = todoData.remainingRetries - 1;

    if (todoData.remainingRetries > 0) {
      // 進入延續狀態，印出倒數警告並啟動延續喚醒
      todoData.status = 'continuing';
      fs.writeFileSync(todoPath, JSON.stringify(todoData, null, 2), 'utf8');
      fs.writeFileSync(completedCachePath, JSON.stringify(afterCompletedIds), 'utf8');
      
      // 進入倒數前先釋放鎖，避免多程序併發等待造成鎖超時
      releaseLock(lockPath);

      // 倒數前僅印出黃色警告訊息，尚未注入提示詞
      process.stdout.write('\x1b[33m[警告] 待辦事項未完成，2 秒後自動喚醒...\x1b[0m\n');

      // 倒數計時，支援 SIGINT 中斷退出，其退出碼為 130
      await new Promise<void>((resolve) => {
        const sigintHandler = () => {
          process.exit(130);
        };
        process.on('SIGINT', sigintHandler);

        process.stdout.write('2... ');
        setTimeout(() => {
          process.stdout.write('1... \n');
          setTimeout(() => {
            process.off('SIGINT', sigintHandler);
            resolve();
          }, 1000);
        }, 1000);
      });

      // 倒數成功後才印出提示詞
      // 設計概念映射：只在 2 秒倒數 Promise 成功 resolve 之後才印出以防止 SIGINT 中斷時提前輸出提示詞
      process.stdout.write('[SYSTEM REMINDER - TODO CONTINUATION]\n');

      return {
        shouldContinue: true,
        status: 'continuing',
        remainingRetries: todoData.remainingRetries,
        prompt: `[SYSTEM REMINDER - TODO CONTINUATION] 偵測到尚有未完成的工作，請繼續執行任務。`
      };
    } else {
      // 熔斷只記錄狀態與診斷；不得 reset、clean、checkout 或刪除使用者內容。
      process.stdout.write('[Circuit Breaker] Tripped. User work was preserved; no rollback was attempted.\n');
      todoData.status = 'tripped';
      todoData.remainingRetries = 0;
      fs.writeFileSync(todoPath, JSON.stringify(todoData, null, 2), 'utf8');
      fs.writeFileSync(completedCachePath, JSON.stringify(afterCompletedIds), 'utf8');
      process.stdout.write('[CIRCUIT BREAKER TRIPPED]\n');
      releaseLock(lockPath);
      process.exit(1);
    }
  } catch (err) {
    releaseLock(lockPath);
    throw err;
  }
}
