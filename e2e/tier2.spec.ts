import { runOma, writeTodo, readTodo, clearTodo, todoExists, TODO_PATH, TODO_DIR } from './helper';
import * as fs from 'fs';
import * as path from 'path';
import { exec, spawn } from 'child_process';
import { OMA_PATH, MOCK_AGY_DIR } from './helper';

describe('Tier 2 E2E 測試 - 邊界與極端情況', () => {
  beforeEach(() => {
    clearTodo();
  });

  afterEach(() => {
    try {
      if (fs.existsSync(TODO_PATH)) {
        fs.chmodSync(TODO_PATH, 0o644);
      }
      if (fs.existsSync(TODO_DIR)) {
        fs.chmodSync(TODO_DIR, 0o755);
      }
    } catch (e) {}
    clearTodo();
  });

  // ==========================================
  // 1. 空 todo.json 與格式損壞 (TC-T2-01 至 TC-T2-05)
  // ==========================================
  describe('邊界組一：空 todo.json 與格式損壞', () => {
    test('TC-T2-01: 空檔案（0 位元組）解析安全防禦', async () => {
      if (!fs.existsSync(TODO_DIR)) {
        fs.mkdirSync(TODO_DIR, { recursive: true });
      }
      fs.writeFileSync(TODO_PATH, '', 'utf8'); // 0 位元組

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      expect(todoExists()).toBe(true);
      const data = readTodo();
      expect(data.status).toBe('idle');
    });

    test('TC-T2-02: JSON 語法損壞與 Safe-Mode 退回', async () => {
      if (!fs.existsSync(TODO_DIR)) {
        fs.mkdirSync(TODO_DIR, { recursive: true });
      }
      fs.writeFileSync(TODO_PATH, '{invalid-json-structure', 'utf8');

      const result = await runOma(['status']);
      expect(result.code).toBe(1); // 應安全終止並返回 Exit Code 1
      expect(result.stderr).toContain('JSON 解析錯誤');
    });

    test('TC-T2-03: 檔案無讀寫權限', async () => {
      writeTodo({ status: 'idle', remainingRetries: 3, tasks: [] });
      // 設定權限為 000 (無任何權限)
      fs.chmodSync(TODO_PATH, 0o000);

      const result = await runOma(['status']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Permission denied');
    });

    test('TC-T2-04: 同名目錄衝突', async () => {
      // 建立一個與 todo.json 同名的目錄
      if (!fs.existsSync(TODO_DIR)) {
        fs.mkdirSync(TODO_DIR, { recursive: true });
      }
      fs.mkdirSync(TODO_PATH); // todo.json 變成了目錄

      const result = await runOma(['status']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('路徑類型衝突');

      // 清理同名目錄以防 afterEach 失敗
      fs.rmdirSync(TODO_PATH);
    });

    test('TC-T2-05: tasks 欄位型別異常', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 3,
        tasks: 'not-an-array' // 型別錯誤
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('tasks 格式異常');
    });
  });

  // ==========================================
  // 2. 熔斷次數邊界與重試機制 (TC-T2-06 至 TC-T2-10)
  // ==========================================
  describe('邊界組二：熔斷次數邊界與重試機制', () => {
    test('TC-T2-06: 連續失敗熔斷次數邊界值為 0', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 0,
        tasks: [{ id: 1, description: '測試', completed: false }]
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).toContain('[CIRCUIT BREAKER TRIPPED]');
      expect(readTodo().status).toBe('tripped');
    });

    test('TC-T2-07: 連續失敗熔斷次數邊界值為 1', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 1,
        tasks: [{ id: 1, description: '測試', completed: false }]
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(1); // 剩餘 1 次重試，執行一次後降為 0 熔斷，返回 1
      expect(readTodo().status).toBe('tripped');
    });

    test('TC-T2-08: 連續失敗熔斷次數邊界值為 2', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 2,
        tasks: [{ id: 1, description: '測試', completed: false }]
      });

      // 第一次執行，遞減至 1，應該正常喚醒
      let result = await runOma(['status']);
      expect(result.code).toBe(0);
      expect(readTodo().remainingRetries).toBe(1);

      // 第二次執行，遞減至 0，觸發熔斷，Exit Code 1
      result = await runOma(['status']);
      expect(result.code).toBe(1);
      expect(readTodo().status).toBe('tripped');
    });

    test('TC-T2-09: 已熔斷狀態之再次執行防禦', async () => {
      writeTodo({
        status: 'tripped',
        remainingRetries: 0,
        tasks: [{ id: 1, description: '已熔斷任務', completed: false }]
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(1);
      expect(result.stderr + result.stdout).toContain('系統處於熔斷狀態');
    });

    test('TC-T2-10: 多任務交錯下之重試次數計數邊界', async () => {
      // Task A 失敗 2 次後完成，隨後加入 Task B
      writeTodo({
        status: 'idle',
        remainingRetries: 1, // 已經失敗兩次
        tasks: [
          { id: 1, description: '工作 A', completed: true }, // 工作 A 推進完成
          { id: 2, description: '工作 B', completed: false } // 新加入工作 B
        ]
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      
      const data = readTodo();
      // 因為有任務推進（工作 A 完成），重試次數重置為 3，因工作 B 未完，遞減為 2
      expect(data.remainingRetries).toBe(2);
    });
  });

  // ==========================================
  // 3. 關鍵字攔截邊界與防誤觸 (TC-T2-11 至 TC-T2-15)
  // ==========================================
  describe('邊界組三：關鍵字攔截邊界與防誤觸', () => {
    test('TC-T2-11: Markdown 程式碼區塊內之關鍵字防誤觸', async () => {
      const result = await runOma(['execute', '`\`\`\nralph fix the bug\n\`\`\``']);
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('[ralph-mode]');
      expect(result.stdout).toContain('實體 agy 執行成功');
    });

    test('TC-T2-12: 行內程式碼內之關鍵字防誤觸', async () => {
      const result = await runOma(['check', '`ultrawork`']);
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('[ultrawork-mode]');
      expect(result.stdout).toContain('實體 agy 執行成功');
    });

    test('TC-T2-13: 諮詢性語境 (Informational Context) 過濾', async () => {
      const result = await runOma(['ask', '"what is search?"']);
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('[search-mode]');
      expect(result.stdout).toContain('實體 agy 執行成功');
    });

    test('TC-T2-14: 單字黏連防誤觸', async () => {
      const result = await runOma(['sisyphus_ralph']);
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('[ralph-mode]');
      expect(result.stdout).toContain('實體 agy 執行成功');
    });

    test('TC-T2-15: 多關鍵字共存優先級', async () => {
      // 假設 Ralph 優先級高於 Ultrawork
      const result = await runOma(['ralph', 'and', 'ultrawork']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[ralph-mode]');
      expect(result.stdout).not.toContain('[ultrawork-mode]');
    });
  });

  // ==========================================
  // 4. 一般命令透傳邊界 (TC-T2-16 至 TC-T2-20)
  // ==========================================
  describe('邊界組四：一般命令透傳邊界', () => {
    test('TC-T2-16: 空引數與空格透傳', async () => {
      const result = await runOma(['"   "']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('實體 agy 執行成功');
    });

    test('TC-T2-17: 極長參數傳遞安全防禦', async () => {
      const largeParam = 'A'.repeat(100000); // 10 萬字元
      const result = await runOma([largeParam]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('實體 agy 執行成功');
    });

    test('TC-T2-18: Shell 特殊字元防注入', async () => {
      const result = await runOma(['"echo hello; rm -rf /"']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('實體 agy 執行成功');
      expect(result.stdout).toContain('echo hello; rm -rf /');
    });

    test('TC-T2-19: 外部中斷信號 (SIGINT) 傳播', async () => {
      const systemPath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
      const customPath = `${MOCK_AGY_DIR}:${systemPath}`;

      const distOmaPath = path.resolve(__dirname, '../dist/bin/oma.js');
      const useDist = process.env.TEST_DIST === 'true' && fs.existsSync(distOmaPath);
      const spawnCmd = useDist ? 'node' : 'npx';
      const spawnArgs = useDist ? [distOmaPath, 'sleep-command'] : ['ts-node', OMA_PATH, 'sleep-command'];

      // 使用 spawn 啟動長任務
      const child = spawn(spawnCmd, spawnArgs, {
        env: {
          ...process.env,
          PATH: customPath,
          OMA_TODO_PATH: TODO_PATH,
          MOCK_AGY_TODO_PATH: TODO_PATH,
          MOCK_AGY_SLEEP_MS: '10000', // sleep 10 秒
          MOCK_AGY_SIGNAL_SLEEPING: 'true', // 要求 mock agy 輸出特定標誌
        }
      });

      let stdoutData = '';

      // 用 Promise 監聽 stdout 標誌後再送出 SIGINT，防止時序抖動
      await new Promise<void>((resolve, reject) => {
        const onData = (data: any) => {
          stdoutData += data.toString();
          if (stdoutData.includes('[MOCK_AGY_SLEEPING]')) {
            child.stdout.off('data', onData);
            resolve();
          }
        };
        child.stdout.on('data', onData);

        // 設定一個安全超時，防止 mock 沒有輸出時無限等待
        child.on('close', (code) => {
          child.stdout.off('data', onData);
          reject(new Error(`程序在輸出 [MOCK_AGY_SLEEPING] 前已結束，退出碼: ${code}`));
        });
        child.on('error', (err) => {
          child.stdout.off('data', onData);
          reject(err);
        });
      }).then(() => {
        child.kill('SIGINT');
      }).catch((err) => {
        child.kill('SIGKILL');
        throw err;
      });

      const code = await new Promise<number | null>((resolve) => {
        child.on('close', resolve);
      });

      expect(code).toBe(130);
    }, 15000);

    test('TC-T2-20: 透傳指令執行超時', async () => {
      const result = await runOma(['timeout-command'], {
        MOCK_AGY_SLEEP_MS: '6000', // 模擬命令卡死 6 秒
        OMA_TIMEOUT_MS: '2000' // 設定 oma 超時為 2 秒
      });

      expect(result.code).toBe(1); // 超時退出
      expect(result.stderr).toContain('執行超時');
    });
  });

  // ==========================================
  // 5. Enforcer 與 todo.json 複雜屬性邊界 (TC-T2-21 至 TC-T2-25)
  // ==========================================
  describe('邊界組五：Enforcer 與 todo.json 複雜屬性邊界', () => {
    test('TC-T2-21: tasks 為空陣列 []', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 3,
        tasks: []
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
    });

    test('TC-T2-22: remainingRetries 欄位不存在', async () => {
      writeTodo({
        status: 'idle',
        tasks: [{ id: 1, description: '任務', completed: false }]
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      // 應該自動補上預設的 3，並遞減為 2
      expect(readTodo().remainingRetries).toBe(2);
    });

    test('TC-T2-23: status 欄位為未知值', async () => {
      writeTodo({
        status: 'invalid_status_value',
        remainingRetries: 3,
        tasks: []
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      expect(readTodo().status).toBe('idle'); // 安全回退為 idle
    });

    test('TC-T2-24: 巨量 tasks 解析效能與邊界', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 3,
        tasks: Array.from({ length: 1000 }, (_, i) => ({
          id: i + 1,
          description: `任務 ${i + 1}`,
          completed: true
        }))
      });

      const startTime = Date.now();
      const result = await runOma(['status']);
      const duration = Date.now() - startTime;

      expect(result.code).toBe(0);
      // 負載邊界：確認能完成而非嚴格效能 SLA（CI/機器負載會抖動）。
      const maxDuration = process.env.TEST_DIST === 'true' ? 2000 : 8000;
      expect(duration).toBeLessThan(maxDuration);
    });

    test('TC-T2-25: 多程序檔案寫入鎖定競爭', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 3,
        tasks: [{ id: 1, description: '任務', completed: false }]
      });

      // 同時執行兩個 oma 程序，測試其物理鎖定防禦
      const promises = [
        runOma(['status']),
        runOma(['status'])
      ];

      const results = await Promise.all(promises);
      // 確保兩者皆能以非崩潰狀態結束
      expect(results[0].code).toBe(0);
      expect(results[1].code).toBe(0);
    });
  });
});
