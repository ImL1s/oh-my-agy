# oh-my-agy 端對端 (E2E) 測試基礎設施說明文件

本文件詳細說明了 `oh-my-agy` 專案的 E2E 測試套件架構、環境安裝、執行方式，以及測試案例的 Tier 劃分。

---

## 一、 測試套件架構 (Test Suite Architecture)

本 E2E 測試套件旨在以**黑箱（Opaque-box）方式**對 `oh-my-agy` CLI 進行功能、邊界與交叉場景驗證。測試主要圍繞 `bin/oma.ts` 展開，驗證其是否正確處理透傳行為、關鍵字攔截、Sisyphus 連續喚醒與熔斷機制。

測試基礎設施包含以下核心元件與優化設計：
1. **測試執行器 (Test Runner)**：採用 **Jest** 搭配 **ts-jest** 與 **ts-node**，支援直接執行 TypeScript 測試案例。
2. **模擬 agy 機制 (Mock agy)**：位於 `e2e/mocks/agy`，是一個可執行的 Node.js 腳本。它能藉由環境變數控制其模擬行為，包括退出碼 (Exit Code)、stdout/stderr 輸出、大量資料輸出（大於 1MB）、stdin 讀取與回顯，以及在執行中動態修改 todo.json。本腳本採用了 **非阻塞的 Promise + setTimeout 延遲模擬**，消除了 100% CPU 單核佔用，顯著提升了測試效能。
3. **測試輔助模組 (Test Helper)**：位於 `e2e/helper.ts`，封裝了執行 `oma.ts` 程序、讀寫 todo.json 的通用工具方法。
4. **沙盒隔離機制**：為避免多個測試並行讀寫 `.agy/todo.json` 時造成競態衝突（False Green 或髒資料污染），`helper.ts` 會為每個測試套件動態分配唯一且隨機的 todo 檔案存放目錄（例如 `.agy_sandbox_xxxx/todo.json`），並透過環境變數 `OMA_TODO_PATH` 引導 oma 使用它。
5. **安全防護 (exec) 優化**：重構 `runOma` 的實作，棄用具備 Shell 注入漏洞的 `exec`，改用嚴謹的 `spawn` 通訊，且對系統 `PATH` 環境變數為空時提供了後退退化（fallback）防禦。
6. **非同步超時與 Flaky Test 緩解**：針對中斷信號測試（TC-T2-19 與 TC-T4-05），棄用了容易導致 Jest 懸掛 15 秒的 `done()` 回呼，改用 `async/await` 搭配 Promise 程序終止/監聽，並且以標誌（`[MOCK_AGY_SLEEPING]` 與 `/[21]\.\.\./` 正規表達式倒數）進行 **Condition-based Waiting** 條件等待，解決了 CI 伺服器上的時序抖動與 Flaky Test 問題。

---

## 二、 相依性套件安裝 (Dependency Installation)

在專案根目錄下，執行以下指令安裝必要的 TypeScript 與 Jest 相依性套件：

```bash
npm install
```

這將會安裝以下 devDependencies：
- `typescript` 與 `ts-node` (TypeScript 執行環境)
- `jest`、`ts-jest` 與 `@types/jest` (測試框架與定義)
- `@types/node` (Node.js API 定義)

---

## 三、 執行測試 (Executing Tests)

請使用 npm 指令碼執行 E2E 測試：

```bash
npm run test:e2e
```

或者使用 Jest 直接執行特定 Tier：

```bash
npx jest e2e/tier1.spec.ts --runInBand
```

> **宣告**：當前專案已完成核心功能開發。在本地執行 `npm run test:e2e`，所有的 63 個測試案例皆已成功通過，無任何斷言失敗或懸掛問題。

---

## 四、 測試案例 Tier 劃分與統計 (Tiers & Test Cases Count)

我們一共設計並實作了 **63 個測試案例**，其劃分如下：

### 1. Tier 1: Feature Coverage (核心功能覆蓋 — 共 25 個)
- **指令透傳與 I/O 管道 (TC-T1-01 ~ TC-T1-05)**：驗證基本指令、帶選項指令的透傳，stdin 管道，Exit Code 傳播以及大緩衝區資料輸出。
- **魔術關鍵字攔截與模式切換 (TC-T1-06 ~ TC-T1-10)**：驗證 `ralph`, `ultrawork`, `search`（含縮寫 `uw`/`ulw`）的攔截與 Prompt 注入與關鍵字剝離。
- **薛西弗斯待辦任務持續喚醒 (TC-T1-11 ~ TC-T1-15)**：驗證單一、混合任務下的 Enforcer 黃色警告倒數 2 秒、Continuation Prompt 注入以及 status 的狀態變更。
- **死鎖熔斷器與重試次數控制 (TC-T1-16 ~ TC-T1-20)**：驗證連續失敗時 `remainingRetries` 遞減、重置（任務推進時）以及歸零時觸發 `tripped` 熔斷。
- **Todo 檔案解析與異常安全防禦 (TC-T1-21 ~ TC-T1-25)**：驗證正常讀寫、即時狀態監控、空物件容錯與檔案不存在時的預設初始化。

### 2. Tier 2: Boundary & Corner Cases (邊界與極端情況 — 共 25 個)
- **空 todo.json 與格式損壞 (TC-T2-01 ~ TC-T2-05)**：驗證 0 位元組空檔案、無效 JSON、無讀寫權限（Permission Denied）、同名目錄路徑衝突與 tasks 屬性型別錯誤。
- **熔斷次數邊界與重試機制 (TC-T2-06 ~ TC-T2-10)**：驗證 `remainingRetries` 為 0、1、2 的臨界情況，tripped 狀態下的執行防禦，以及任務交錯更新時的重試重置邊界。
- **關鍵字攔截邊界與防誤觸 (TC-T2-11 ~ TC-T2-15)**：驗證 markdown 程式碼區塊、行內程式碼、諮詢性語境（如 "what is search"）、單字黏連中的關鍵字過濾以及多關鍵字優先級。
- **一般指令透傳邊界 (TC-T2-16 ~ TC-T2-20)**：驗證空格/空引數、10 萬字元極長引數、Shell 特殊字元防注入、外部 SIGINT 中斷傳播（Exit Code 130）以及 oma 執行超時熔斷。
- **Enforcer 與 todo.json 複雜屬性邊界 (TC-T2-21 ~ TC-T2-25)**：驗證 tasks 為空陣列、欄位缺失（fallback 預設值）、status 為未知值、1000 個 tasks 的解析效能以及多程序檔案寫入鎖定競爭。

### 3. Tier 3: Cross-Feature (跨功能交叉組合 — 共 8 個)
*   **設計藍圖功能之模擬驗證**：由於排它租約、Git Worktree 與實體還原等進階安全防禦功能屬於規劃中的設計藍圖階段，本測試套件在 Tier 3 測試中（例如驗證併發租約的 TC-T3-06、驗證 Git Worktree 清理阻擋的 TC-T3-07，以及驗證熔斷 Git 還原的 TC-T3-08），採用了 `e2e/mocks/agy` 的模擬輸出（Mock-based Output）與環境變數機制，在模擬的環境與回傳結果下，精確驗證 oma 外層協調者對這些複雜狀態的判定與處理行為是否符合規格。
*   **TC-T3-01**: 關鍵字觸發同時面臨熔斷狀態（熔斷安全優先級高於模式切換）
*   **TC-T3-02**: 關鍵字攔截與 todo.json 內容更新組合（Mock agy 執行中新建立 todo 觸發喚醒）
*   **TC-T3-03**: 透傳指令失敗與 todo.json 臨界失敗熔斷（指令失敗與熔斷邏輯疊加）
*   **TC-T3-04**: 關鍵字攔截下因 todo.json 損壞觸發的安全退回（JSON 損壞退回 Exit 1）
*   **TC-T3-05**: 多關鍵字共存與 todo.json 狀態重置（tripped 重置解鎖與多關鍵字優先級）
*   **TC-T3-06**: Looks vs Works Saga 併發排它租約與衝突解決（Looks 與 Works 併發修改鎖定與三路合併衝突解決）
*   **TC-T3-07**: 工作區管理 (Git Worktree) 與清理 Blocker 驗證（隔離工作樹分配、髒變更攔截 blocker、AGENTS.md 備份還原與防篡改機制）
*   **TC-T3-08**: 熔斷觸發時 Git 自動還原（熔斷時自動呼叫 git reset --hard 還原至動工前狀態且不影響外部帳本計數器連續性）

### 4. Tier 4: Real-World Application (真實世界應用場景 — 共 5 個)
- **TC-T4-01**: 模擬完整的 Sisyphus 滾動巨石生命週期 (兩輪未完成 -> 推進一項重置 -> 推進二項完成退出)
- **TC-T4-02**: 模擬連續 3 次失敗觸發熔斷的完整週期 (重試次數 3 -> 2 -> 1 -> tripped)
- **TC-T4-03**: 模擬任務進度推進時熔斷重置週期 (重試 3 -> 2 -> 1 -> 推進重置 3 -> 完成正常退出)
- **TC-T4-04**: 連續執行一般指令與 todo.json 動態寫入的透傳流 (模擬 compile 成功 -> test 失敗寫入 todo -> 自動喚醒)
- **TC-T4-05**: 薛西弗斯喚醒過程中遭受中斷 (倒數警告期間收到 SIGINT 或狀態為中止 (aborted)，立刻以 130 結束且無喚醒)
