import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// 使用隨機字串實現沙盒隔離，防止多個 Jest 測試執行緒之間共享 .agy/todo.json 造成資料競態
const randomId = Math.random().toString(36).substring(2, 10);
export const TODO_DIR = path.resolve(__dirname, `../.agy_sandbox_${randomId}`);
export const TODO_PATH = path.resolve(TODO_DIR, 'todo.json');
export const OMA_PATH = path.resolve(__dirname, '../bin/oma.ts');
export const MOCK_AGY_DIR = path.resolve(__dirname, 'mocks');

/**
 * 執行 oma.ts CLI
 */
export function runOma(
  args: string[],
  env: Record<string, string> = {},
  stdinText?: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const systemPath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
    // 將 mock-agy 的目錄加到 PATH 最前面
    const customPath = `${MOCK_AGY_DIR}:${systemPath}`;

    const distOmaPath = path.resolve(__dirname, '../dist/bin/oma.js');
    const useDist = process.env.TEST_DIST === 'true' && fs.existsSync(distOmaPath);

    const spawnCmd = useDist ? 'node' : 'npx';
    const spawnArgs = useDist ? [distOmaPath, ...args] : ['ts-node', OMA_PATH, ...args];

    // 使用 spawn 替代 exec，避免 shell 命令注入漏洞
    const child = spawn(
      spawnCmd,
      spawnArgs,
      {
        env: {
          ...process.env,
          PATH: customPath,
          OMA_TODO_PATH: TODO_PATH,
          MOCK_AGY_TODO_PATH: TODO_PATH,
          ...env,
        },
      }
    );

    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('error', (err) => {
      resolve({
        code: 1,
        stdout,
        stderr: stderr + '\n' + err.message,
      });
    });

    child.on('close', (code) => {
      resolve({
        code: code ?? 0,
        stdout,
        stderr,
      });
    });

    if (stdinText && child.stdin) {
      try {
        child.stdin.write(stdinText);
        child.stdin.end();
      } catch (e) {
        // 忽略 stdin 寫入錯誤（如程序已關閉）
      }
    }
  });
}

/**
 * 寫入 todo.json
 */
export function writeTodo(data: any): void {
  if (!fs.existsSync(TODO_DIR)) {
    fs.mkdirSync(TODO_DIR, { recursive: true });
  }
  fs.writeFileSync(TODO_PATH, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 讀取 todo.json
 */
export function readTodo(): any {
  if (!fs.existsSync(TODO_PATH)) {
    throw new Error('todo.json 檔案不存在');
  }
  const content = fs.readFileSync(TODO_PATH, 'utf8');
  return JSON.parse(content);
}

/**
 * 清除 todo.json 與整個 .agy_sandbox 資料夾
 */
export function clearTodo(): void {
  try {
    if (fs.existsSync(TODO_PATH)) {
      try {
        fs.chmodSync(TODO_PATH, 0o666);
      } catch (e) {}
      fs.rmSync(TODO_PATH, { recursive: true, force: true });
    }
    if (fs.existsSync(TODO_DIR)) {
      try {
        fs.chmodSync(TODO_DIR, 0o755);
      } catch (e) {}
      fs.rmSync(TODO_DIR, { recursive: true, force: true });
    }
  } catch (e) {
    // 忽略所有可能拋出的異常，確保測試流程不中斷
  }
}

/**
 * 檢查 todo.json 是否存在
 */
export function todoExists(): boolean {
  return fs.existsSync(TODO_PATH);
}
