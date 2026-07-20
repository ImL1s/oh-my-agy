# oh-my-agy 架構設計文件 (DESIGN.md)

本文件詳細闡述了 `oh-my-agy` 的架構設計。作為 Google Antigravity CLI (`agy`) 的外掛式超級編排與安全控制增強層，`oh-my-agy` 旨在克服大語言模型（LLM）驅動開發中的核心痛點，包括 Agent 的過早中止與逃避、Token 膨脹與燃燒、並行修改衝突以及執行期的安全威脅。

---

## 一、 專案願景與定位 (Project Vision & Positioning)

### 1. 定位
`oh-my-agy` 定位為 **Google Antigravity CLI (`agy`) 的非侵入式（Out-of-process）編排與安全防禦增強層**。它在不破壞或修改 `agy` 核心原始碼的前提下，在物理與邏輯層實施強約束，為開發者提供穩定、安全、可持續執行的代理（Agent）協同開發環境。

### 2. 核心哲學
*   **薛西弗斯執著 (Sisyphus Persistence)**：「巨石永不停止」。針對 AI Agent 常因小錯誤、速率限制或 Context 過載而提前放棄並宣稱完成（Premature Stopping）的痛點，系統透過 `Continuation Enforcer` 監控任務狀態，強制 Agent 面對未完成的待辦事項，消滅逃避行為。
*   **安全高於自主 (Security Over Autonomy)**：AI 代理（Agent）的自由度必須受到系統級約束。透過實體沙盒、唯讀探測限制、規劃階段鎖（Planning Lock）以及 Circuit Breaker（熔斷器），防止 AI 毀壞儲存庫或無休止地燃燒 Token。
*   **物理隔離與高效並行 (Physical Isolation & Parallelism)**：利用 Git Worktree 將並行任務隔離在獨立的實體路徑中，並利用 tmux 進行多路複用與程序監控，確保多 Agent 協同開發時零實體衝突。

### 3. 當前版本實作範疇 (Current Implementation Scope)
本專案的系統設計區分為「當前已實作功能」與「設計藍圖（未來規劃）」，以利明確定義開發邊界。

#### 當前已實作功能 (Currently Implemented Features)
*   **CLI 進入點 (bin/oma.ts)**：作為 CLI 進入點接管並解析命令列引數，攔截魔術關鍵字（`ralph`, `ultrawork`, `search`），將其對應模式的提示詞（System Prompt）注入，並將其餘指令透傳給實體 `agy` 指令程序。
*   **薛西弗斯任務延續執行器 (Sisyphus Continuation Enforcer)**：在 `bin/oma.ts` 執行結束時，透過 `src/enforcer.ts` 檢查 `.agy/todo.json` 中的工作項目。若有未完成的待辦任務，會先進行 2 秒黃色警告倒數，隨後注入 `[SYSTEM REMINDER - TODO CONTINUATION]` 提示詞強迫喚醒 Agent 繼續執行。
*   **死鎖熔斷器 (Deadlock Circuit Breaker)**：當同一待辦任務連續遭遇 3 次執行失敗（重試次數遞減至 0），系統會自動觸發熔斷，**只將帳本標為 `tripped` 並要求人類介入**；**禁止** `git reset --hard` / `git clean -fd`，以保護使用者工作區並阻止無謂的 Token 燃燒。
*   **confirmDangerousLaunch**：CLI 偵測 argv exact token `--madmax` / `--yolo`；TTY 需 stdin 輸入 `yes`（非 GUI 彈窗），非 TTY 需 `--i-understand-dangerous-launch`；掛載於 structured pass-through、managed final argv、legacy magic/pass-through。managed mode 與 `--` 之間未知 token 為 `E_DIRECTIVE_INVALID`。
*   **TeamOrchestrator**：`start/status/stop/supervise/reclaim/deliver/tick`；ready-queue + max-parallel；DeadProof reclaim；deliver→temp integration→FF publish→completed；AuthorityLease 於 write_scope；worker-bootstrap 啟動 agy。
*   **Runtime 防禦**：headless `maxOutputBytes` 超限 kill；可選 `maxProcessCount`；search managed launch 可走 fail-closed sandbox（`OMA_REQUIRE_SANDBOX=1`，ADR-0001）。

#### 設計藍圖 (Design Blueprint / Future Plans)
以下進階功能目前在 TypeScript 程式碼庫中尚未完整端到端出貨（零件庫可能已存在）：
*   **Git Worktree 實體路徑分配**：為多 Agent 並行協同開發（如 Conductor 模式）在 `.agy/team/{team}/worktrees/{worker}` 目錄下為每個 Worker 自動建立與分配獨立的 Git Worktree 隔離路徑。
*   **髒狀態防護與清理阻擋器 (Dirty Blockers)**：在清理工作區前執行 `git status --porcelain` 進行髒狀態判定，若有未提交的程式碼變更，則將其列為 `blockers` 並拒絕清理以保障安全。
*   **排它租約與衝突解決 Saga (AuthorityLease & Conflict Resolution Saga)**：當 Looks 視覺微調與 Works 邏輯開發並行修改同一個高度耦合檔案時， Looks 需獲取並定期更新 `AuthorityLease`。若產生衝突，自動啟動 Conflict Resolution Saga 進行分支拆解。
*   **規劃階段寫入鎖 (Planning Mode Write Block)**：在規劃階段使用 Native Hooks 攔截寫入工具；執行 `runOma` 時使用 Bubblewrap (`bwrap`) 或 `sandbox-exec` 載入限制性 Profile 作為唯讀沙盒，僅允許寫入 `.agy/plans/` 目錄。若沙盒載入失敗，實施 Fail-Closed 策略安全中斷；且在 Native Hooks 攔截 `runOma` 對 `git` 的呼叫進行系統絕對路徑安全檢驗，並阻斷任何直譯器（如 `bash`）與解碼工具（如 `base64`）呼叫以防繞過。
*   **最大日誌溢出防禦 (maxOutputBytes)**：限制 stdout 輸出累積位元組數上限，防範死迴圈 console 輸出導致硬碟空間溢出。
*   **程序炸彈防禦 (maxProcessCount)**：限制程序組內的最大程序數量，防範 Fork Bomb。
*   **唯讀探測沙盒 (Read-only Probe Sandbox)**：在 Research 模式下使用唯讀指令白名單，並搭配實體沙盒防範檔案惡意變更。

---

## 二、 架構選型與對比：Hybrid 雙軌混合模式

在設計 `oh-my-agy` 的接入模式時，我們深入評估了 **Wrapper CLI 模式** 與 **Hook-based 模式**，並最終選擇了 **Hybrid 雙軌混合模式**。

### 1. 模式對比評估

| 維度 | Wrapper CLI 模式 (指令包裹器) | Hook-based 模式 (事件掛鉤) |
| :--- | :--- | :--- |
| **定義** | 通過二進位檔或指令碼包裹實體 `agy` 指令，接管其 `stdin`/`stdout`/`stderr` 與程序生命週期。 | 註冊為 `agy` 內部外掛或掛鉤，直接在 `agy` 程序內監聽與攔截事件。 |
| **實體與程序控制** | **強**：能精準監控程序樹超時、實體記憶體、日誌溢出（maxOutputBytes）與 Fork 炸彈。 | **弱**：無法跨越實體程序邊界，難以防禦底層死鎖或 C 語言/實體級的程序炸彈。 |
| **語意與工具攔截** | **弱**：僅能從文字串流或外部狀態檔案推測 Agent 行為，攔截精度低。 | **強**：能在工具呼叫前（`PreToolUse`）或程序空閒時（`工作階段閒置`）精確獲取結構化資料並拋出異常攔截。 |
| **環境隔離** | **強**：便於在啟動 `agy` 前分配 Git Worktree 或封裝沙盒（Bubblewrap）。 | **弱**：僅能在當前程序的語境內執行，無法防護執行期的檔案變更。 |
| **終端使用者體驗** | **中**：需要處理 ANSI 終端控制序列的透傳與互動式 TUI。 | **優**：原生終端體驗，對使用者完全透明。 |

### 2. Hybrid 雙軌混合模式整合方案

為融合兩者的優勢，`oh-my-agy` 採用 **Hybrid 雙軌混合模式**：

```
                    +---------------------------------------+
                    |           用戶輸入 (CLI / Terminal)   |
                    +---------------------------------------+
                                        |
                                        v
                    +---------------------------------------+
                    |        Wrapper CLI (bin/oma.ts)       |
                    +---------------------------------------+
                    |  - 引數與 Magic Keywords 解析         |
                    |  - Git Worktree 實體路徑分配          |
                    |  - 程序樹監控、日誌溢出與超時防禦     |
                    +---------------------------------------+
                                        |
                 +----------------------+----------------------+
                 | (子程序啟動)                                | (事件/狀態交換)
                 v                                             v
  +-----------------------------+               +------------------------------+
  |    Antigravity CLI (agy)    | <-----------> |      Shared State 帳本       |
  +-----------------------------+               |     (.agy/todo.json 等)      |
  |  - 執行 Agent 邏輯          |               +------------------------------+
  |  - 呼叫本地工具             |                              ^
  +-----------------------------+                              |
                 |                                             |
                 | (原生 Hooks 觸發)                            | (讀寫狀態)
                 v                                             |
  +-----------------------------+                              |
  |    Native Hooks (src/hooks) | -----------------------------+
  +-----------------------------+
  |  - PreToolUse (規劃鎖)      |
  |  - 工作階段閒置 (待辦檢查)  |
  +-----------------------------+
```

*   **外層協調者 (`bin/oma.ts`)**：作為 CLI 進入點，負責接管實體程序。在啟動 `agy` 前分配好獨立的 Git Worktree 實體目錄，設定環境變數，並啟動程序樹監控器（處理超時、最大日誌溢出等安全防禦）。
*   **內層監聽者 (`src/hooks/` / Native Plugins)**：註冊為 `agy` 內部的原生插件，在 `PreToolUse` 事件中實現規劃寫入鎖，並在 `工作階段閒置` 事件中檢查未完成任務。
*   **非同步狀態總線**：內外層不進行強耦合的跨程序通訊（IPC），而是透過共享狀態帳本（實體儲存於工作區外的全域 App Data 目錄 / 平台 state root，或加入 `.gitignore` 的工作區外路徑）進行非同步、事件驅動的通訊，降低系統複雜度。

---

## 三、 模組架構 (Module Architecture)

`oh-my-agy` 劃分為以下五大核心模組：

### 1. CLI 進入點 (CLI Entrypoint — `bin/oma.ts`)
*   **功能**：系統的第一道關卡。
*   **引數解析**：解析使用者輸入的命令列引數與旗標（Flags）。若偵測到 `--madmax` 或 `--yolo` 等高風險標記，必須啟動二次確認彈出視窗（`confirmDangerousLaunch`）。
*   **Magic Keywords 攔截**：檢查自然語言輸入中是否包含 `ralph`（薛西弗斯自修正模式）、`ultrawork`（並行協同模式）、`search`（唯讀探測模式）等魔術關鍵字，將其轉化為對應模式的 System Prompt 拼裝，並剝離該關鍵字後，將其餘指令透傳給實體 `agy` 指令程序。
*   **事件迴圈活化計時器 (`keepAliveTimer`)**：在進行一般指令透傳（Pass-through）時，為了防止標準輸入（stdin）受到 backpressure 或長時間阻塞期間，Node.js 事件迴圈（Event Loop）因沒有其他非同步事件而提前退出，系統在主程序中建立一個虛擬的 `keepAliveTimer`（每 1 秒觸發一次的 `setInterval`），以維持事件迴圈的活性。
*   **安全結束延遲 (`safeExit`)**：在指令透傳結束時，為確保子程序輸出的大量資料在 stdout/stderr 緩衝區中被完全清空並傳送給父程序，系統呼叫 `safeExit` 機制。該機制在實際結束程序（`process.exit`）前，強制等待非同步寫入緩衝區清空，並引入 200 毫秒的延遲（`setTimeout 200ms`），確保資料不遺失。

### 2. 意圖過濾器 (Intent Filter)
*   **Markdown 去噪（`removeCodeBlocks`）**：在進行關鍵字意圖偵測前，利用正規表達式過濾掉輸入中的所有 Markdown 程式碼區塊與行內程式碼，防止使用者貼入的程式碼樣本誤觸發模式切換。
*   **諮詢性語境過濾（Informational Context Guard）**：利用中、英、日、韓多語系正規表達式（如 `"what is"`, `"如何使用"`, `"解釋"`），當偵測到使用者只是在詢問模式定義（例如 "what is ralph?"）而非下達執行指令時，`isInformationalKeywordContext` 將阻斷模式切換，保持原工作階段語境。
*   **動態提示注入**：確認意圖後，將對應模式的 System Instruction 強制注入到工作階段最前端。

### 3. 工作區管理 (Workspace Management / Git Worktree)
*   **實體路徑隔離**：當啟動多 Agent 並行協同開發時，系統會自動在 `.agy/team/{team}/worktrees/{worker}` 目錄下為每個 Worker 建立獨立 Git Worktree。
*   **髒狀態防護（Dirty Blockers）**：在清理工作區前，系統執行 `git status --porcelain` 進行髒狀態判定。若工作區內有未提交的程式碼變更，清理機制會主動將其列為 `blockers` 並拒絕清理，保障使用者程式碼安全。
*   **全域協調檔案管理**：向 Worker 工作區寫入全域協調檔案 `AGENTS.md` 前，先備份原工作區根目錄的該檔案；任務結束後自動還原。若偵測到 Agent 自行篡改備份，拋出 `agents_dirty` 錯誤阻斷後續流程。

### 4. 多代理協同 (Conductor/Delegator & Looks vs Works Saga)
*   **角色分工**：主協調者 `Conductor` 分發任務，唯讀角色 `Oracle`（戰略顧問）與 `Librarian`（文獻檢索）提供決策引導，`Frontend UI/UX` 負責外觀，`Sisyphus` 執行邏輯開發。
*   **Looks 與 Works 分離**：視覺微調（Looks）與邏輯開發（Works）並行。
*   **排它租約與衝突解決 Saga**：並行修改同一個高度耦合檔案（如 React 元件）時，系統使用基於檔案鎖的排它租約 `AuthorityLease`（acquire/renew 機制）。Looks 與 Works 同時寫入變更時，先利用 Git 三路合併（3-way merge）自動融合；若產生實體程式碼交織衝突，則暫停 Looks 執行，啟動 `Conflict Resolution Saga` 進行分支拆解與人工/Oracle 協調解鎖。

### 5. 薛西弗斯執行器 (Continuation Enforcer — `src/enforcer.ts`)
*   **監聽機制**：監聽 `工作階段閒置` 事件，讀取 `.agy/todo.json` 中的待辦事項。
*   **介面契約**：符合以下 `ContinuationResult` 介面契約：
    ```typescript
    interface ContinuationResult {
      shouldContinue: boolean;
      prompt?: string;
      status: 'idle' | 'continuing' | 'tripped';
      remainingRetries: number;
    }
    ```
*   **歷史進度快取機制 (`.agy/todo.json.completed`)**：為了精確判斷任務進度是否有實質推進，Enforcer 在待辦檔案同目錄下維護一個已完成任務識別碼（ID）的歷史快取檔案 `.agy/todo.json.completed`。在每次執行完畢進行判定時，會比對執行後與執行前已完成任務 ID 的數量變化，以及當前已完成任務 ID 的集合與快取檔案中已快取的 ID 集合。若確認有進度推進，將會重置剩餘重試計數器 `remainingRetries` 為 3，並更新快取與 stableCommit。
*   **喚醒警告**：若偵測到 incomplete todos，倒數 2 秒警告（Warnings Toast）。若無人工介入或 Assistant 主動響應，則將 `shouldContinue` 設為 `true`，注入喚醒提示詞（如 `[SYSTEM REMINDER - TODO CONTINUATION]`），強制重啟推理環。

---

## 四、 死鎖與安全防禦 (Deadlock & Security Defense)

本專案設計了多層防禦結構，確保 Agent 在面臨編譯失敗、程式碼衝突或惡意程式碼注入時，系統仍能保持高可用性。

```
+-----------------------------------------------------------------------------------+
|                            Security Defense Matrix                                |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  [邏輯層防禦]                                                                     |
|    - 規劃寫入鎖 (Planning Lock): 規劃階段 PreToolUse 攔截 Write/Edit 工具         |
|    - 排它租約 (AuthorityLease):Looks vs Works 並行寫檔實施租約排他性               |
|                                                                                   |
|  [死鎖與 Token 防禦]                                                              |
|    - Circuit Breaker (熔斷器): 單一 Todo 失敗 3 次/狀態無進展 -> Trip 熔斷        |
|    - 熔斷策略: 僅標記 tripped + 診斷；禁止 git reset --hard / git clean（保使用者工作） |
|                                                                                   |
|  [實體與執行期防禦]                                                               |
|    - 程序樹超時 (SIGKILL): 實體程序樹超時監控, 掃除孤兒孫程序                     |
|    - 日誌溢出 (maxOutputBytes): stdout 輸出限制, 阻斷無限輸出迴圈                 |
|    - 程序炸彈防禦 (maxProcessCount): 阻斷 Fork 炸彈                               |
|    - 唯讀探索沙盒: 唯讀指令白名單 + Bubblewrap (Linux) 沙盒                       |
|                                                                                   |
|+-----------------------------------------------------------------------------------+
```

### 1. Token 燃燒死循環防禦 (Circuit Breaker 熔斷器)
*   **熔斷觸發條件**：
    1. 單一 Todo 項目連續 3 次遭遇編譯或測試失敗；
    2. Enforcer 喚醒後，狀態無實質前進（即重試次數消耗完畢）。
*   **租約等待期豁免與契約對應**：當 Works 處於等待 Looks 租約釋放的階段（`Lease Waiting` 狀態），為了完全符合 `ContinuationResult` 介面契約的狀態限制：
    1.  **安全契約對應**：Enforcer 將 Works 的狀態安全對應為 `status: 'idle'` 且 `shouldContinue: false`。此時重試計數器（`remainingRetries`）凍結不扣減，熔斷判定暫停。這可避免 Works 在等待期間因無動作被誤判為無進展，同時防止 Wrapper CLI 在輪詢中空轉以節省 Token。
    2.  **主動與事件雙重喚醒**：為了防止 Works Agent 永久睡眠掛起，系統實施以下喚醒路徑：
        *   **Enforcer 主動檢測**：Enforcer 的外部監控程序主動定期檢測共享帳本中 Looks 的 `busy` 狀態。一旦 `busy` 變為 `false`，即將 Works 的狀態切換回 `'continuing'`，將 `shouldContinue` 設為 `true` 並重新注入喚醒提示詞。
        *   **事件驅動喚醒**：Looks 釋放租約時，主動向共享帳本寫入租約釋放事件，由外層 Wrapper CLI 接收事件後，發送訊號重新喚醒 Works Agent。
*   **租約等待超時與 Looks 心跳監控（Lease Wait Timeout & Looks Heartbeat）**：為防範 Looks 死鎖或崩潰導致 Works 永久掛起，系統引入以下防禦機制：
    1.  **等待最大超時（Lease Wait Timeout）**：設定 `maxLeaseWaitTime`（上限 300 秒）。若 Works 處於 `Lease Waiting` 超過 300 秒，將自動解除豁免，將狀態設為 `'tripped'`（熔斷），強制執行還原流程並尋求人工介入。
    2.  **Looks 心跳監控（Looks Heartbeat）**：Looks 執行長任務期間，必須每 10 秒在 帳本 中更新 `last_active` 時間戳記。
    3.  **主動回收與程序清理（Active Reclamation & SIGKILL）**：若 Works 檢測到 Looks 處於 `busy` 狀態且 `currentTime - last_active > 30` 秒，判定 Looks 已失聯。外層 Wrapper CLI 將向 Looks 的程序組 ID（PGID）發送 `SIGKILL` 徹底清理 Looks 的殭屍程序，重置 `busy` 為 `false` 並回收租約，解除 Works 的等待狀態。**Looks 在長任務（如 UI 渲染、編譯或長測試）執行前，必須在 帳本 中設定預期耗時與租約承諾（Lease Expectation / Lease Promise）或宣告「長時間阻塞模式」；Works / Wrapper CLI 必須優先讀取此預期，動態延長心跳超時閾值，防止 GC 或 I/O 阻塞造成的誤殺。**
*   **熔斷與 Saga 還原流程**：
    1.  **熔斷狀態變更**：Continuation Enforcer 停止注入喚醒 Prompt，將系統狀態設為 `tripped`（滿足 `ContinuationResult` 中 `status: 'tripped'` 的契約）。
    2.  **保留使用者工作（安全熔斷）**：熔斷時**不得**執行 `git reset --hard` / `git clean -fd` / 強制 checkout。只將帳本更新為 `'tripped'` 並輸出診斷，由人類決定如何處理工作區。**帳本的所有讀寫操作必須採用檔案互斥鎖（File Lock）機制。** 狀態帳本與重試計數器應存放在工作區外或已 gitignore 的路徑，避免與使用者內容混寫。
    3.  **終止執行並通知**：立即退出執行迴圈，並同時發送終端黃色高亮警告與桌面通知，強制要求人類介入（Human-in-the-loop），徹底阻斷 Token 的無效燃燒。

### 2. 規劃階段寫入鎖 (Planning Mode Write Block)
*   **機制**：強迫 AI 遵循「先規劃、後實作」的工程紀律。
*   **攔截設計**：在原生 Hook 的 `PreToolUse` 事件中，若系統偵測到 AI 目前處於 **Planning Phase**，則執行以下三重鎖定防禦：
    1.  **直接寫入工具限制**：呼叫程式碼修改工具（如 `Write`、`Edit`、`apply_patch`）時，若修改對象非經核准的規劃檔案（`.agy/plans/` 目錄），則攔截器直接拋出異常阻斷執行。
    2.  **規劃期 Defense-in-depth（縱深防禦）防禦**：全面廢除脆弱的正規表達式指令列黑名單，改採實體沙盒與呼叫限制防禦：
        *   **實體沙盒隔離 (Sandboxing) 與 Fail-Closed 策略**：規劃階段下，外層 Wrapper CLI 執行 `run_command` 時，必須將子程序置入實體沙盒。在 Linux 上使用 Bubblewrap (`bwrap`) 唯讀掛載除 `.agy/plans/` 以外的所有目錄；在 macOS 上使用 `sandbox-exec` 載入限制性 Profile，限制為唯讀掛載，僅允許寫入 `.agy/plans/` 目錄，從實體層阻斷對儲存庫的篡改。**在規劃階段實施 Bubblewrap 或 sandbox-exec 實體沙盒時，若初始化或載入失敗，系統必須執行 Fail-Closed/Fail-Secure 策略，直接拋出安全異常並中止程序執行，嚴禁無沙盒保護的 Fallback 降級執行。**
        *   **工具禁用與路徑校驗白名單**：Native Hooks 在 `PreToolUse` 階段，預設**完全禁止**呼叫 `run_command` 工具。**規劃階段 PreToolUse 時禁止呼叫 run_command，或限制其僅能呼叫 git 唯讀白名單。若呼叫 run_command 執行 git 白名單，必須強制執行系統絕對路徑安全檢驗（如僅允許 `/usr/bin/git`），比對 inode 與 canonical path，嚴禁呼叫任何臨時目錄、可寫目錄或相對路徑的 git 複製檔與 symlink。**
        *   **直譯器與解碼工具阻斷**：Native Hooks 解析 `CommandLine` 引數，若偵測到呼叫直譯器（`bash`、`sh`、`zsh`、`python`、`node`、`perl`、`ruby` 等） 或解碼工具（`base64`、`openssl`、`xxd` 等），無論其上下文為何，一律直接阻斷，以防 AI 透過動態解碼或直譯腳本繞過限制。

### 3. Looks 與 Works 並行排它租約與 Git 三路合併
*   **租約機制與防搶占機制**：多個 Agent 並行工作時，Looks Specialist 與 Works Sisyphus 對高度耦合的前端檔案修改需透過 `AuthorityLease`。Looks 必須先 `acquire-authority` 獲取租約，並通過獨立執行緒（Worker Thread）或背景子程序定期 `renew-authority`，以防編譯/測試等長任務阻塞主事件迴圈。同時，在 Looks 執行編譯或測試期間，Looks 會在共享狀態 帳本 中設定 `busy` 狀態；當 Works 欲在 Looks 租約超時後搶占時，若偵測到 Looks 處於繁忙狀態，將**暫停租約超時倒數（凍結租約）**或**自動延長租約寬限期**，並**將 Works 狀態標記為 `Lease Waiting`**。此時 Enforcer 將 Works 狀態安全對應為 `status: 'idle'`，`shouldContinue` 設為 `false`，以掛起 Works Agent。Enforcer 會暫停熔斷判定與重試計數器扣除，以防止租約過期被搶占引發 Concurrent write 並行衝突，並杜絕 Works Agent 在等待期間因無進展而被誤判熔斷。當 Looks 釋放租約（`busy` 變為 `false`）時，外層 Wrapper CLI 發送租約釋放事件或由 Enforcer 主動檢測 busy 狀態以重新喚醒 Works Agent，將其狀態切換回 `continuing`。引進等待超時上限與 Looks 心跳機制，以防死鎖。Works 進入 `Lease Waiting` 最長 300 秒，超時即解除豁免轉為 `'tripped'` 熔斷。Looks 需定期更新 `last_active` 心跳，失聯超過 30 秒則由 Wrapper CLI 向其 PGID 發送 `SIGKILL` 清理殭屍程序並回收租約。
*   **自動合併與退回**：Looks 與 Works 修改同一個檔案時，優先透過 Git 三路合併（3-way merge）融合。若發生實體程式碼衝突（衝突塊判定失敗），則掛起 Looks，啟動 Conflict Resolution Saga，將變更隔離至臨時分支，交由 Conductor 拆解。

### 4. 執行期實體防禦 (Runtime Physical Defense)
*   **實體程序樹超時 (Process Tree Timeout)**：
    *   **實現**：在 macOS/Unix 環境下啟動子程序時，必須在 `spawn` 時將 `detached` 選項設為 `true`，以啟用獨立的程序組（Process Group）隔離，此時子程序的 PID 即為其程序組 ID (PGID)。不使用標準的 `setTimeout` 來終止單一程序，而是使用 `runProcessTreeWithTimeout`。
    *   **機制**：當檢測到超時或需要熔斷清理時，向該程序組 ID 發送 `SIGKILL`（以 `-child.pid` 的形式），確保該程序及其拉起的所有子程序、孫程序（包括編譯、測試程序）被乾淨、徹底地清除，同時防範波及外層協調者（Wrapper CLI）程序，杜絕殭屍程序與孤兒程序。
*   **最大日誌溢出防禦 (`maxOutputBytes`)**：
    *   **機制**：為避免 AI 程式碼陷入 `while(true) { console.log(...) }` 等 stdout 死迴圈輸出，導致系統硬碟空間或記憶體緩衝區溢出，CLI 監控程序 stdout 的累積位元組數。一旦超過 `maxOutputBytes` 閾值，立即強制中斷程序。
*   **程序炸彈防禦 (`maxProcessCount`)**：
    *   **機制**：在 Linux 環境下限制程序組的最大程序數量，阻斷 Fork 炸彈程序炸彈的實體危害。
*   **唯讀探測沙盒 (Read-only Sandbox)**：
    *   **機制**：在 Research（調研）模式下，Agent 的命令列權限被降級至唯讀。系統僅允許呼叫 `rg`、`grep`、`ls`、`cat`、`find` 等白名單唯讀指令。
    *   **隔離實現**：在 Linux 環境下，若系統存在 `bwrap` 命令，則利用 Bubblewrap 進行實體目錄映射隔離；在 macOS 環境下，則降級為擦除敏感環境變數與 PATH 限制隔離，防止 Agent 在探測階段修改系統設定或洩漏金鑰。
