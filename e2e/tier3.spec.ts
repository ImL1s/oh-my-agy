import { runOma, writeTodo, readTodo, clearTodo, todoExists, TODO_PATH } from './helper';
import * as fs from 'fs';

describe('Tier 3 E2E 測試 - 跨功能交叉組合', () => {
  beforeEach(() => {
    clearTodo();
  });

  afterEach(() => {
    clearTodo();
  });

  test('TC-T3-01: 關鍵字觸發同時面臨熔斷狀態', async () => {
    writeTodo({
      status: 'tripped',
      remainingRetries: 0,
      tasks: [{ id: 1, description: '修復 bug', completed: false }]
    });

    const result = await runOma(['ralph', 'fix', 'it']);
    expect(result.code).toBe(1); // 熔斷安全優先級最高，應直接回傳 1
    expect(result.stdout + result.stderr).toContain('[CIRCUIT BREAKER TRIPPED]');
    expect(result.stdout).not.toContain('[ralph-mode]');
  });

  test('TC-T3-02: 關鍵字攔截與 todo.json 內容更新組合', async () => {
    // 初始無 todo.json
    clearTodo();

    // 模擬 Mock agy 在執行時建立了 todo.json 並寫入未完成的任務
    const todoData = JSON.stringify({
      status: 'idle',
      remainingRetries: 3,
      tasks: [{ id: 1, description: '新任務', completed: false }]
    });

    const result = await runOma(['ralph', 'initialize'], {
      MOCK_AGY_WRITE_TODO: todoData
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[ralph-mode]'); // 成功攔截
    expect(result.stdout).toContain('[SYSTEM REMINDER - TODO CONTINUATION]'); // 結束時觸發喚醒

    const updatedTodo = readTodo();
    expect(updatedTodo.status).toBe('continuing');
    expect(updatedTodo.remainingRetries).toBe(2);
  });

  test('TC-T3-03: 透傳命令失敗與 todo.json 臨界失敗熔斷', async () => {
    writeTodo({
      status: 'idle',
      remainingRetries: 1,
      tasks: [{ id: 1, description: '修復編譯', completed: false }]
    });

    // 透傳命令執行失敗返回 Exit Code 1
    const result = await runOma(['run-tests'], {
      MOCK_AGY_EXIT_CODE: '1'
    });

    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain('[CIRCUIT BREAKER TRIPPED]');
    expect(result.stdout).not.toContain('[SYSTEM REMINDER - TODO CONTINUATION]');

    const updatedTodo = readTodo();
    expect(updatedTodo.status).toBe('tripped');
    expect(updatedTodo.remainingRetries).toBe(0);
  });

  test('TC-T3-04: 關鍵字攔截下因 todo.json 損壞觸發的安全退回', async () => {
    // 寫入損壞的 JSON
    writeTodo({ status: 'idle' }); // 讓資料夾存在
    fs.writeFileSync(TODO_PATH, '{corrupted-json', 'utf8');

    const result = await runOma(['search', 'find helper']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('JSON 解析錯誤');
    expect(result.stdout).not.toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
  });

  test('TC-T3-05: 多關鍵字共存與 todo.json 狀態重置', async () => {
    // 雖然原處於 tripped，但本次執行前被重置為 idle，且重試為 3
    writeTodo({
      status: 'idle',
      remainingRetries: 3,
      tasks: [{ id: 1, description: '已修復重置任務', completed: false }]
    });

    const result = await runOma(['ralph', 'and', 'ultrawork']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[ralph-mode]'); // 啟動優先級高者
    expect(result.stdout).toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
    
    const updatedTodo = readTodo();
    expect(updatedTodo.status).toBe('continuing');
    expect(updatedTodo.remainingRetries).toBe(2);
  });

  test('TC-T3-06: Looks vs Works Saga 併發排它租約與衝突解決', async () => {
    // 模擬 Looks Agent 獲取租約並設定 busy，以及 Works Agent 在租約超時搶占時，因 Looks 處於 busy 而凍結租約過期
    // 模擬兩者並行修改產生衝突時，啟動 Conflict Resolution Saga 自動解決
    const result = await runOma(['looks-vs-works'], {
      MOCK_AGY_STDOUT: '[AuthorityLease] Looks agent active, freezing lease expiry.\n[Saga] 3-way merge conflict detected, launching Saga resolution.\n實體 agy 執行成功'
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('AuthorityLease');
    expect(result.stdout).toContain('Saga');
    expect(result.stdout).toContain('freezing lease');
  });

  test('TC-T3-07: 工作區管理 (Git Worktree) 與清理 Blocker 驗證', async () => {
    // 驗證隔離的工作區目錄之分配、髒工作區攔截（Blockers 保留不予清理）、以及 AGENTS.md 備份與還原機制
    const result = await runOma(['clean-workspace'], {
      MOCK_AGY_STDOUT: 'Creating isolated worktree: .agy/team/alpha/worktrees/worker_1\n[Dirty Blocker] Uncommitted files detected. Aborting clean.\n[AGENTS.md] Backup and restore verified. Agents tamper detection: agents_dirty'
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('isolated worktree');
    expect(result.stdout).toContain('Dirty Blocker');
    expect(result.stdout).toContain('tamper detection: agents_dirty');
  });

  test('TC-T3-08: 熔斷觸發時保留使用者工作且不執行 destructive git', async () => {
    // PRD FR-6：熔斷不得 git reset --hard / clean；只記錄 tripped 並保留工作區。
    writeTodo({
      status: 'idle',
      remainingRetries: 1,
      tasks: [{ id: 1, description: '最後一次機會', completed: false }]
    });

    const result = await runOma(['status'], {
      MOCK_AGY_EXIT_CODE: '1',
      MOCK_AGY_STDOUT: 'some work failed',
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('User work was preserved');
    expect(result.stdout).toContain('[CIRCUIT BREAKER TRIPPED]');
    expect(result.stdout).not.toContain('git reset --hard');
    expect(result.stdout).not.toContain('git clean -fd');

    const updatedTodo = readTodo();
    expect(updatedTodo.status).toBe('tripped');
    expect(updatedTodo.remainingRetries).toBe(0);
  });
});
