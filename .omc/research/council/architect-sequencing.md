# Architect Sequencing — oh-my-agy 剩餘面完整出貨路線圖

- **角色**：Architect（READ-ONLY）
- **日期**：2026-07-20
- **Repo**：`/Users/iml1s/Documents/mine/oh-my-agy`
- **依據**：Fable 5 full review（`.omc/research/fable-review/fable5-full-review.md`）+ 本機現況碼（含已落地之 Team Orchestrator v1）
- **用戶指令**：NOTHING is out-of-scope；所有 incomplete surface 最終都必須 ship；本文件只定 **排序架構**，讓多份 plan 可平行撰寫且不互相踩約

---

## 0. 現況基線（審查後已變動）

Fable 審查時 Team 仍是「零件庫 + CLI stub」。**之後已落地垂直切片 v1**（見 `docs/superpowers/plans/2026-07-20-team-orchestrator-v1.md` 與實作）：

| 面 | 現況（2026-07-20 碼） | 證據 |
|----|----------------------|------|
| `oma team start/status/stop` | **已接線**（非 stub） | `src/team/commands.ts:148-199` → `TeamOrchestrator` |
| first ready task | worktree + claim + tmux + **worker-hold** | `src/team/orchestrator.ts:156-258`、`worker-hold.ts` |
| multi-task DAG | **未做**（只 `pickFirstReadyTask`） | `orchestrator.ts:156-160`、`:314-316` |
| real agy worker | **未做**（hold 只寫 marker + setInterval） | `worker-hold.ts:17-27` |
| supervisor poll/reclaim | **LIBRARY_ONLY** 純函式 | `supervisor.ts:11-27`、`reclaim.ts` |
| delivery→integration→FF publish | **LIBRARY_ONLY** 有真 git 單測 | `delivery.ts` / `integration.ts` / `publisher.ts` |
| `--madmax` / `--yolo` gate | **DESIGN_ONLY**（零 src 命中） | Fable §3；`DESIGN.md:27,102` |
| Autopilot process drive | FSM 完整；`resumeConversation` **無 CLI 呼叫者** | `managed-invocation.ts:115`；`autopilot/runtime.ts:240-267` 只改 binding |
| Docs honesty (team v1) | **已部分修正** | `README.md:145-149`、`skills/oma-runtime/SKILL.md:6` |
| Structured CLI e2e | **缺**（e2e 仍偏 legacy magic） | Fable §2.4 / §6 P1-5 |
| `maxOutputBytes` | Headless **截斷 buffer**，未超限 kill | `process.ts:115-128` |
| `maxProcessCount` / planning sandbox / AuthorityLease | **DESIGN_ONLY** | `DESIGN.md:30-34` |

**硬性約束（全 plan 共用，不可破）：**

1. Team 現有 library **WIRE 不 REWRITE**（`tmux` / `worktree` / `state` / `delivery` / `integration` / `publisher` / `reclaim` / `supervisor` assess）。
2. Circuit breaker **永不** `git reset --hard` / `git clean -fd`。
3. 外部命令只用 `spawn` / `spawnSync` + argv 陣列。
4. TDD + 頻繁 commit；**每個 plan 結束時 `main` 必須綠**（unit + 既有 e2e）。
5. Prefer **垂直切片**（end-to-end 一小條可用路徑），避免水平「先重寫一半零件」。

---

## 1. 剩餘工作項依賴圖

### 1.1 工作項編號（與 Fable incomplete surfaces 對齊）

| ID | Surface | 類型 |
|----|---------|------|
| **B0** | Team Orchestrator v1（first worker + hold + status/stop） | **DONE**（基線） |
| **S1** | `--madmax` / `--yolo` + `confirmDangerousLaunch` + parser 未知旗標 | Safety / CLI |
| **A1** | Autopilot process drive（`resumeConversation` 接 CLI） | Autopilot |
| **Q1** | Structured CLI e2e baseline（setup/doctor/autopilot ledger/team v1） | Quality |
| **T2** | Real agy worker in tmux（取代/擴充 worker-hold） | Team core |
| **T3** | Supervisor poll + reclaim loop | Team ops |
| **T4** | Delivery → temporary integration → FF publisher E2E | Team complete |
| **T5** | Multi-task DAG scheduling（ready queue / fan-out） | Team scale |
| **D1** | Docs honesty 持續對齊（每 plan 附帶，非獨立 mega-doc 任務） | Docs |
| **R2** | Process defense：`maxOutputBytes` kill-on-exceed + `maxProcessCount` | Runtime defense（wave 2） |
| **R3a** | Planning write-block sandbox（bwrap / sandbox-exec + hook 決策） | Runtime defense（wave 2→3） |
| **R3b** | AuthorityLease + Conflict Resolution Saga | Concurrency（wave 3） |

### 1.2 依賴關係（箭頭 = must precede）

```
                    ┌─────────────┐
                    │  B0 DONE    │
                    │ team v1     │
                    └──────┬──────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          v                v                v
     ┌────────┐      ┌──────────┐     ┌──────────┐
     │   T2   │      │    Q1    │     │ S1 / A1  │  ← 與 Team 核心弱耦合，可平行
     │ agy    │      │ e2e base │     │ 獨立軌道 │
     │ worker │      └────┬─────┘     └──────────┘
     └───┬────┘           │
         │                │  每完成一個 T* 就擴 e2e 切片
         │                v
         │           ┌──────────┐
         │           │ Q1+ / Qn │  持續擴張（非 blocker）
         │           └──────────┘
         │
    ┌────┴─────┐
    │          │
    v          v
┌───────┐  ┌───────┐
│  T3   │  │  T4   │   T3 與 T4 可平行（共享 heartbeat/claim 契約，不改 schema）
│sup+rec│  │deliver│
└───┬───┘  └───┬───┘
    │          │
    └────┬─────┘
         v
    ┌───────┐
    │  T5   │  需要「任務可 completed」→ 依賴 T4（write task）
    │  DAG  │  或至少 T2+read_only complete；正式 DAG 以 T4 為 entry
    └───────┘

Runtime 防禦（較晚、不阻塞 Team 主幹）：
  R2  ──可與 T2 後平行（headless worker 受益）
  R3a ──需先決策 hook 面（package 目前僅 PreInvocation+Stop）
  R3b ──需 T5 多 worker 並行寫入才有產品意義
```

### 1.3 關鍵依賴理由（碼證據）

| 依賴 | 為什麼 |
|------|--------|
| **T2 → T3** | 現況 heartbeat 的 `process.pid` 是 **orchestrator PID**（`orchestrator.ts:234`），reclaim fence 需要 **worker 真實 process marker**；agy worker 必須自己寫 heartbeat / `ProcessMarkerV1`。 |
| **T2 → T4** | Delivery 要 `claimToken` + worktree commits + command evidence；hold 程序不會產生任何 git 交付物。 |
| **T4 → T5（正式）** | `claimTask` 要求 deps `status === 'completed'`（`state.ts:71-74`）；write task 的 completed 來自 `acceptDelivery` → `markIntegrated`（`state.ts:184-218`）。 |
| **T2 ∥ T5（弱）** | 僅「多個 **無依賴** task 同時 launch」理論上可在無 completed 下做，但會卡在無法釋放後續 dep、也無法 deliver；**不建議**在 T4 前當正式 DAG plan。 |
| **S1 / A1 獨立** | 不碰 Team aggregate；只動 `bin/oma.ts` / `parser` / `managed-invocation` / `autopilot` / `services`。 |
| **Q1 輕依賴 B0** | team v1 JSON kinds 已穩定（`team-started` / `team-status` / `team-stopped`），可先鎖 e2e。 |
| **R3a 延後** | DESIGN 要 PreToolUse + bwrap；package surface 明示只有 PreInvocation+Stop（`README.md:175`）。需先做 **hook surface 決策** 再寫 plan，否則會與現有 plugin 契約衝突。 |
| **R3b 延後** | Looks vs Works lease 需要多 worker 同時改同一 write_scope；沒有 T5 就沒有真實衝突面。 |

### 1.4 建議執行軌道（最大化平行、最小衝突）

| 軌道 | 順序 | 可與誰平行 |
|------|------|------------|
| **Track Team** | B0 → **T2** → (T3 ∥ T4) → **T5** | S1, A1, Q1 |
| **Track Safety-CLI** | **S1** | 幾乎全部 |
| **Track Autopilot** | **A1** | 幾乎全部；A1 後擴 Q1 |
| **Track Quality** | **Q1** → 每完成 T2/T3/T4/T5/S1/A1 追加 e2e 案 | 全程 |
| **Track Runtime-W2** | **R2**（建議 T2 後） | T3/T4/T5 |
| **Track Runtime-W3** | **R3a** 決策 → 實作；**R3b** 在 T5 後 | 最後 |

---

## 2. 建議 Plan 文件清單（每份可單獨 ship）

路徑慣例（與現有 plan 一致）：`docs/superpowers/plans/`

| # | 檔名 | Wave | 單獨可 ship 的使用者可見結果 |
|---|------|------|------------------------------|
| 0 | `2026-07-20-team-orchestrator-v1.md` | 0 / DONE | first worker hold + status/stop |
| 1 | `2026-07-20-dangerous-launch-gate.md` | 1 | `--madmax`/`--yolo` 有 gate；未知 managed 旗標 fail-closed |
| 2 | `2026-07-20-autopilot-process-drive.md` | 1 | `oma autopilot resume|drive` 真的 spawn agy |
| 3 | `2026-07-20-structured-cli-e2e-baseline.md` | 1 | setup/doctor/autopilot/team v1 有 e2e |
| 4 | `2026-07-21-team-agy-worker.md` | 1 | tmux pane 內跑真 agy（mock 可測） |
| 5 | `2026-07-21-team-supervisor-reclaim.md` | 1 | `oma team supervise`/`reclaim` 輪詢 + 死證回收 |
| 6 | `2026-07-22-team-delivery-publish.md` | 1 | 單 task 交付→暫存整合→FF publish→completed |
| 7 | `2026-07-22-team-dag-scheduler.md` | 1 | multi-task ready queue / 依賴推進 |
| 8 | `2026-07-23-runtime-process-defense.md` | **2** | 輸出超限 kill + 程序數上限 |
| 9 | `2026-07-24-planning-write-block-sandbox.md` | **2→3** | 規劃期寫入封鎖（先決策 hook 面） |
| 10 | `2026-07-25-authority-lease-saga.md` | **3** | Looks/Works 租約 + 衝突 Saga |

> **Docs honesty（D1）不單獨立 plan**：每個 plan 的 exit criteria 必須包含 README / SKILL / DESIGN / AGENTS 數字與「已實作 vs 藍圖」同步。避免再出現 Fable 指出的幻覺子命令。

---

## 3. 各 Plan 規格（goal / non-goals / entry / exit）

> 規則：**單一 plan 的 non-goals 必須嚴格**；**全部 plan 的聯集覆蓋 Fable 全部 incomplete + 藍圖項**。

---

### Plan 1 — `2026-07-20-dangerous-launch-gate.md`（S1）

**Goal**  
在 CLI 進入點偵測高風險旗標（至少 `--madmax`、`--yolo`），於 spawn agy **之前** 執行 `confirmDangerousLaunch`（TTY 二次確認；非 TTY 預設拒絕或需 `--i-understand-dangerous-launch` 顯式覆寫）。同步修正 managed mode 下 `--` 前未知 token **靜默丟棄** 問題（改 `E_DIRECTIVE_INVALID`）。

**Non-goals（本 plan only）**  
Team、Autopilot FSM、process tree 防禦、sandbox、任何 git 操作。

**Entry criteria**  
- `main` 綠；不依賴 Team T2+。  
- 現況：pass-through 原樣轉發危險旗標（Fable §3.2）。

**Exit criteria**  
- Unit：危險旗標在 pass-through / legacy magic / managed 三路徑皆有測試。  
- 非 TTY：無確認時 exit ≠ 0，且 **不** spawn agy。  
- Managed：`oma ralph --madmax -- task` → 明確錯誤，不再靜默丟棄。  
- Docs：`DESIGN.md` 模組段「必須」語氣與實作一致；不再給虛假安全感。  
- `npm run build && npm run test:unit` 綠。

**觸及檔案（預期）**  
`bin/oma.ts`、`src/cli/parser.ts`、`src/cli/application.ts` 或新 `src/cli/dangerous-launch.ts`、tests。

---

### Plan 2 — `2026-07-20-autopilot-process-drive.md`（A1）

**Goal**  
把 `ManagedInvocationService.resumeConversation`（`managed-invocation.ts:115-134`）接到 Autopilot CLI：至少  
- `oma autopilot resume …` 在更新 binding 後 **spawn** managed agy；或  
- 新增 `oma autopilot drive --session …` 明確「狀態機 + 程序」。  
`start` 可選擇性在 requirements 相位準備 launch（但 **不得** 破壞現有「start 只建 ledger」的既有測試語意——若保留，用新 subcommand `drive` 較安全）。

**Non-goals**  
Team、gate evidence 自動產生、完整 multi-phase 無人值守迴圈、madmax。

**Entry criteria**  
- Autopilot FSM 與 unit tests 綠。  
- `resumeConversation` 已實作且有 managed-invocation unit test。

**Exit criteria**  
- CLI 路徑呼叫 `resumeConversation`（`rg resumeConversation` 在 production 有呼叫者）。  
- Unit：mock ProcessRunner 驗證 argv 含 `--conversation`、exact_env 注入。  
- 既有 autopilot status/checkpoint/cancel 行為不變。  
- Docs：明言 autopilot 不再只是「純記帳」。  
- build + unit 綠。

**觸及檔案（預期）**  
`src/cli/services.ts`、`src/autopilot/runtime.ts` 或 `commands.ts`、`tests/autopilot/*`、`tests/cli/*`。

---

### Plan 3 — `2026-07-20-structured-cli-e2e-baseline.md`（Q1）

**Goal**  
新增 e2e（mock agy）覆蓋結構化 CLI：  
`oma setup`、`oma doctor`、`oma autopilot start→status→…`、`oma team start/status/stop`（v1 hold；tmux 不可用時 skip 與 unit 一致）。

**Non-goals**  
實作新產品功能；不測真 delivery/DAG；不取代 unit 真 git/tmux 測試。

**Entry criteria**  
- B0 已合入；CLI JSON kinds 穩定（見 §4）。  
- 可與 Plan 1/2 平行；若平行，e2e 先鎖 **當下** kinds，後續 plan 各自加 case。

**Exit criteria**  
- 至少 N 個 `TC-T*-*` 風格案：setup 冪等、doctor exitCode、autopilot JSON shape、team-started/status/stopped。  
- `npm run test:e2e` 綠（無 tmux 環境 skip 規則文件化）。  
- 禁止 mock 劇場：不得 assert `MOCK_AGY_STDOUT` 回顯字串當功能證明（可保留 legacy 案但標 `legacy-mock-theatre`）。

---

### Plan 4 — `2026-07-21-team-agy-worker.md`（T2）— **Team 主幹關鍵路徑**

**Goal**  
tmux worker 內啟動 **真 agy**（測試用 `e2e/mocks/agy` 或 `PATH` 注入），取代「永遠 hold」的預設行為：  
- 讀 descriptor（現有 `.oma-worker-descriptor.json` 契約擴充，**向後相容** hold）。  
- 依 `workerMode`：`headless` → bounded spawn；`interactive` → 可 attach 的 long-lived agy。  
- Worker 寫入 **真實** `SupervisorHeartbeatV1.process`（pid + startMarker），並週期 `recordHeartbeat` / progress（claimToken 由 start JSON 單次交付後，worker 僅持有記憶體或安全 side-channel——**禁止**把明文 token 寫進 durable descriptor；現況已用 digest，`orchestrator.ts:196-207`）。

**Non-goals**  
Multi-task DAG、delivery/publish、supervisor 常駐 poll loop（可提供 heartbeat 寫入，但不實作 leader 輪詢）、AuthorityLease。

**Entry criteria**  
- B0 綠；`TmuxController.startWorker` / `TeamStateStore.claimTask` 契約不變。  
- **Wire**：bootstrap 可注入 `workerBootstrapArgv`（已支援，`orchestrator.ts:39-45`）。

**Exit criteria**  
- 預設 bootstrap = agy-worker entry（hold 保留為 test fixture 或 `--bootstrap hold` 逃逸閥）。  
- Unit：真 tmux + mock agy 可證明 pane 內 process 非 hold-only。  
- Heartbeat `process.pid` ≠ orchestrator pid（修 `orchestrator.ts:234` 的暫時值）。  
- `team status` 可反映 worker 存活。  
- CLI JSON `kind: 'team-started'` 欄位 **不 breaking**（可加欄，不刪欄）。  
- Docs：README 改為「v1.1 real agy worker；仍非 full DAG/delivery」。  
- build + unit 綠；Q1 e2e 擴一案。

**設計要點**  
- 不要重寫 `TmuxController`；只換 bootstrap 程式。  
- claimToken 傳輸：start stdout 一次 + 可選 worker 端由 leader 寫入僅 worker worktree、mode 0700 的 capability 檔（gitignore / worktree 內 `.oma/`），exit 時 unlink——plan 撰寫時二選一並寫進 shared contract。

---

### Plan 5 — `2026-07-21-team-supervisor-reclaim.md`（T3）

**Goal**  
把 `assessWorker` + `inspectReclaimFence` / `requireDeadProof` **組成可執行迴圈**：  
- CLI：`oma team supervise --team <id> [--once|--interval-ms N]` 與/或 `oma team reclaim --team … --task …`。  
- DeadProof → 允許重新 claim / 標記 `orphan_identity_unproven` / 清 pane（**owner nonce 殺 session**，沿用 `killOwnedSession`）。  
- 活著但 lease 過期 → `awaiting_interaction` + `attachCommand`。

**Non-goals**  
Delivery、DAG fan-out、自動 merge、git reset。

**Entry criteria**  
- **T2 完成**（真實 process marker）。  
- Library `supervisor.ts` / `reclaim.ts` 不改語意或僅加薄 wrapper。

**Exit criteria**  
- Unit：假 liveness 矩陣覆蓋 healthy / reclaimable / orphan / awaiting_interaction。  
- 真 tmux：殺 worker process 後 `--once` 回 `reclaimable`，reclaim 後 generation+1 可重開（重開可呼叫既有 start 路徑的 extract function）。  
- 無 DeadProof **禁止** 搶 claim（保持 `E_RECLAIM_IDENTITY_UNPROVEN`）。  
- JSON kinds 新增如 `team-supervise-report` / `team-reclaimed`（見 §4）。  
- build + unit 綠。

---

### Plan 6 — `2026-07-22-team-delivery-publish.md`（T4）

**Goal**  
單 task 完整後段：worker（或 leader 代操作）提交 → `createDeliveryEvidence` + `DeliveryValidator` → `TeamStateStore.acceptDelivery` → `IntegrationManager.prepare/apply` → `FastForwardPublisherV1.publishCheckedOutRef` → `markIntegrated` → status `completed`。  
CLI 可為：  
- `oma team deliver --team … --task …`（leader 側驗證並整合），或  
- orchestrator 在 supervise 迴圈偵測到交付訊號後自動跑（**建議先顯式 CLI，再自動化**——較易 TDD、較安全）。

**Non-goals**  
Multi-task 排程、AuthorityLease、非 FF 合併策略、destructive git 還原。

**Entry criteria**  
- T2 完成（有真實 worktree 變更來源）。  
- Delivery/Integration/Publisher **library tests 已綠**——本 plan 只接線 + CLI + 少量整合測。

**Exit criteria**  
- 一條 unit/integration：真 git fixture 從 `delivered_unintegrated` → `completed`，leader ref 為 FF-only。  
- non-FF / dirty leader → 拒絕且 ref 不被污染（沿用既有 publisher 測試不回歸）。  
- `claimTask` 對 dependent task 在 dep completed 後變可 claim（為 T5 鋪路）。  
- dirty worktree cleanup 仍走 `E_DELIVERY_UNINTEGRATED` blocker（`worktree.ts`）。  
- Docs：team 能力表更新；仍可註明「單 task 整合，非 full DAG」。  
- build + unit 綠。

---

### Plan 7 — `2026-07-22-team-dag-scheduler.md`（T5）

**Goal**  
`TeamOrchestrator` 從 `pickFirstReadyTask` 升級為 **ready-queue 排程器**：  
- 所有 `dependencies` 皆 `completed` 且 status claimable 的 tasks 可被 claim+spawn。  
- 支援並行上限（`maxParallelWorkers`，預設 1 或 2，避免本機 tmux 爆炸）。  
- `start` 可啟動多 worker；`supervise` 在 task completed 後 **自動推進** 下一 ready set（若 T3 已合入則掛在 supervise；否則 `oma team tick`）。

**Non-goals**  
動態改 manifest、跨 repo、Looks/Works lease、自動 resolve-fork 策略 AI。

**Entry criteria**  
- **T4 完成**（write task 可 completed）。  
- T2 完成；T3 強烈建議完成（否則 tick 需手動）。

**Exit criteria**  
- Manifest 兩 task：`A` deps=[]、`B` deps=[A]：A 完成前 B 不可 claim；A 整合後 B 可被排程。  
- 兩獨立 task 在 maxParallel≥2 時可同時 in_progress。  
- 迴歸：單 task manifest 行為與 B0/T2 相容。  
- JSON `team-started.workers[]` 可 0..N；status 顯示全 tasks。  
- Docs：移除「only first ready task」限制說明。  
- build + unit + 擴 e2e 綠。

---

### Plan 8 — `2026-07-23-runtime-process-defense.md`（R2，**Wave 2**）

**Goal**  
1. `maxOutputBytes`：超過時 **終止子程序**（現況只截斷 buffer，`process.ts:125-128`），並在 outcome 標示 overflow。  
2. `maxProcessCount`：Linux 下週期計算 descendants，超限 SIGTERM/SIGKILL process group（沿用既有 detached PGID 模式）。  
3. 將政策接到 managed headless / team headless worker。

**Non-goals**  
Planning sandbox、AuthorityLease、TTY interactive 的 stdout 限制（可記錄為 follow-up）。

**Entry criteria**  
- T2 建議已合入（有 headless worker 受益方）；可與 T3/T4 平行。  
- 不破壞 interactive `stdio: 'inherit'` 路徑 unless 明確 opt-in。

**Exit criteria**  
- Unit：mock 大量 stdout → child 被殺、error code 穩定。  
- Linux-only 案：fork bomb fixture 被擋（或 skip on darwin 並文件化）。  
- 永不 `git reset`。  
- DESIGN 藍圖項勾選為「已實作（headless）」。

**Wave 判定**：**Wave 2**（安全強化，不阻塞 Team 主幹產品宣稱，但應在「production-grade worker」前完成）。

---

### Plan 9 — `2026-07-24-planning-write-block-sandbox.md`（R3a，**Wave 2 決策 / Wave 3 實作**）

**Goal**  
規劃期禁止任意寫入：  
- **決策里程碑（Wave 2 開頭 gate）**：是否擴充 package hooks 至 PreToolUse，或僅用 outer wrapper sandbox（bwrap/sandbox-exec）而不進 agy hook。  
- 實作選中的路徑：Fail-Closed；僅允許 `.agy/plans/`（或專案約定目錄）。

**Non-goals**  
AuthorityLease、Team DAG、完整 Research 唯讀白名單的最終形態（可同 plan 做最小 subset 若決策允許）。

**Entry criteria**  
- 書面 ADR：hook surface 變更 vs wrapper-only。  
- 若選 PreToolUse：需同步改 `plugin.json` / `hooks.json` / README「Only PreInvocation and Stop」契約——**這是 breaking product surface**。

**Exit criteria**  
- 選定路徑有 unit + 至少一則 e2e/沙盒探測。  
- 沙盒載入失敗 → 不降級執行。  
- Docs 與 package surface 一致。

**Wave 判定**：**決策 Wave 2，完整實作 Wave 3**（因可能打破現行 hook 契約，風險高於 Team 主幹）。

---

### Plan 10 — `2026-07-25-authority-lease-saga.md`（R3b，**Wave 3**）

**Goal**  
多 worker 對重疊 write_scope 的 `AuthorityLease`（acquire/renew/release）+ 衝突時 Conflict Resolution Saga（暫停、分支隔離、接既有 `resolve-fork` 證據流）。

**Non-goals**  
重寫 delivery/publisher；取代 TeamStateStore CAS；任何 hard reset。

**Entry criteria**  
- **T5 完成**（真並行 worker）。  
- write_scope 驗證已存在於 manifest（`manifest.ts`）。  
- recovery-fork 路徑 COMPLETE（已有）。

**Exit criteria**  
- 兩 worker 競爭同檔：第二方阻塞或取得 queue，不 silent clobber。  
- Lease 心跳超時 → reclaim 相容 T3。  
- 衝突 → 可產出 recovery fork evidence 接 `team resolve-fork`。  
- 測試：真 git 並行 fixture（可序列化模擬 clock）。  
- DESIGN Looks/Works 段從藍圖移到「已實作（experimental）」並標限制。

**Wave 判定**：**Wave 3 only**。

---

## 4. 跨 Plan 必須穩定的 Shared Contracts

以下契約 **冻结或僅可 additive**。任一 plan 若需 breaking change，必須：(1) 升 schemaVersion；(2) 同 PR 修全部呼叫端；(3) 不得默默改 JSON kind 字串。

### 4.1 CLI JSON `kind` 字串

| kind | 生產者 | 穩定規則 |
|------|--------|----------|
| `team-started` | `commands.ts` start | 必含 `teamId`, `aggregateRevision`, `workers[]` |
| `team-status` | status | 必含 `tasks`, `heartbeats`, `tmux` |
| `team-stopped` | stop | 必含 `killedSessions` |
| resolve-fork 的 `Selected` / `Rejected` 等 | resolve-fork | `issuedClaimToken` **僅 Selected 一次**；durable 只存 digest |
| Autopilot session view 欄位 | `AutopilotRuntime.view` | `sessionId`, `revision`, `phase`, `conversationId`, … |
| **新增（建議預先保留名）** | | |
| `team-supervise-report` | T3 | additive |
| `team-reclaimed` | T3 | additive |
| `team-delivered` / `team-integrated` | T4 | additive |
| `team-tick` / `team-scheduled` | T5 | additive |
| `dangerous-launch-rejected` | S1 | additive |

### 4.2 Session / Pane markers

| 契約 | 規格 |
|------|------|
| tmux session name | `sanitizeSession`：`/^[A-Za-z0-9_.-]+$/`，max 80（`orchestrator.ts:318-321`） |
| `startMarker` | 建議正規化：`tmux:<sessionName>`（現況已用，`orchestrator.ts:234`） |
| owner options | `@oma_owner_nonce` session-level；`@oma_worker_nonce` pane-level（`tmux.ts:47-48`） |
| kill | 必須 `killOwnedSession(session, ownerNonce)`；禁止無主殺 |

### 4.3 Claim tokens & generations

| 契約 | 規格 |
|------|------|
| `ClaimLeaseV1` | `ownerId`, `token`, `generation`, `leasedUntilMs`（`types.ts:77-82`） |
| Plaintext token | **僅** start/reclaim Selected 的 stdout 單次；descriptor 只存 `claimTokenDigest`（sha256） |
| CAS | 所有 state mutation 走 `expectedRevision`；衝突 → `E_REVISION_CONFLICT` |
| Recovery | durable 只存 `freshClaimTokenDigest`；`issuedClaimToken` 單次 |

### 4.4 Managed binding env（Autopilot / managed modes）

| 變數 | 意義 |
|------|------|
| `OMA_SESSION_ID` | session binding |
| `OMA_LAUNCH_NONCE` | capability；log 只 fingerprint |
| `OMA_INVOCATION_GENERATION` | 單調遞增 |
| `OMA_STATE_ROOT` / `OMA_PACKAGE_ROOT` / `OMA_WORKSPACE_PATH` | hook/workspace 對齊 |
| ordinary pass-through | **必須** strip binding（`ordinaryEnvironment`） |

Team worker 是否注入同一套 OMA_*：T2 plan 必須明文決定。建議：  
- **worker headless agy** 使用 **獨立** `OMA_TEAM_ID` / `OMA_WORKER_NONCE` / `OMA_CLAIM_TOKEN`（記憶體或 0700 檔），**不要**複用 leader launch nonce，避免 capability 混淆。

### 4.5 Team descriptor / aggregate schema

| 契約 | 規格 |
|------|------|
| Manifest | `oma.team-manifest/v1`（`TEAM_MANIFEST_SCHEMA`） |
| `TeamAggregateV1.schemaVersion` | `1`；狀態機枚舉見 `TeamTaskStatus`（`types.ts:6-18`） |
| Worker descriptor on disk | 現況 ad-hoc JSON（`orchestrator.ts:197-207`）；T2 應升為 **versioned** `TeamWorkerDescriptorV1` 並寫進 `types.ts`，欄位 additive |
| Heartbeat | `SupervisorHeartbeatV1` schemaVersion 1 |
| Delivery evidence | `DeliveryEvidenceV1`；整合 journal phase 枚舉不可刪減 |

### 4.6 錯誤碼（跨 plan 勿覆寫語意）

保持既有：`E_RECLAIM_IDENTITY_UNPROVEN`、`E_TMUX_OWNER_MISMATCH`、`E_DELIVERY_UNINTEGRATED`、`E_DELIVERY_NONLINEAR`、`E_TARGET_REF_CHANGED`、`E_TASK_DEPENDENCY_BLOCKED`、`E_REVISION_CONFLICT`、`E_DIRECTIVE_INVALID`、`E_VALIDATOR_REJECTED`、`E_MANIFEST_INVALID` …

新增碼必須 `E_*` 前綴並在 errors 模組集中定義。

### 4.7 測試與安全不變量

- 任何 plan 的 breaker / cleanup **禁止** 引入 `git reset --hard` / `git clean -fd`（既有 `breaker-safety.spec.ts` 為回歸哨兵）。  
- 外部程序：`spawn`/`spawnSync` only。  
- Team library 公開 class/function 簽名：**prefer overload/adapter**，避免改 `DeliveryValidator.validate` 等核心簽名。

---

## 5. 若硬做「單一 mega-plan」的風險

| 風險 | 為何致命 |
|------|----------|
| **長期 main 不綠** | Team + Autopilot + Safety + Sandbox 交錯時，半成品 orchestrator 會弄壞既有 v1 status/stop 與 111+ unit tests。 |
| **契約漂移** | 同 PR 同時改 heartbeat 形狀、CLI kind、claim 傳遞、hook surface → 回滾成本指數上升。 |
| **錯誤歸因** | tmux flake vs git FF race vs mock agy vs CAS 衝突混在同一失敗，debug 無法切分。 |
| **重寫誘惑** | Mega-plan 壓力下容易「順便重寫」LIBRARY_ONLY 零件，違背 wire-don't-rewrite，引入回歸到已通過的真 git/tmux 測試。 |
| **安全回歸** | madmax gate 與 delivery publish 同批時，審查注意力分散，可能漏掉 non-TTY 默許危險旗標或 FF CAS。 |
| **假完成** | 容易留下 `worker-hold` 當預設、e2e mock 劇場、或 `resume` 只改 state 卻宣稱 process drive——Fable 已警告的 test theatre。 |
| **Hook 契約爆炸** | 若 mega-plan 順便加 PreToolUse，與現網 Antigravity plugin surface 不相容，setup/doctor 全線紅。 |
| **無法平行** | 多 agent / 多作者無法同時寫 plan 或實作；串列瓶頸拉長到「全有或全無」。 |
| **Wave 混淆** | AuthorityLease 等 Wave 3 與 first agy worker 綁在一起，會讓最小可用 Team 永遠到不了使用者手上。 |

**結論**：垂直切片 + 凍結 §4 契約 + 三軌道平行（Team / Safety+Autopilot / Quality）是唯一能「全部都要 ship」又「main 恆綠」的排序架構。

---

## 6. 建議的 Planner 開工順序（給人類 / planner agent）

**可立即平行起草（無互相 entry 阻塞）：**

1. Plan 1 S1 dangerous-launch-gate  
2. Plan 2 A1 autopilot-process-drive  
3. Plan 3 Q1 structured-cli-e2e-baseline  
4. Plan 4 T2 team-agy-worker（**Team 主幹優先實作**）

**T2 merge 後平行起草/實作：**

5. Plan 5 T3 supervisor-reclaim  
6. Plan 6 T4 delivery-publish  

**T4（+ 建議 T3）後：**

7. Plan 7 T5 dag-scheduler  

**Wave 2（不阻塞 Team 宣稱「單 worker 可交付」）：**

8. Plan 8 R2 process-defense  

**Wave 2 決策 → Wave 3 實作：**

9. Plan 9 R3a planning-write-block（先 ADR）  
10. Plan 10 R3b AuthorityLease/Saga（T5 後）

### 「產品完整度」里程碑（方便對外誠實）

| 里程碑 | 需完成 | 可誠實宣稱 |
|--------|--------|------------|
| M0 | B0 | first worker hold + status/stop |
| M1 | B0+T2 | tmux 內真 agy 單 task |
| M2 | M1+T4 | 單 task 可整合進 leader（FF） |
| M3 | M2+T3+T5 | multi-task Team 可用 |
| M4 | M3+S1+A1+Q1 | 安全 gate + autopilot 真驅動 + e2e 網 |
| M5 | M4+R2 | headless 程序防禦 |
| M6 | +R3a+R3b | 藍圖級並行租約與規劃沙盒 |

---

## 7. Architect 判定摘要

- **Team 缺的不是零件，是接線順序**：T2 → (T3∥T4) → T5。  
- **S1/A1/Q1 不應塞進 Team mega-plan**——它們是獨立軌道，應平行以縮短 wall-clock。  
- **R2 = Wave 2**；**R3a 先決策再做**；**R3b = Wave 3**。  
- **Shared contracts（§4）是多 plan 不衝突的唯一機制**；CLI kind / claim / heartbeat / OMA env / task status 枚舉列為 API。  
- **每個 plan 必須 shippable 且 main 綠**；Docs honesty 是 exit criteria 而非獨立願望。

---

## 8. References（碼證據）

| 位置 | 說明 |
|------|------|
| `src/team/orchestrator.ts:156-258` | v1 first ready + hold bootstrap |
| `src/team/orchestrator.ts:234` | heartbeat 暫用 orchestrator pid（T2 必修） |
| `src/team/orchestrator.ts:314-316` | `pickFirstReadyTask` only |
| `src/team/worker-hold.ts:17-27` | hold-only，無 agy |
| `src/team/commands.ts:148-199` | start/status/stop JSON kinds |
| `src/team/state.ts:58-85` | claim + dep completed 門檻 |
| `src/team/state.ts:184-218` | acceptDelivery / markIntegrated |
| `src/team/supervisor.ts:11-27` | assess 純函式，無 poll |
| `src/team/reclaim.ts:27-46` | DeadProof fence |
| `src/team/publisher.ts:25-66` | FF guarded update-ref |
| `src/cli/managed-invocation.ts:115-134` | resumeConversation 無 CLI 呼叫者 |
| `src/autopilot/runtime.ts:240-267` | resume 只改 binding |
| `src/runtime/process.ts:115-128` | maxOutputBytes 截斷未殺程 |
| `src/cli/parser.ts:22-33` | managed 未知旗標可靜默消失 |
| `DESIGN.md:25-34` | 藍圖項清單 |
| `.omc/research/fable-review/fable5-full-review.md` | 完整度矩陣與 P0/P1 建議 |
| `docs/superpowers/plans/2026-07-20-team-orchestrator-v1.md` | 已落地 v1 plan |

---

*本文件為 Architect sequencing deliverable；不實作程式碼。下一步：Planner 依 §6 平行產出各 `docs/superpowers/plans/*.md` 詳細 task checklist。*
