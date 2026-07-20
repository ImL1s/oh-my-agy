import { runOma, writeTodo, readTodo, clearTodo, todoExists, TODO_PATH } from './helper';
import { spawn } from 'child_process';
import { OMA_PATH, MOCK_AGY_DIR } from './helper';
import * as fs from 'fs';
import * as path from 'path';

describe('Tier 4 E2E 測試 - 真實世界應用場景', () => {
  beforeEach(() => {
    clearTodo();
  });

  afterEach(() => {
    clearTodo();
  });

  test('TC-T4-01: 模擬完整的 Sisyphus 滾動巨石生命週期 (推進至完成)', async () => {
    // 1. 初始狀態：兩個未完成任務
    writeTodo({
      status: 'idle',
      remainingRetries: 3,
      tasks: [
        { id: 1, description: '任務 1', completed: false },
        { id: 2, description: '任務 2', completed: false }
      ]
    });

    // 2. 第一輪執行：任務未完成，觸發喚醒，重試次數降為 2
    let result = await runOma(['run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
    let data = readTodo();
    expect(data.status).toBe('continuing');
    expect(data.remainingRetries).toBe(2);

    // 3. 第二輪執行（模擬推進完成任務 1）
    writeTodo({
      status: 'idle',
      remainingRetries: 2,
      tasks: [
        { id: 1, description: '任務 1', completed: true }, // 完成
        { id: 2, description: '任務 2', completed: false }
      ]
    });

    result = await runOma(['run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
    data = readTodo();
    expect(data.status).toBe('continuing');
    // 有任務推進，重試次數重置為 3 且遞減為 2
    expect(data.remainingRetries).toBe(2);

    // 4. 第三輪執行（模擬推進完成任務 2）
    writeTodo({
      status: 'idle',
      remainingRetries: 2,
      tasks: [
        { id: 1, description: '任務 1', completed: true },
        { id: 2, description: '任務 2', completed: true } // 完成
      ]
    });

    result = await runOma(['run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[ALL TASKS COMPLETED]');
    expect(result.stdout).not.toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
    data = readTodo();
    expect(data.status).toBe('idle');
  });

  test('TC-T4-02: 模擬連續 3 次失敗觸發熔斷的完整週期', async () => {
    // 1. 初始狀態：1 個未完成任務
    writeTodo({
      status: 'idle',
      remainingRetries: 3,
      tasks: [{ id: 1, description: '任務', completed: false }]
    });

    // 第一輪執行：重試降為 2
    let result = await runOma(['run']);
    expect(result.code).toBe(0);
    expect(readTodo().remainingRetries).toBe(2);

    // 第二輪執行：重試降為 1
    writeTodo({
      ...readTodo(),
      status: 'idle'
    });
    result = await runOma(['run']);
    expect(result.code).toBe(0);
    expect(readTodo().remainingRetries).toBe(1);

    // 第三輪執行：重試歸零，觸發熔斷
    writeTodo({
      ...readTodo(),
      status: 'idle'
    });
    result = await runOma(['run']);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain('[CIRCUIT BREAKER TRIPPED]');
    
    const data = readTodo();
    expect(data.status).toBe('tripped');
    expect(data.remainingRetries).toBe(0);
  });

  test('TC-T4-03: 模擬任務進度推進時熔斷重置週期', async () => {
    // 1. 初始狀態：兩個未完成任務，重試 3
    writeTodo({
      status: 'idle',
      remainingRetries: 3,
      tasks: [
        { id: 1, description: '工作 A', completed: false },
        { id: 2, description: '工作 B', completed: false }
      ]
    });

    // 第一輪：無變化，降為 2
    let result = await runOma(['run']);
    expect(readTodo().remainingRetries).toBe(2);

    // 第二輪：無變化，降為 1
    writeTodo({ ...readTodo(), status: 'idle' });
    result = await runOma(['run']);
    expect(readTodo().remainingRetries).toBe(1);

    // 第三輪（臨界熔斷前，模擬推進）：工作 A 完成
    writeTodo({
      status: 'idle',
      remainingRetries: 1,
      tasks: [
        { id: 1, description: '工作 A', completed: true },
        { id: 2, description: '工作 B', completed: false }
      ]
    });

    result = await runOma(['run']);
    expect(result.code).toBe(0);
    // 推進重置為 3 且減 1，為 2
    expect(readTodo().remainingRetries).toBe(2);

    // 第四輪：工作 B 完成，全部完成
    writeTodo({
      status: 'idle',
      remainingRetries: 2,
      tasks: [
        { id: 1, description: '工作 A', completed: true },
        { id: 2, description: '工作 B', completed: true }
      ]
    });

    result = await runOma(['run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[ALL TASKS COMPLETED]');
  });

  test('TC-T4-04: 連續執行一般指令與 todo.json 動態寫入的透傳流', async () => {
    // 1. 執行 oma compile -> 正常透傳，無 todo
    let result = await runOma(['compile']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('實體 agy 執行成功');
    expect(todoExists()).toBe(false);

    // 2. 執行 oma test -> 失敗，Mock 寫入一個 incomplete todo.json
    const todoData = JSON.stringify({
      status: 'idle',
      remainingRetries: 3,
      tasks: [{ id: 1, description: '修復單元測試', completed: false }]
    });

    result = await runOma(['test'], {
      MOCK_AGY_EXIT_CODE: '1',
      MOCK_AGY_WRITE_TODO: todoData
    });

    // 預期雖然命令失敗，但偵測到未完成待辦，依舊觸發了黃色警告倒數與薛西弗斯喚醒
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
    expect(readTodo().status).toBe('continuing');
  });

  test('TC-T4-05: 薛西弗斯喚醒過程中遭受中斷 (Abort)', async () => {
    writeTodo({
      status: 'idle',
      remainingRetries: 3,
      tasks: [{ id: 1, description: '工作', completed: false }]
    });

    const systemPath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
    const customPath = `${MOCK_AGY_DIR}:${systemPath}`;

    const distOmaPath = path.resolve(__dirname, '../dist/bin/oma.js');
    const useDist = process.env.TEST_DIST === 'true' && fs.existsSync(distOmaPath);
    const spawnCmd = useDist ? 'node' : 'npx';
    const spawnArgs = useDist ? [distOmaPath, 'status'] : ['ts-node', OMA_PATH, 'status'];

    // 啟動 oma，啟動後會因為未完成任務而開始 2 秒黃色倒數
    const child = spawn(spawnCmd, spawnArgs, {
      env: {
        ...process.env,
        PATH: customPath,
        OMA_TODO_PATH: TODO_PATH,
        MOCK_AGY_TODO_PATH: TODO_PATH,
      }
    });

    let stdoutData = '';

    // 監聽倒數輸出後發送 SIGINT
    await new Promise<void>((resolve, reject) => {
      const onData = (data: any) => {
        stdoutData += data.toString();
        if (/[21]\.\.\./.test(stdoutData)) {
          child.stdout.off('data', onData);
          resolve();
        }
      };
      child.stdout.on('data', onData);

      child.on('close', (code) => {
        child.stdout.off('data', onData);
        reject(new Error(`程序在倒數前已結束，退出碼: ${code}`));
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

    // 應以 130 結束且無喚醒
    expect(code).toBe(130);
    expect(stdoutData).not.toContain('[SYSTEM REMINDER - TODO CONTINUATION]');
  }, 10000);
});
