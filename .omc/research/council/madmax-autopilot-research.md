# Madmax Gate + Autopilot Process Drive — 缺口地圖

**狀態：** research-only（無 code edit）  
**日期：** 2026-07-20  
**倉庫：** `/Users/iml1s/Documents/mine/oh-my-agy`  
**依據：** 原始碼 + 單元測試 + `DESIGN.md` / `research_report.md` / `fable5-full-review.md` / Team plan out-of-scope 註記  
**Agent 定位：** omg-analyst 唯讀盤點；權威路徑仍是後續 `omg interview` / 實作 plan，本檔僅 advisory。

---

## 0. 一句話結論

| 主題 | 現況 | 缺口本質 |
|------|------|----------|
| **(A) madmax / yolo / confirmDangerousLaunch** | **DESIGN_ONLY** | `src/` + `bin/` **零**偵測、零確認；危險旗標等同裸 `agy`。另有 managed parser **`--` 前 token 靜默丟棄**。 |
| **(B) Autopilot process drive** | FSM ledger **COMPLETE**；程序驅動 **ABSENT** | 9 個子命令全接 CLI，但只改 `SessionAggregate`。`ManagedInvocationService.resumeConversation` 有完整實作與單元測試，**無 production CLI 呼叫者**。 |

Team orchestrator v1 plan 已明確把這兩項列為 **out of scope**（`docs/superpowers/plans/2026-07-20-team-orchestrator-v1.md` L11、L987）。

---

## 1. (A) Madmax / confirmDangerousLaunch

### 1.1 規格來源（文件 vs 程式）

| 來源 | 內容 | 程式對應 |
|------|------|----------|
| `DESIGN.md:27`（藍圖） | 偵測 `--madmax` / `--yolo` → `confirmDangerousLaunch` | **無** |
| `DESIGN.md:102`（模組架構語氣） | 「**必須**啟動二次確認」 | **無**（易造成已實作錯覺） |
| `research_report.md:293` | 描述 **oh-my-codex VSCode** 行為：高危標記需 `confirmDangerousLaunch` | 同概念移植意圖，非 OMA 實作 |
| `README.md` / CLI_HELP | 未列 madmax/yolo | — |
| `src/**` / `bin/**` | `rg madmax\|yolo\|confirmDangerous` | **零命中**（與 fable5 §3 一致） |
| e2e | 無 madmax 案例 | — |

**判定：** DESIGN_ONLY。不是 stub、不是 partial library。

### 1.2 雙路徑入口（argv 從哪進）

```
process.argv.slice(2)
        │
        ├─ shouldUseStructuredCli? ──YES──► runCli(parseCliArguments) → services
        │     triggers:
        │       --help/-h/--version/-v
        │       autopilot|team|setup|doctor
        │       ralph|ultrawork|search AND args includes '--'
        │
        └─ NO ──► legacy bin/oma.ts
                    ├─ magic keyword (ralph/uw/search) → spawn agy(remainingArgs) + enforcer
                    └─ else pass-through → spawn agy(full args) + enforcer
```

證據：`bin/oma.ts:62-74`、`127-131`、`169-234`、`257-271`；`src/cli/parser.ts`；`src/cli/application.ts`；`src/cli/services.ts`。

**重要：** gate 若只掛在 structured `runCli`，legacy 路徑（多數自然語言 / 透傳）會完全繞過。

### 1.3 各 argv 形狀的**實際**行為

| # | 輸入形狀 | 走哪條路 | 對 agy 的 argv | 確認 gate | 備註 |
|---|----------|----------|----------------|-----------|------|
| 1 | `oma --madmax …` / `oma foo --yolo` | legacy pass-through | **原樣含危險旗標** | **無** | `ordinaryEnvironment` 只剝 `OMA_SESSION_ID` / `OMA_LAUNCH_NONCE` / `OMA_INVOCATION_GENERATION` / `OMA_WORKSPACE_PATH` |
| 2 | `oma ralph --madmax task`（**無** `--`） | legacy magic | 剝 `ralph` 後 `['--madmax','task']` | **無** | 危險旗標直接進 agy |
| 3 | `oma ultrawork --yolo do-it`（無 `--`） | legacy magic | 剝 keyword 後含 `--yolo` | **無** | 同上 |
| 4 | `oma ralph --madmax -- task` | **structured** mode | `buildModeCommand` 產 directive argv；**task=`task`** | **無** | **`--madmax` 靜默丟棄**（見 §1.5） |
| 5 | `oma ralph -- --madmax task` | structured mode | directive 內 task 文字含字面 `--madmax task` | **無** | 不是 agy CLI flag；是否算「危險」屬產品決策 |
| 6 | `oma search -- --yolo …` | structured mode | search 前綴 + directive；task 含字面 | **無** | 同 #5 |
| 7 | `oma -p "… --madmax …"` | pass-through | 原樣 | **無** | 旗標在 prompt 字串內，通常**不應**當 CLI 危險旗標 |
| 8 | `oma autopilot …` / `team` / `setup` / `doctor` | structured 子命令 | 不 spawn agy（autopilot 現況）或自有路徑 | n/a | 除非未來 process drive 把 flag 轉發 |
| 9 | structured `passthrough`（`runCli` 非 mode/子命令） | `services.passThrough` | 原樣 + strip binding | **無** | 與 legacy 雙實作（`services.ts:58-64` vs `bin/oma.ts`） |

結論：**任何會把 `--madmax`/`--yolo` 當獨立 token 交給 `agy` 的路徑，今日都零 gate。**  
唯一「不會進 agy 的危險旗標」反而是 #4 的靜默丟棄——那是 bug，不是安全控制。

### 1.4 安全意涵

| 面向 | 評估 |
|------|------|
| 是否放大權限 | **否**。OMA 未新增 capability；pass-through 還剝 managed binding env。 |
| 是否提供宣稱的防護 | **否**。風險面 ≡ 直接跑 `agy --madmax/--yolo`。 |
| 虛假安全感 | **是**。`DESIGN.md:102` 用規格語氣寫「必須」二次確認，但 runtime 無此防線。 |
| 繞過面（若只修一半） | (a) 只修 structured、不修 legacy；(b) 只偵測前綴、不掃完整 argv；(c) 靜默丟棄讓「以為擋了」其實沒轉發也沒警告。 |
| 非 TTY / CI | 今日無確認 → 腳本可無摩擦帶危險旗標；實作後必須定義 fail-closed，否則仍可無人值守危險啟動。 |

### 1.5 Parser silent-drop bug（`--` 前 token）

**位置：** `src/cli/parser.ts:22-33`

```ts
const delimiter = argv.indexOf('--', 1);
const taskArgs = delimiter >= 0 ? argv.slice(delimiter + 1) : argv.slice(1);
// mode 與 '--' 之間的 token 完全不讀、不報錯、不轉發
```

| 輸入 | 解析結果 | 問題 |
|------|----------|------|
| `ralph --madmax -- ship` | mode=ralph, task=`ship` | `--madmax` 消失 |
| `ralph --foo --bar -- ship` | task=`ship` | 任意未知 token 消失 |
| `ralph -- ship` | task=`ship` | 正確 |
| `ralph --` | invalid empty task | 正確 |

**為何與 madmax gate 相關：**

1. 使用者寫 `oma ralph --madmax -- task` 期望「危險模式 + managed task」→ 實際既無確認、也無 flag 轉發。  
2. 若 gate 只掃最終 `agy` argv，此形狀永遠掃不到 `--madmax`。  
3. 修 gate 時**必須**先（或同時）把「mode 與 `--` 之間非空 token」改成 `E_DIRECTIVE_INVALID`（或明確白名單），否則確認 UX 與真實 argv 不一致。

**現有測試缺口：** `tests/cli/parser.spec.ts` 只覆蓋「`--` 後 task 保留 flag」、空 task、passthrough；**沒有**「`--` 前多餘 token 應拒絕」案例。

### 1.6 建議 flag 清單（初版）

文件只點名：

| Flag | 來源 | 建議處置 |
|------|------|----------|
| `--madmax` | DESIGN / research_report / fable5 | **必掃** |
| `--yolo` | 同上 | **必掃** |

**刻意不納入初版（除非 interview 擴充）：**

- 短別名（如 `-y`）— 文件未列，避免誤傷  
- prompt / task **字串內部**出現的字面量 — 應只比 **argv token**  
- agy 其他高風險旗標 — 無 OMA 文件依據；擴充需獨立決策  

**建議掃描範圍（完整 argv token 集合）：**

1. legacy pass-through：`args`  
2. legacy magic：`remainingArgs`（剝 keyword 後）  
3. structured pass-through：`command.args`  
4. structured mode：`mode` 與 `--` **之間**的 tokens（目前被丟的那一段）+ 是否允許 task 內 flag（建議否）  
5. 未來 autopilot process drive 轉發給 agy 的 argv  

### 1.7 建議 gate 設計

**模組草圖（尚未實作）：** `src/cli/dangerous-launch.ts`（或 `confirm-dangerous-launch.ts`）

```
detectDangerousFlags(argv) → { flags: string[] } | null
confirmDangerousLaunch(flags, io, env, isTty) → Result<void, RuntimeError>
```

| 環境 | 建議行為 | Exit / code |
|------|----------|-------------|
| **TTY**（`stdin.isTTY && stdout.isTTY`） | stderr 列出旗標 + 風險說明；讀一行；僅 `yes` / `YES` 放行（或 `y` 若 interview 允許） | 拒絕 → exit `1`，code `E_DANGEROUS_LAUNCH_REJECTED` |
| **non-TTY**（CI、pipe、背景） | **fail-closed**：禁止啟動 | exit `1`，`E_DANGEROUS_LAUNCH_UNCONFIRMED` |
| **明確覆寫**（可選，需 interview） | 例如 `OMA_CONFIRM_DANGEROUS=1` 或 `--i-confirm-dangerous-launch` **再**允許 non-TTY | 審計：應寫 stderr 一行「confirmed via env/flag」 |
| **否定覆寫** | 不建議「環境變數默認允許」；預設安全 | — |

**掛載點（必須全覆蓋）：**

| 路徑 | 檔案 | 掛載時機 |
|------|------|----------|
| Structured pass-through / mode launch | `application.ts` 或 `services.ts` | **spawn 前**；mode 在 `launchMode` 前 |
| Legacy magic + pass-through | `bin/oma.ts` | **spawn('agy') 前**；與 structured 共用同一 detect/confirm 函式，避免雙實作漂移 |
| Autopilot drive（未來） | services / runtime wiring | spawn 前同樣掃描轉發 argv |

**不該做：**

- 只在 HELP 加警告、runtime 不擋  
- 偵測到 flag 後靜默剝除（與「使用者明確要危險模式」衝突；正確是 **確認後放行原 argv**）  
- 在 task 字串做 substring 匹配 `--madmax`（誤殺）

### 1.8 Madmax 垂直切片（建議）

| Slice | 內容 | 檔案 | 測試 |
|-------|------|------|------|
| **M0** | 抽出 `DANGEROUS_LAUNCH_FLAGS` + `detectDangerousFlags` | **新增** `src/cli/dangerous-launch.ts` | **新增** `tests/cli/dangerous-launch.spec.ts` |
| **M1** | parser：mode 與 `--` 之間有 token → `E_DIRECTIVE_INVALID` | `src/cli/parser.ts` | `tests/cli/parser.spec.ts` |
| **M2** | TTY confirm + non-TTY fail-closed | `dangerous-launch.ts` + inject `CliIo`/readline port | unit：mock TTY/non-TTY |
| **M3** | structured `runCli` 掛 gate（pass-through + mode） | `application.ts` 和/或 `services.ts` | `tests/cli/application.spec.ts` |
| **M4** | legacy `bin/oma.ts` 掛同一 gate | `bin/oma.ts` | e2e 或 thin unit via export；至少 mock-spawn 層 |
| **M5** | 文件誠實化 | `DESIGN.md`（藍圖→已實作）、`README` 可選 | 無 |

**可測 acceptance（建議）：**

1. `oma --yolo -p hi` 在 non-TTY → exit ≠ 0，stderr 含危險旗標，**不** spawn agy。  
2. TTY 回 `no` → 不 spawn；回 `yes` → spawn 且 argv 仍含 `--yolo`。  
3. `oma ralph --madmax -- task` → `E_DIRECTIVE_INVALID`（不再靜默）。  
4. `oma ralph -- task` 無危險旗標 → 行為與今日一致。  
5. 普通 `oma -p "explain --madmax flag"`（單一 token 字串）→ **不**觸發 gate。

---

## 2. (B) Autopilot process drive

### 2.1 已有 vs 缺失

#### 已有（durable gate ledger — COMPLETE）

| 子命令 | 行為 | Spawn agy? |
|--------|------|------------|
| `start -- <goal>` | 建 `SessionAggregate` + `goal.txt`；phase=`requirements` | **否** |
| `status` | 讀 view JSON | 否 |
| `doctor` | view + diagnosis | 否 |
| `checkpoint` / `review` / `qa` | 讀 evidence 檔 → GateValidator → CAS phase 推進 | 否 |
| `resume` | CAS：寫 `binding.conversationId`；state→`resume_pending`（若非 bound）；清 blocker | **否** |
| `cancel` | terminal cancelled | 否 |
| `reset-breaker` | tripped → lastActivePhase | 否 |

配線：`bin/oma.ts` → `runCli` → `services.autopilotCommand` → `AutopilotRuntime.dispatch`。  
測試：`tests/autopilot/commands.spec.ts`、`tests/autopilot/runtime.spec.ts`。

#### 已有但斷頭（library — 有 caller 只在 tests）

| API | 行為 | Production caller |
|-----|------|-------------------|
| `ManagedInvocationService.resumeConversation(sessionId, conversationId, expectedRevision)` | preflight → `prepareResume` → `agy --conversation <id>` + exact_env | **無**（僅 `tests/cli/managed-invocation.spec.ts`） |
| `RuntimeManagedTransactionAdapter.prepareResume` | `SessionLocator.prepareResume` + sessionId 交叉驗證 | 僅被 managed service 使用 |
| `SessionLocator.prepareResume` | 要求 **已 bound**；CAS → gen+1、`resume_pending`、新 launchNonce | locator 單元測試有 |

#### 明確非目標（現階段）

- Autopilot **自動**寫 gate evidence（仍應外部 runner 產檔）  
- 完整多 phase 無人迴圈 / supervisor  
- Team tmux worker 內嵌 autopilot（屬 Team plan）  
- 把 checkpoint/review/qa 改成 spawn（應維持 ledger）

### 2.2 子命令分類：純 ledger vs 應 spawn

| 子命令 | 分類 | 理由 |
|--------|------|------|
| `status` | **純 ledger** | 唯讀 |
| `doctor` | **純 ledger** | 唯讀診斷 |
| `checkpoint` / `review` / `qa` | **純 ledger（evidence ingest）** | 外部已跑過驗證器；OMA 只 CAS 接受 evidence。**不應**在此 spawn agy。 |
| `cancel` | **純 ledger** | 標記 terminal；可選後續加 kill child，但不在 v1 process drive 必做 |
| `reset-breaker` | **純 ledger** | 解熔斷，不啟動程序 |
| `resume` | **今日純 ledger；應升級為 ledger + process drive** | 名稱與 help 暗示續跑對話；`resumeConversation` 已按 `--conversation` 設計 |
| `start` | **今日純 ledger；產品上應有 first-drive 決策** | 只建帳本無法進入 bound；首次 agy 需 launch 或明確第二步 |

### 2.3 兩套狀態機契約衝突（實作前必須對齊）

這是 process drive 最大 brownfield 風險。

| 步驟 | `AutopilotRuntime.resume`（現況） | `SessionLocator.prepareResume`（managed） |
|------|-----------------------------------|------------------------------------------|
| 前置 binding | 允許 conversation 原為 `null`；寫入 id | **要求** `binding.state === 'bound'` 且 conversationId 已匹配 |
| state 轉移 | → `resume_pending`（若非 bound） | `bound` → `resume_pending`，**generation++**，新 nonce |
| 是否 spawn | 否 | 由 `resumeConversation` spawn |
| revision | CLI `--expected-revision` CAS +1 | 同一 CAS 語意，但是 locator 路徑 |

**後果：** 若只是在 `services.autopilotCommand` 的 `resume` 後面「順便」呼叫 `resumeConversation`：

1. 使用者剛 `autopilot start`（state=`launch_pending`，conversation=`null`）→ 現有 `AutopilotRuntime.resume` 可寫 conversationId，但 **locator.prepareResume 會失敗**（非 bound）。  
2. 若先跑過 managed `ralph --` 並由 PreInvocation hook bound，則 locator resume 可行，但 AutopilotRuntime 的 CAS 與 locator 的 CAS 可能 **雙重 revision++** 或搶同一 aggregate。  
3. `AutopilotRuntime.start` 產生的 `launchNonceDigest` **從未**進入 `SessionLocator` 的 capability / plaintext nonce 流程 → 無法用同一 session 做 exact_env launch。

**決策邊界（必須 interview / 架構裁決其一）：**

| 方案 | 描述 | 優點 | 代價 |
|------|------|------|------|
| **B1 雙階段 resume** | CLI `resume`：若 unbound → 只綁 conversation 帳本；若 bound → `resumeConversation` spawn | 小改 | 首次仍無「從 start 開 agy」 |
| **B2 resume = 唯一 drive** | `resume` 一律走 locator.prepareResume；AutopilotRuntime.resume 刪或改為薄包裝 | 單一真相 | 需先有 bound session（通常來自 managed launch） |
| **B3 start 即 launch** | `autopilot start` 建 aggregate **並** `launchMode`/`prepareLaunch`+spawn（directive 含 goal） | 一條龍 | start 語意變重；與「先 ledger 再 drive」分離原則衝突 |
| **B4 新子命令 `drive`/`run`** | ledger 命令不變；`drive` 專職 spawn（resume 或 first launch） | 邊界最清 | CLI 面變大；help/文件要改 |

**分析建議（非裁決）：** 垂直切片優先 **B4 或 B2 的「已 bound 才能 process resume」**，避免把 gate ledger 與 process capability 混成隱式雙 CAS。`AutopilotRuntime.resume` 今日「未 bound 也可寫 conversationId」較像 **索引預綁**，與 locator 的 **capability resume** 應拆開命名（例如 `bind-conversation` vs `drive`）。

### 2.4 checkpoint / review / qa vs process drive

```
[外部 agent / CI / 人]
    │  產生 GateEvidenceV1 JSON 檔
    ▼
oma autopilot checkpoint|review|qa --evidence <file>
    │  GateValidator + ProgressOracle fingerprint
    ▼
SessionAggregate phase 推進（ledger only）
    │
    │  （可選）操作者看 status/doctor
    ▼
oma autopilot <drive/resume>  ──► ManagedInvocationService ──► agy
    │                                      exact_env + hooks
    ▼
PreInvocation bind / Stop oracle 繼續寫同一 aggregate
```

**Evidence flow 不應與 process drive 合併的原因：**

- Evidence 驗證的是**已發生**的工作（exitCode、artifact digest、獨立 review/qa validator id）。  
- Process drive 是**發起**工作。  
- 合併會讓「接受 gate」變成隱式再開一輪 agent，破壞 PRD「production 需獨立 causal-trace」分離。

### 2.5 `resumeConversation` 應如何接線

已實作契約（`managed-invocation.ts:115-134`）：

1. `preflight()`（plugin active）  
2. `transaction.prepareResume({ sessionId, conversationId, expectedRevision })`  
3. 斷言 `kind==='resume'`、conversation 精確匹配、`invocationGeneration >= 2`  
4. `runManaged(..., ['--conversation', conversationId])`  
5. 注入 `OMA_SESSION_ID` / `OMA_LAUNCH_NONCE` / `OMA_INVOCATION_GENERATION` + workspace/package/state  

**建議接線層：** `createDefaultServices` 的 `autopilotCommand` **不該**永遠只 `AutopilotRuntime.dispatch`。

推薦形狀：

```
autopilotCommand(argv):
  parsed = parseAutopilotCommand(argv)
  if parsed.kind in ledger-only:
    return AutopilotRuntime.execute → JSON
  if parsed.kind === 'drive' | 'resume'(process variant):
    // 1) 可選：runtime 側前置檢查（terminal? phase?）
    // 2) buildManagedService().resumeConversation(...)
    // 3) 回傳 process exit code（與 launchMode 一致），勿只印 ledger JSON
```

**Exit code 語意衝突：** 今日 autopilot 成功皆 `0` + JSON；managed launch 回傳 **child exit code**。Process drive 應採 child code，並在 stderr/stdout 是否夾帶 session view 上做明確選擇（建議：stderr 簡短 session 摘要或僅 process stdio inherit）。

### 2.6 Autopilot 垂直切片（建議）

| Slice | 內容 | 主要檔案 | 測試 |
|-------|------|----------|------|
| **A0** | 文件化 ledger vs drive 邊界；help 標註 resume 現況「ledger only」直到接線完成 | `application.ts` CLI_HELP、`DESIGN.md`、`README` | application help 斷言 |
| **A1** | 決策落地：新 `drive` **或** 升級 `resume`；凍結雙 CAS 規則 | commands + runtime 介面 | commands.spec |
| **A2** | services：process 子命令 → `ManagedInvocationService.resumeConversation` | `services.ts`；可能小改 `CliServices` | **新增** `tests/cli/autopilot-drive.spec.ts`（mock managed） |
| **A3** | 對齊 AutopilotRuntime 與 SessionLocator：禁止 silent 雙 revision；unbound 錯誤碼清楚 | `runtime.ts` / 或移除重疊 resume 寫入 | runtime.spec + session-locator.spec |
| **A4** | Happy path 整合：managed launch bind → autopilot drive/resume → 二次 gen spawn | 測試用 state fixture + mock agy | unit 整合；可選 e2e structured |
| **A5** | （可選）`start --drive` 或 first-launch：goal → prepareLaunch + directive | services + modes | managed-invocation + autopilot |
| **A6** | e2e：mock agy 下 structured autopilot drive | `e2e/` 新案 | 今日 e2e **幾乎不覆蓋** structured CLI |

**不在 A 切片：** 自動產 evidence、自動 phase 迴圈、team worker 內 drive。

**可測 acceptance（建議）：**

1. 未 bound session 呼叫 process resume/drive → 明確錯誤（非 hang、非假 JSON success）。  
2. bound session + 正確 expectedRevision → spawn `agy --conversation <id>`，env 含 gen≥2 與新 nonce；**禁止** `-c` 全局 resume（已有 unit 斷言）。  
3. terminal session → `E_TERMINAL_STATE`，不 spawn。  
4. preflight plugin inactive → 不 prepare、不 spawn（與 launchMode 一致）。  
5. checkpoint 後 phase 變化**不**自動 spawn。  
6. revision 衝突 → CAS 失敗，不留下半套 resume_pending + 子程序。

---

## 3. 實作順序：先 Madmax 再 Autopilot（建議）

| 順序 | 項 | 理由 |
|------|----|------|
| **1st** | **Madmax gate + parser silent-drop** | (1) 變更面小、安全/誠實性立即提升；(2) 與 Team/Autopilot 無狀態耦合；(3) process drive 上線後危險旗標更可能經 OMA 進入 agy，**先有 gate 再加 drive** 避免窗口期；(4) silent-drop 是獨立正確性 bug，任何 mode 擴充都會踩。 |
| **2nd** | **Autopilot process drive** | (1) 依賴 managed binding / locator 契約，需架構裁決（B1–B4）；(2) 變更 `services` 組裝與可能 CLI 語意；(3) 測資需 bound session 前置；(4) Team plan 已並行，避免三線搶 `services.ts` 時再疊危險 flag 行為未定。 |

**何時可反轉：** 若產品唯一 blocker 是「autopilot 不能開 agy」、且承諾 process drive **永不**轉發 madmax/yolo，可先做 A2 最小接線。仍建議 **至少先做 M1 silent-drop**（半小時級），再做 drive。

**與 Team orchestrator：** 保持分離 plan；共用點僅 `createDefaultServices` / help 文字 — 合併 PR 需注意衝突。

---

## 4. 檔案與測試對照表（總表）

### 4.1 Madmax

| 動作 | Path |
|------|------|
| 新增 | `src/cli/dangerous-launch.ts` |
| 修改 | `src/cli/parser.ts` |
| 修改 | `src/cli/application.ts`（和/或 services） |
| 修改 | `bin/oma.ts` |
| 修改 | `DESIGN.md`（藍圖 → 已實作；去掉「必須」幻覺） |
| 可選 | `README.md` |
| 新增測試 | `tests/cli/dangerous-launch.spec.ts` |
| 擴充測試 | `tests/cli/parser.spec.ts` |
| 擴充測試 | `tests/cli/application.spec.ts` |
| 可選 e2e | `e2e/tier*.spec.ts` 或 structured e2e 新檔 |

### 4.2 Autopilot process drive

| 動作 | Path |
|------|------|
| 可能修改 | `src/autopilot/commands.ts`（新 kind 或 resume 語意） |
| 可能修改 | `src/autopilot/runtime.ts`（拆 ledger bind vs 不雙 CAS） |
| 修改 | `src/cli/services.ts`（**主接線點**） |
| 可能修改 | `src/cli/application.ts`（help） |
| 複用勿重寫 | `src/cli/managed-invocation.ts`、`runtime-adapter.ts`、`continuation/state.ts` |
| 擴充測試 | `tests/autopilot/commands.spec.ts`、`runtime.spec.ts` |
| 新增測試 | `tests/cli/autopilot-drive.spec.ts`（建議） |
| 既有回歸 | `tests/cli/managed-invocation.spec.ts`、`tests/runtime/session-locator.spec.ts` |
| 可選 e2e | structured autopilot + mock agy |

### 4.3 明確不改（本兩主題）

- `src/team/**`（除 services 衝突協調外）  
- GateValidator / evidence schema（drive 不改 gate 規則）  
- enforcer 熔斷破壞性政策  
- `AGENTS.md`（專案禁止亂改）

---

## 5. 開放問題（Open questions）

### Madmax

1. **Flag 清單是否只限 `--madmax`/`--yolo`？** 是否跟 agy 上游同步擴充？  
2. **TTY 確認字串契約：** 僅 `yes` 還是 `y`/`Y`？逾時是否視為拒絕？  
3. **non-TTY 覆寫機制：** 要不要 `OMA_CONFIRM_DANGEROUS=1` / `--i-confirm-dangerous-launch`？預設 fail-closed 是否接受破壞現有腳本？  
4. **`oma ralph -- --madmax foo`：** task 內字面 flag 是否要警告？（建議否）  
5. **確認 UI：** stdin 行讀取 vs 未來 TUI；OMA 現無 readline 抽象。  
6. **DESIGN.md:102 在實作前是否先改成「藍圖」語氣？** 文件誠實性可獨立於 runtime。

### Autopilot process drive

7. **`resume` 升級 vs 新 `drive` 子命令？**（§2.3 B1–B4）  
8. **`start` 是否應 spawn？** 還是 start 只建 ledger、首次必須 managed `ralph`/`ultrawork` 再 autopilot drive？  
9. **AutopilotRuntime.resume 與 SessionLocator.prepareResume 誰是 binding CAS 的唯一 writer？**  
10. **Process drive 的 stdout 契約：** 維持 JSON view、改 child inherit、或兩者混合？  
11. **expectedRevision：** 呼叫 `resumeConversation` 前是否先跑 AutopilotRuntime 一步 CAS？（雙 CAS 風險）  
12. **idle / 過期 launch nonce / TTL：** drive 時如何對使用者呈現 `E_PENDING_LAUNCH_EXISTS` 等既有錯誤？  
13. **取消時是否 lifecycle-kill 子程序？** v1 是否只做 ledger cancel？  
14. **與 hooks ProgressOracle：** drive 結束後是否要求立即 `status` 顯示 streak，還是完全依賴 Stop hook？

### 跨主題

15. **實作順序是否同意「Madmax → Autopilot」？**  
16. **是否需要 e2e 覆蓋 structured CLI** 作為兩主題的共同 Definition of Done？

---

## 6. 最弱環節（requirements 壓力測試）

| 維度 | 強度 | 說明 |
|------|------|------|
| Intent | 中 | 文件想要 gate + 可續跑；產品是否「必須擋 madmax」或「僅文件誠實」未閉環 |
| Outcome | 弱→中 | Madmax 成功標準清楚（確認後才 spawn）；Autopilot「怎樣算 drive 完成」依賴 child exit vs ledger |
| Scope | 中 | Team plan 已排除；但 start-spawn 與 resume 語意仍可膨脹 |
| Constraints | 強（技術） | exact_env、no `exec`、CAS、plugin preflight 已有 |
| Success / acceptance | 弱 | 缺正式 acceptance checklist（本檔 §1.8 / §2.6 為建議稿） |
| Brownfield | **最弱（Autopilot）** | 雙套 resume 契約 + start 無 capability + services 只接 ledger |

**單一後續問題（給 parent / interview，不批次）：**

> Autopilot process drive 要以 **`resume` 升級為唯一 spawn 入口**，還是 **新增 `drive`/`run` 並把現有 `resume` 凍結為 ledger bind**？

（此題鎖 B2 vs B4，直接決定 A1 介面與是否觸碰 runtime.resume CAS。）

---

## 7. 實作 handoff 拒絕條件

在下列完成前，**不應**把本主題當「可交 executor 直接開工的完整需求」：

| Gate | Madmax | Autopilot drive |
|------|--------|-----------------|
| 非目標寫死 | 要/不要 env 覆寫 | 不做自動 evidence、不做全自動迴圈 |
| 決策邊界 | flag 清單 + TTY/non-TTY | B1–B4 擇一；CAS 單一 writer |
| Acceptance 可測 | §1.8 | §2.6 |
| CLI interview | 建議跑 `omg interview` 鎖定上列 open Q | 同上 |
| 與 Team plan 衝突協調 | 低 | 中（services.ts） |

**現狀：** 技術事實已足夠寫 **spike / 小切片 plan**；Autopilot **不可**在未選 B 方案時整包開工。

---

## 8. 證據索引（快速跳轉）

| 主題 | 位置 |
|------|------|
| structured 路由 | `bin/oma.ts:62-74`, `127-131` |
| legacy magic / pass-through spawn | `bin/oma.ts:169-271` |
| parser silent-drop | `src/cli/parser.ts:22-33` |
| CLI 無 dangerous 處理 | `src/cli/application.ts`, `services.ts` |
| resumeConversation 實作 | `src/cli/managed-invocation.ts:115-134` |
| prepareResume adapter | `src/cli/runtime-adapter.ts:95-106` |
| locator 需 bound | `src/continuation/state.ts:324-369` |
| Autopilot ledger resume | `src/autopilot/runtime.ts:240-267` |
| Autopilot start 不 spawn | `src/autopilot/runtime.ts:118-137` |
| services 只 dispatch runtime | `src/cli/services.ts:66-81` |
| DESIGN 藍圖 | `DESIGN.md:27`, `:102` |
| OMX 來源描述 | `research_report.md:293` |
| Fable 盤點 | `.omc/research/fable-review/fable5-full-review.md` §3, §4#6/#14, §6 |
| Team plan 排除 | `docs/superpowers/plans/2026-07-20-team-orchestrator-v1.md:11` |

---

## 9. Executive summary（≤30 行）

1. **Madmax/yolo/confirmDangerousLaunch = DESIGN_ONLY**：程式零實作。  
2. 危險旗標經 legacy pass-through / magic **原樣進 agy**，無二次確認。  
3. `oma ralph --madmax -- task` 的 `--madmax` 被 parser **靜默丟棄**（正確性 bug + gate 繞過面）。  
4. 建議 flag 初版僅 `--madmax`、`--yolo`；只比 argv token。  
5. 建議 gate：**TTY 確認 / non-TTY fail-closed**；確認後**放行原旗標**（不靜默剝除）。  
6. 掛載必須覆蓋 structured **與** `bin/oma.ts` legacy，共用同一模組。  
7. Madmax 切片：detect → parser 拒絕多餘 token → confirm → 雙路徑掛載 → 文件。  
8. **Autopilot FSM = 完整 ledger**；9 子命令皆不 spawn agy。  
9. `resumeConversation` **已實作且有 unit test**，但 **無 CLI production caller**。  
10. checkpoint/review/qa 應維持 **evidence ingest only**。  
11. `AutopilotRuntime.resume` 與 `SessionLocator.prepareResume` **契約衝突**（unbound 可寫 id vs 必須已 bound）。  
12. `start` 建立的 session **沒有** managed launch capability。  
13. Process drive 主接線點：`src/cli/services.ts` 的 `autopilotCommand`。  
14. 建議順序：**先 Madmax（+silent-drop）→ 再 Autopilot drive**。  
15. 最大 open Q：`resume` 升級 vs 新 `drive` 子命令（鎖定 CAS 單一 writer）。  
16. 在 B 方案與 acceptance 未鎖前，拒絕整包 implementation handoff。  
17. Team orchestrator plan 已排除本兩主題；實作時注意 `services.ts` 合併衝突。  
18. 本檔路徑：`.omc/research/council/madmax-autopilot-research.md`。
