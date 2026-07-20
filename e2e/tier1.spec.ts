import { runOma, writeTodo, readTodo, clearTodo, todoExists, TODO_PATH } from './helper';
import * as fs from 'fs';
import * as path from 'path';

describe('Tier 1 E2E 測試 - 核心功能覆蓋', () => {
  beforeEach(() => {
    clearTodo();
  });

  afterEach(() => {
    clearTodo();
  });

  // ==========================================
  // 1. 指令透傳與 I/O 管道 (TC-T1-01 至 TC-T1-05)
  // ==========================================
  describe('功能一：指令透傳與 Standard Streams 管道', () => {
    test('TC-T1-01: 基本指令透傳驗證', async () => {
      const result = await runOma(['help']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('實體 agy 執行成功');
      expect(result.stdout).toContain('收到引數: help');
      expect(result.stderr).toBe('');
      expect(todoExists()).toBe(false);
    });

    test('TC-T1-02: 帶有選項與參數的指令透傳', async () => {
      const result = await runOma(['write', 'file.txt', 'hello world']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('實體 agy 執行成功');
      expect(result.stdout).toContain('收到引數: write file.txt hello world');
    });

    test('TC-T1-03: 標準輸入 (stdin) 透傳管道', async () => {
      const result = await runOma(['read-stdin'], { MOCK_AGY_READ_STDIN: 'true' }, '測試輸入');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('收到 stdin: 測試輸入');
    });

    test('TC-T1-04: 透傳指令失敗狀態傳播', async () => {
      const result = await runOma(['nonexistent-command'], { MOCK_AGY_EXIT_CODE: '127', MOCK_AGY_STDERR: '找不到該指令' });
      expect(result.code).toBe(127);
      expect(result.stderr).toContain('找不到該指令');
    });

    test('TC-T1-05: 大量輸出之 Buffer 透傳', async () => {
      const result = await runOma(['print-large-data'], { MOCK_AGY_LARGE_DATA: 'true' });
      expect(result.code).toBe(0);
      // 確保輸出大小約為 1MB (1024 * 1024 bytes)
      expect(result.stdout.length).toBeGreaterThanOrEqual(1024 * 1024);
    });
  });

  // ==========================================
  // 2. 魔術關鍵字攔截與模式切換 (TC-T1-06 至 TC-T1-10)
  // ==========================================
  describe('功能二：魔術關鍵字攔截與模式切換', () => {
    test('TC-T1-06: Ralph 關鍵字攔截', async () => {
      const result = await runOma(['ralph', 'fix', 'the', 'bug']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[ralph-mode]'); // 應包含 Ralph 模式提示詞
      expect(result.stdout).not.toContain('實體 agy 執行成功'); // 魔術指令不應直接透傳
    });

    test('TC-T1-07: Ultrawork 關鍵字攔截', async () => {
      const result = await runOma(['run', 'ultrawork']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[ultrawork-mode]'); // 應包含 Ultrawork 模式提示詞
    });

    test('TC-T1-08: Search 關鍵字攔截', async () => {
      const result = await runOma(['search', 'for', 'helper', 'functions']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[search-mode]'); // 應包含 Search 模式提示詞
    });

    test('TC-T1-09: 縮寫關鍵字攔截 (ulw/uw)', async () => {
      const result = await runOma(['uw', 'build']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[ultrawork-mode]');
    });

    test('TC-T1-10: 關鍵字剝離與 Prompt 傳遞', async () => {
      const result = await runOma(['ralph', 'deploy-app']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[ralph-mode]');
      expect(result.stdout).toContain('deploy-app'); // 剝離 "ralph" 後剩餘參數
      expect(result.stdout).not.toContain('ralph deploy-app');
    });
  });

  // ==========================================
  // 3. 薛西弗斯待辦任務持續喚醒 (TC-T1-11 至 TC-T1-15)
  // ==========================================
  describe('功能三：薛西弗斯待辦任務持續喚醒', () => {
    test('TC-T1-11: 單一未完成任務之喚醒流程', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 3,
        tasks: [{ id: 1, description: '修復記憶體洩漏', completed: false }]
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
      expect(result.stdout).toMatch(/[21]\.\.\./); // 包含倒數字樣

      const updatedTodo = readTodo();
      expect(updatedTodo.status).toBe('continuing');
    });

    test('TC-T1-12: 所有任務皆已完成之正常結束', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 3,
        tasks: [{ id: 1, description: '修復記憶體洩漏', completed: true }]
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
      
      const updatedTodo = readTodo();
      expect(updatedTodo.status).toBe('idle');
    });

    test('TC-T1-13: 部分完成與未完成任務混合之喚醒', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 3,
        tasks: [
          { id: 1, description: '任務一', completed: true },
          { id: 2, description: '任務二', completed: false }
        ]
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
      
      const updatedTodo = readTodo();
      expect(updatedTodo.status).toBe('continuing');
    });

    test('TC-T1-14: 倒數警告輸出格式驗證', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 3,
        tasks: [{ id: 1, description: '任務一', completed: false }]
      });

      const result = await runOma(['status']);
      expect(result.stdout).toContain('[警告]');
      expect(result.stdout).toContain('待辦事項未完成');
      expect(result.stdout).toContain('秒後自動喚醒');
    });

    test('TC-T1-15: tasks 欄位不存在之正常結束', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 3
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
    });
  });

  // ==========================================
  // 4. 死鎖熔斷器與重試次數控制 (TC-T1-16 至 TC-T1-20)
  // ==========================================
  describe('功能四：死鎖熔斷器與重試次數控制', () => {
    test('TC-T1-16: 首次失敗之重試次數遞減', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 3,
        tasks: [{ id: 1, description: '修復編譯錯誤', completed: false }]
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      
      const updatedTodo = readTodo();
      expect(updatedTodo.remainingRetries).toBe(2);
    });

    test('TC-T1-17: 連續第二次失敗之次數遞減', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 2,
        tasks: [{ id: 1, description: '修復編譯錯誤', completed: false }]
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      
      const updatedTodo = readTodo();
      expect(updatedTodo.remainingRetries).toBe(1);
    });

    test('TC-T1-18: 連續第三次失敗觸發熔斷', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 1,
        tasks: [{ id: 1, description: '修復編譯錯誤', completed: false }]
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(1); // 熔斷時 Exit Code 應為非零
      expect(result.stdout + result.stderr).toContain('[CIRCUIT BREAKER TRIPPED]');
      expect(result.stdout).not.toContain('[SYSTEM REMINDER - TODO CONTINUATION]');

      const updatedTodo = readTodo();
      expect(updatedTodo.status).toBe('tripped');
      expect(updatedTodo.remainingRetries).toBe(0);
    });

    test('TC-T1-19: 任務推進時重試次數重置', async () => {
      // 模擬從 "工作一 false, 工作二 false" 變為 "工作一 true, 工作二 false"
      // 這裡 remainingRetries 為 1，因為有任務推進（工作一完成），預期應該被重置為 3 且遞減為 2
      writeTodo({
        status: 'idle',
        remainingRetries: 1,
        tasks: [
          { id: 1, description: '工作一', completed: true },
          { id: 2, description: '工作二', completed: false }
        ]
      });

      // 為了模擬推進，我們可以在測試前寫入前一次的狀態，並在執行時發現進度變更。
      // oma 應該比較前一次的任務進度。如果 detected progress (e.g. 任務一 completed 變成 true)，
      // 會把重試次數重置為 3。在這次執行後，因為還有任務二未完成，會遞減為 2。
      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      
      const updatedTodo = readTodo();
      expect(updatedTodo.remainingRetries).toBe(2); // 重置為 3 且因當次未全完成而減 1
    });

    test('TC-T1-20: 熔斷狀態寫入驗證', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 1,
        tasks: [{ id: 1, description: '修復編譯錯誤', completed: false }]
      });

      await runOma(['status']);
      
      const updatedTodo = readTodo();
      expect(updatedTodo.status).toBe('tripped');
      expect(updatedTodo.remainingRetries).toBe(0);
      // 確保 JSON 格式正確可解析
      expect(updatedTodo.tasks[0].completed).toBe(false);
    });
  });

  // ==========================================
  // 5. Todo 檔案解析與異常安全防禦 (TC-T1-21 至 TC-T1-25)
  // ==========================================
  describe('功能五：Todo 檔案解析與異常安全防禦', () => {
    test('TC-T1-21: 正常的 todo.json 檔案讀寫', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 3,
        tasks: [{ id: 1, description: '修復 bug', completed: true }]
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      expect(readTodo().status).toBe('idle');
    });

    test('TC-T1-22: 檔案不存在時的預設初始化', async () => {
      // 確保 todo.json 不存在
      clearTodo();

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      // 系統應能正常結束，並自動建立預設結構或安全退出
      expect(todoExists()).toBe(true);
      const defaultTodo = readTodo();
      expect(defaultTodo.status).toBe('idle');
      expect(defaultTodo.remainingRetries).toBe(3);
    });

    test('TC-T1-23: 空 JSON 物件解析防禦', async () => {
      if (!fs.existsSync(path.dirname(TODO_PATH))) {
        fs.mkdirSync(path.dirname(TODO_PATH), { recursive: true });
      }
      fs.writeFileSync(TODO_PATH, '{}', 'utf8');

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      
      const updatedTodo = readTodo();
      expect(updatedTodo.status).toBe('idle');
      expect(updatedTodo.remainingRetries).toBe(3);
    });

    test('TC-T1-24: 含有多個 tasks 且屬性齊全的 JSON 解析', async () => {
      writeTodo({
        status: 'idle',
        remainingRetries: 3,
        tasks: Array.from({ length: 10 }, (_, i) => ({
          id: i + 1,
          description: `任務 ${i + 1}`,
          completed: i < 9, // 前 9 個完成，第 10 個未完成
          priority: 'high',
          createdAt: new Date().toISOString()
        }))
      });

      const result = await runOma(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
      
      const updatedTodo = readTodo();
      expect(updatedTodo.remainingRetries).toBe(2);
    });

    test('TC-T1-25: 當次執行之 todo.json 即時狀態讀取', async () => {
      // 測試 oma 結束時讀取的是被實體 agy 命令執行期間修改後的最新狀態，而非執行前的舊狀態。
      // 我們使用 Mock agy，在執行時動態寫入一個含有完成任務的 todo.json。
      writeTodo({
        status: 'idle',
        remainingRetries: 3,
        tasks: [{ id: 1, description: '執行中被完成的任務', completed: false }]
      });

      const updatedTodoState = JSON.stringify({
        status: 'idle',
        remainingRetries: 3,
        tasks: [{ id: 1, description: '執行中被完成的任務', completed: true }]
      });

      const result = await runOma(['status'], {
        MOCK_AGY_WRITE_TODO: updatedTodoState
      });

      expect(result.code).toBe(0);
      // 因為 Mock agy 在執行時將任務改為已完成，oma 結束時應讀到已完成，不應觸發喚醒。
      expect(result.stdout).not.toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
      expect(readTodo().tasks[0].completed).toBe(true);
    });
  });
});
