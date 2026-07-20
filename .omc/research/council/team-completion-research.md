# Team / tmux 產品完整度研究報告

**日期:** 2026-07-20  
**分支脈絡:** `feat/team-orchestrator-v1`（TeamOrchestrator v1 已合入工作樹）  
**範圍:** 唯讀盤點 — 不實作、不改 `.omg/state/`  
**對照:** Fable 5 全功能審查（`.omc/research/fable-review/fable5-full-review.md`）、`docs/superpowers/plans/2026-07-20-team-orchestrator-v1.md`、`src/team/*`、`tests/team/*`、`DESIGN.md` / `PROJECT.md` / `research_report.md`

---

## 0. 一句話結論

v1 已把 **「零件庫」通電成「可 start 第一個 ready task」的垂直切片**；Fable 5 所說的「零 production importer」對 start/status/stop **已過時**。  
但產品距離「OMC-style full Team」仍缺 **四條主幹**：真實 `agy` worker 啟動、多任務 DAG 排程、supervisor 輪詢/reclaim 閉環、delivery→integration→publish 接上 orchestrator endgame。  
其餘（manifest 驗證、worktree、tmux ownership、state CAS、delivery/publisher 庫、resolve-fork）多為 **LIBRARY_ONLY 或單點 COMPLETE**，可複用、不可對外宣稱端到端可用。

**粗估完整度（端到端產品）:** ~40%（零件庫 ~75–80%；編排閉環 ~25%）

---

## 1. 完整度矩陣（每個 Team 子系統）

圖例：

| 狀態 | 意義 |
|------|------|
| **COMPLETE** | 庫 + CLI/編排接線 + 測試可證明行為 |
| **WIRED_PARTIAL** | 有 production 呼叫者，但功能子集 / 假 worker / 缺閉環 |
| **LIBRARY_ONLY** | 有實作與單元測試，orchestrator/CLI **未**串上 |
| **STUB / MISSING** | 型別或註解存在，行為不存在或僅 hold |

| 子系統 | 主要檔案 | 存在？ | 接線？ | 缺什麼 | 測試 |
|--------|----------|--------|--------|--------|------|
| **Manifest 驗證（DAG/scope）** | `manifest.ts`, `types.ts` | ✅ | ✅（start 呼叫） | 無 runtime 再驗證 revision bump | `manifest.spec.ts` |
| **TeamStateStore（CAS）** | `state.ts` | ✅ | ⚠️ partial | claim/heartbeat 有；progress/command/delivery/mailbox/complete 無 orchestrator 呼叫者 | `state.spec.ts` |
| **Git worktree 隔離** | `worktree.ts` | ✅ | ✅（start） | stop 不清理 worktree；dirty/unintegrated 保全路徑未進編排 | `worktree.spec.ts` |
| **tmux ownership** | `tmux.ts` | ✅ | ✅（start/stop/status） | 無 pane capture/send-keys；無 `set-environment`；無 attach CLI | `tmux.spec.ts` |
| **TeamOrchestrator start** | `orchestrator.ts` | ✅ | ✅ | **只**第一個 empty-deps task；worker = hold | `orchestrator.spec.ts`（真 git+tmux，無 tmux 則 skip） |
| **CLI start/status/stop** | `commands.ts`, `cli/services.ts`, `cli/application.ts` | ✅ | ✅ | status 不跑 `assessWorker`；stop 不改 task status / 不清 worktree | `commands.spec.ts`（resolve-fork + 擴充） |
| **worker-hold** | `worker-hold.ts` | ✅ | ✅ | **不是** agy；只寫 marker + `setInterval` | orchestrator 內嵌 hold.js |
| **真實 agy worker 啟動** | — | ❌ | ❌ | 無 bootstrap、無 exact_env、無 task prompt、無 mode 映射 | 無 |
| **多任務 DAG 排程** | `pickFirstReadyTask` only | ⚠️ | ⚠️ | 無 completed 後 claim next；無並行度；無 topological fan-out | state 有 dep 阻擋測試；orchestrator 無多 task |
| **Supervisor 純判斷** | `supervisor.ts` | ✅ | ❌ | 無 poll loop、無 liveness 探測器、無 setTaskStatus | `supervisor.spec.ts` |
| **Reclaim fence** | `reclaim.ts` | ✅ | ❌ | 無 DeadProof→reclaim claim→relaunch；無 generation bump 執行器 | `reclaim.spec.ts` |
| **Heartbeat 語意** | orchestrator `recordHeartbeat` | ⚠️ | ⚠️ | `process.pid` = **orchestrator pid** 非 pane 內 worker；無法做真實 process fence | 僅 status 讀回 |
| **Delivery 驗證** | `delivery.ts` | ✅ | ❌ | 無 worker 產出 evidence 的 runtime；無 acceptDelivery 接線 | `delivery-integration.spec.ts` |
| **Integration（temp WT）** | `integration.ts` | ✅ | ❌ | 無 orchestrator endgame | 同上（真 git） |
| **FF Publisher** | `publisher.ts` | ✅ | ❌ | 無 markIntegrated 接線；無 leader clean gate 編排 | 同上 |
| **Recovery-fork resolve** | `recovery-fork.ts`, CLI | ✅ | ✅（獨立 store key） | **未**與 `TeamAggregateV1.tasks[].recoveryForkId` / status 聯動；無 auto-open fork | `recovery-fork.spec.ts`, `commands.spec.ts`, `team-resolve-fork-services.spec.ts` |
| **Mailbox** | `state.sendMailbox` | ✅ | ❌ | 無 worker/leader 通訊協定 | state.spec |
| **Progress / command evidence** | `state.recordProgress/Command` | ✅ | ❌ | worker 無法回報；lease 續約路徑未用 | state.spec |
| **read_only complete** | `completeReadOnlyTask` | ✅ | ❌ | orchestrator 不處理 read_only 捷徑 | state.spec |
| **attach / HUD** | — | ❌ | ❌ | OMC 有 capture/send；本 repo 無 | 無 |
| **madmax / 危險 launch 確認** | — | ❌ | ❌ | plan 明確 out of scope | 無 |
| **Autopilot × Team** | autopilot 獨立 | ❌ | ❌ | 無 resumeConversation 驅動 team worker | autopilot 單測 |
| **E2E team** | `e2e/*` | ❌ | ❌ | 僅 mock 字串提及 worktree；無 team e2e | — |
| **文件誠實度** | README, SKILL | ✅ | ✅ | 已標 v1 非 full DAG | — |

### v1 已交付（對照 plan）

1. `validateTeamManifest` → `TeamStateStore.create` → `GitWorktreeManager.create` → `claimTask` → `TmuxController.startWorker`(hold) → `recordHeartbeat`
2. CLI：`oma team start|status|stop|resolve-fork`
3. 文件不再宣稱 full DAG

### 明確未交付（plan Out of scope + 現況）

1. multi-task DAG scheduling  
2. real `agy` worker launch  
3. delivery → integration → publish  
4. supervisor poll / reclaim loop  
5. madmax / AuthorityLease-Saga / autopilot process drive  

---

## 2. 建議實作順序（垂直切片，每片都可 ship 可跑軟體）

原則：**每一切片結束時，使用者可用 CLI 證明新能力**；先閉環一條 happy path，再加故障恢復。

| 順序 | Slice 名稱 | 使用者可驗證的結果 | 依賴 |
|------|------------|-------------------|------|
| **S0** | （已完成）First-ready + hold | `start` 開 worktree+tmux；`status` alive；`stop` kill | — |
| **S1** | Real agy worker（單 task） | pane 內跑 `agy`（或 mock）；descriptor+env；interactive/headless 行為差異 | S0 |
| **S2** | Worker evidence + lease renew | worker/bootstrap 可 `recordProgress` / command evidence；lease 不過期於健康 worker | S1 |
| **S3** | Multi-task DAG（serial first） | task A complete 後自動 claim/start B | S1 + state mark complete 路徑 |
| **S4** | Delivery → Integration → Publish endgame | A 交付後 leader HEAD 快轉；task → `completed`；可清 worktree | S1–S2 + 既有 library |
| **S5** | Minimal supervisor loop | `oma team supervise` 或 start 後背景 poll；過期+DeadProof→reclaim；status 顯示 assessment | S1 + reclaim/supervisor 庫 |
| **S6** | Parallel ready fan-out | 多 empty-deps / 多已解鎖 task 並行（可選 maxWorkers） | S3 + S5 |
| **S7** | Recovery-fork 聯動 | dead/orphan → open fork aggregate；resolve-fork 寫回 team task claim | S5 + recovery-fork |
| **S8** | Product polish | attach、mailbox 協定、e2e、madmax、HUD | 前序 |

**不建議**先做 S6/S7 而不做 S1/S4：沒有真實 worker 與 publish，並行與 fork 只會放大 hang 狀態。

---

## 3. 各剩餘 Slice：檔案、API、驗收測試、風險

### S1 — Real `agy` worker launch（取代 / 並存 worker-hold）

**目標:** pane 指令從 `node worker-hold.js marker descriptor` 變為可啟動 `agy` 的 bootstrap；hold 保留作測試雙模。

**修改/新增:**

| 動作 | 路徑 |
|------|------|
| **Create** | `src/team/worker-bootstrap.ts`（或 `worker-launch.ts`）— 讀 descriptor → 組 env → `spawn`/`exec` 到 `agy` |
| **Modify** | `src/team/orchestrator.ts` — `workerMode` 選擇 hold vs agy；組 task prompt / argv；注入 binding env |
| **Modify** | `src/team/tmux.ts`（可選）— `StartTmuxWorkerInput.env?: Record<string,string>`；`tmux set-environment -t session` 或 wrapper |
| **Modify** | `src/team/commands.ts` / `defaultOrchestrator` — `agyCommand`、packageRoot、stateRoot 注入 options |
| **Modify** | `src/team/types.ts` — 擴充 descriptor schema（task prompt、mode directive、binding fields） |
| **Create** | `tests/team/worker-bootstrap.spec.ts` |
| **Modify** | `tests/team/orchestrator.spec.ts` — mock `agy` PATH（沿用 `e2e/mocks/agy` 模式） |

**重用 API:**

- `TmuxController.startWorker`（`executablePath` + `bootstrapArgv` + `descriptorPath`）
- `ManagedInvocationService` / `ordinaryEnvironment` 對照：managed 需  
  `OMA_SESSION_ID`, `OMA_LAUNCH_NONCE`, `OMA_INVOCATION_GENERATION`,  
  建議再加 `OMA_WORKSPACE_PATH`（= worktree）、`OMA_STATE_ROOT`、`OMA_PACKAGE_ROOT`  
  （見 `src/cli/managed-invocation.ts` `runManaged`）
- `buildModeCommand` / `ModeDirectiveRenderer`（ralph/ultrawork/search）— team task 是否對應 mode **需決策**（見 §8）
- `sha256` / descriptor 只存 `claimTokenDigest`（orchestrator 已做）

**建議 argv / 組裝（與現況相容）:**

```
tmux new-session -d -s <session> -c <worktree> \
  '<node> <worker-bootstrap.js> <marker> <descriptor.json>'
```

bootstrap 內部：

1. 寫 ready marker  
2. 讀 descriptor（teamId, taskId, generation, claimToken **不得**再從 disk 讀明文 — 明文僅 launch 當下 env 或 fifo；見風險）  
3. 設定 env + `spawn(agy, argv, { cwd: worktree, env, stdio: inherit })`  
4. 等子程序退出後 exit（讓 pane 結束 → supervisor 可偵測 dead）

**驗收測試:**

- `ORCH-S1-01`：`PATH` 含 mock agy；start 後 pane 存活、mock 寫出「saw env OMA_SESSION_ID」檔  
- `ORCH-S1-02`：descriptor 無明文 claimToken  
- `ORCH-S1-03`：headless vs interactive 至少 argv/env 可觀測差異  
- 真 tmux；無 tmux skip  

**風險:**

- claim token 今日寫入 `TeamStateStore` **明文**（`claim.token`），與 recovery-fork「digest only」不一致 → 安全債  
- heartbeat `pid=process.pid`（leader）→ 無法用 process fence 判斷 worker 死活  
- tmux 經 shell 字串拼接：路徑/引數必須持續 `shellQuote`  
- interactive `agy` 佔用 TTY；tmux pane 通常夠用，但 CI 無 TTY 需 mock  
- exact_env 與 **per-worker session** 的 SessionLocator 是否共用 leader session 未定  

---

### S2 — Worker evidence surface（progress / command / lease）

**目標:** 健康 worker 可續租；verification commands 有 durable evidence。

**修改/新增:**

| 動作 | 路徑 |
|------|------|
| **Create** | `src/team/worker-api.ts` — 以 claimToken+generation+expectedRevision 呼叫 store |
| **Modify** | bootstrap 週期性 heartbeat **與** progress（注意：state 設計 heartbeat **不**續租，progress 才續租 — `state.spec` TEAM-05/06） |
| **Optional CLI** | `oma team worker progress|heartbeat`（供 agy 工具/hook 呼叫） |

**重用:** `TeamStateStore.recordProgress`, `recordCommandEvidence`, `recordHeartbeat`

**驗收:**

- progress 後 `leasedUntilMs` 延長  
- 錯誤 token/generation → `E_REVISION_CONFLICT`  
- command evidence 冪等（同 id 同內容）  

**風險:** worker 持有 stateRoot 寫入權 → 必須 claim 門禁；勿讓 worker 寫 ownerNonce 相關欄位。

---

### S3 — Multi-task DAG scheduling（先 serial）

**目標:** 當 task 進入 `completed` 後，orchestrator 能挑下一個「deps 全 completed」的 pending task 並 start worker。

**現況事實:**

- `manifest` 已 acyclic + scope overlap 需依賴序  
- `claimTask` 已阻擋未完成 deps（`E_TASK_DEPENDENCY_BLOCKED`）  
- `pickFirstReadyTask` **只**找 `dependencies.length === 0`，**忽略** runtime completed 集合  

**修改:**

| 動作 | 路徑 |
|------|------|
| **Modify** | `orchestrator.ts` — `pickReadyTasks(manifest, tasks): Task[]`；`startFromManifest` 可 start 全部 initial ready **或** 先保持單 task + 新增 `advance(teamId)` |
| **Create** | `startWorkerForTask(...)` 私有方法（從 start 抽出） |
| **Modify** | 在 markIntegrated / completeReadOnly 成功後呼叫 `scheduleReady` |
| **CLI（可選）** | `oma team tick --team` 手動推進（supervisor 前的過渡） |

**重用:** `claimTask` dep 檢查、`GitWorktreeManager.create`（generation 從 claim 回傳）、session 命名 `oma-${team}-${worker}-g${gen}`

**驗收:**

- 兩 task：A dep=[]，B dep=[A]；模擬 A→completed 後 `advance` 啟動 B worktree+tmux  
- 並行禁止：B 在 A 未完成前 claim 失敗（已有 state 測試，補 orchestrator）  
- 無 ready 且未全部 completed → status blockers 非空（`summary()`）  

**風險:**

- revision CAS 競賽（多 leader tick）  
- 同一 task 重複 create worktree path 已存在 → 需 generation 目錄  
- 未定義「誰呼叫 advance」→ 過渡期用 CLI tick + S5 自動化  

---

### S4 — Delivery → Integration → Publish endgame

**目標:** worker 提交後，leader 路徑：validate delivery → temp integrate → FF publish → `markIntegrated` → 可 `removeIfSafe`。

**現況:** 三庫完整 + 真 git 測試；**零** orchestrator/CLI 呼叫。

**修改:**

| 動作 | 路徑 |
|------|------|
| **Modify** | `orchestrator.ts` — `ingestDelivery(teamId, taskId, evidencePath)` 或 `finalizeTask(...)` |
| **Wire** | `DeliveryValidator.validate` → `TeamStateStore.acceptDelivery` → `IntegrationManager.prepare` → `FastForwardPublisherV1.publishCheckedOutRef` → `markIntegrated` |
| **CLI** | `oma team deliver --team --task --evidence` 與/或 supervise 自動偵測 delivery 檔  
| **Modify** | worktree cleanup：`removeIfSafe(..., { integrated: true })` 在 completed 後  

**重用型別:**

- `DeliveryEvidenceV1`, `ValidatedDeliveryV1`, `IntegrationTransactionV1`  
- journal 於 `managedRoot/integration/{tx}.json`  
- publisher 要求 leader clean + symbolic ref + expected-old-OID  

**驗收（擴充 delivery-integration 或 orchestrator e2e）:**

- TEAM-15 路徑經 orchestrator：leader HEAD 變為 integration tip  
- scope 外 diff → 不碰 leader  
- cherry-pick 失敗 → `integration_blocked` + `setTaskStatus`  
- 成功後 task status `completed`，claim 清除  

**風險:**

- leader dirty（worker-hold 的 `.oma-worker-*` 若寫在 leader 會污染；目前寫在 managed worktree — 正確）  
- publish 中途崩潰：已有 `recover()` — orchestrator 需在 restart 時 scan journal  
- `acceptDelivery` 仍把 status 設 `delivered_unintegrated` 但 **保留 claim**；publish 前需防 dual writer  
- verification commands 在 integration temp WT 跑（`IntegrationManager.prepare`）vs worker 側 commandEvidence — 雙軌語意需對齊  

---

### S5 — Minimal supervisor loop

**目標:** 週期性評估 lease 過期 workers；更新 status；DeadProof 可 reclaim。

**現況:**

```ts
// supervisor.ts — 純函式
assessWorker(task, heartbeat, nowMs, paneLiveness, processLiveness)
// reclaim.ts — inspectReclaimFence / requireDeadProof
// 無 loop、無 liveness 探測、orchestrator.status 不呼叫 assessWorker
```

**建議最小設計（詳 §6）:**

| 動作 | 路徑 |
|------|------|
| **Create** | `src/team/liveness.ts` — pane: `tmux has-session` + inspectOwnedPane；process: 依 heartbeat pid/startMarker（**先修 S1 heartbeat 語意**） |
| **Modify** | `orchestrator.ts` — `superviseOnce(teamId)`、可選 `superviseLoop` |
| **Modify** | `status()` 嵌入 assessment  
| **CLI** | `oma team supervise --team [--once|--interval-ms N]` 或 stop 前預設 once  
| **Reclaim 執行器** | DeadProof → 清 claim 或 generation+1 relaunch；Unknown → `orphan_identity_unproven`；Alive 過期 → `awaiting_interaction` + attachCommand  

**驗收:**

- hold 被 kill 後 superviseOnce → reclaimable/reclaimed  
- lease 未過期 → healthy（即使不查 pane — 現有 assess 語意）  
- 不誤殺他人 ownerNonce session  

**風險:** 在修好 process 身份前，DeadProof 幾乎永遠 Unknown 或誤判；**S5 應在 S1 heartbeat 修正後**。

---

### S6 — Parallel DAG fan-out

**目標:** 多個 ready task 同時 worktree+tmux。

**修改:** `pickReadyTasks` + `maxParallel` option；CAS 逐 task claim。

**驗收:** 兩獨立 task 同時 in_progress；兩 session alive。

**風險:** 機器資源、stateRoot 鎖、git worktree 並發 add；overlap scope 已由 manifest 禁無序 overlap。

---

### S7 — Recovery-fork 聯動

**目標:** 多 generation 候選時開 fork；`resolve-fork` 後 team task 拿到新 claim 並可 relaunch。

**現況:** recovery 用獨立 `StateStore` key `recovery/{team}/{task}`；team aggregate 有 `recoveryForkId` 欄位但 **無人寫入**。

**修改:** supervisor reclaim 路徑建立 RecoveryTaskAggregate；status `recovery_fork_unresolved`；resolve 後寫回 team claim（digest 策略與 fork 一致）。

**風險:** 雙 store 一致性；leader worktree 證明已完整 — 保持。

---

### S8 — Polish

- `oma team attach --team --task` → `tmux attach -t` / `select-pane`  
- mailbox 訊息 schema + CLI  
- e2e tier：mock agy + 真 git + 可選 tmux  
- 文件 / SKILL 更新完整度表  
- madmax 確認（OMX 模式）  

---

## 4. 真實 agy launch vs worker-hold

### 今日 worker-hold

| 項目 | 行為 |
|------|------|
| argv | `node worker-hold.js <marker> [descriptor]` |
| 副作用 | 寫 `ready\n` 到 marker；`setInterval` 永不退出 |
| env | **無** OMA_* |
| agy | 不啟動 |
| 結束 | 僅 kill session / kill process |

`TmuxController` 組命令：

```text
shellCommand = [executable, ...bootstrapArgv, descriptorPath].map(shellQuote).join(' ')
// 現況 bootstrapArgv = [holdEntry, markerPath]
// → node hold.js marker descriptor
```

### 建議真實 launch

```
┌─ TeamOrchestrator.startWorkerForTask ─────────────────────┐
│ 1. worktree + claim + descriptor (digest only)            │
│ 2. prepare binding: sessionId, launchNonce, generation=1  │
│ 3. optional: write task prompt file under worktree        │
│ 4. tmux.startWorker({                                      │
│      executable: process.execPath,                         │
│      bootstrapArgv: [workerBootstrapJs, marker],           │
│      descriptor,                                           │
│      env: { OMA_*, OMA_TEAM_*, PATH... }  // 需擴充 tmux    │
│    })                                                      │
│ 5. heartbeat 記錄 **pane 內 bootstrap pid**（讀 tmux pid）  │
└────────────────────────────────────────────────────────────┘
         │
         ▼
┌─ worker-bootstrap ─────────────────────────────────────────┐
│ read descriptor                                            │
│ write marker                                               │
│ spawn agy with:                                            │
│   cwd = worktree                                           │
│   env = exact_env binding + strip nothing critical         │
│   argv = mode/task 或 descriptor.promptArgv                │
│ wait child; exit with child code                           │
└────────────────────────────────────────────────────────────┘
```

### exact_env binding 是否需要？

| 情境 | 建議 |
|------|------|
| Worker 要跑 **plugin hooks continuation**（Stop continue） | **需要**完整 exact_env，否則 hooks fail-open 無 managed 語意 |
| Worker 只是「在隔離 worktree 跑一次 agy 任務」、不做 Sisyphus | 可 **弱 binding**：只注入 `OMA_WORKSPACE_PATH` + team claim 給工具，不建 SessionAggregate |
| 與 leader 共用同一 `OMA_SESSION_ID` | **不建議** — Stop/locator 會打架 |
| Per-worker SessionAggregate | 正確但重；S1 可先「team binding 子集」+ 不做 autopilot resume |

**建議 S1 決策預設（可被 §8 推翻）:**

1. **Per-worker** `OMA_SESSION_ID` / `OMA_LAUNCH_NONCE` / `OMA_INVOCATION_GENERATION=1`  
2. `OMA_WORKSPACE_PATH=worktreePath`，`OMA_STATE_ROOT=leader stateRoot`  
3. **額外** team env：`OMA_TEAM_ID`, `OMA_TASK_ID`, `OMA_CLAIM_TOKEN`（僅 env，不落盤）、`OMA_CLAIM_GENERATION`  
4. 不自動接 Autopilot resume（另 slice）  
5. 測試可用 `workerMode` 或 options 強制 hold  

### hold 保留理由

- CI / 無 agy auth  
- orchestrator 結構回歸  
- 作為 `workerMode: 'hold'` 或 `OMA_TEAM_WORKER=hold` 測試雙模  

---

## 5. Multi-task DAG：完成後如何 claim 下一個

### 狀態機（task）

```
pending
  → (deps all completed && claim) in_progress
  → delivered_unintegrated → (publish ok) completed
  → 或 read_only: completeReadOnlyTask → completed
  → lease expire: awaiting_interaction | orphan_identity_unproven | reclaimable…
  → recovery_fork_unresolved → (resolve) in_progress (new generation)
  → failed | cancelled | fenced_superseded | integration_blocked
```

### Ready 謂詞（應用層）

```ts
function isReady(taskSpec, runtimeTasks): boolean {
  const rt = runtimeTasks[taskSpec.id];
  if (!rt || rt.status !== 'pending') return false;
  return taskSpec.dependencies.every(
    (d) => runtimeTasks[d]?.status === 'completed',
  );
}
```

`claimTask` 已 enforce deps；orchestrator 必須在 **選 task 時**用 runtime status，而非 `dependencies.length === 0`。

### 推進觸發點（建議）

| 觸發 | 動作 |
|------|------|
| `startFromManifest` | create aggregate；**for each** initial ready（S6）或 first（相容 v1）；start workers |
| `finalizeTask` / markIntegrated 成功 | `scheduleReady(teamId)` |
| `completeReadOnlyTask` 成功 | 同上 |
| `superviseOnce` reclaim 後 | 可 relaunch 同 task 或 schedule 其他 |
| CLI `oma team tick` | 手動 scheduleReady（S3 過渡） |

### 演算法（serial 優先）

```
loop:
  snapshot = store.read()
  ready = manifest.tasks.filter(isReady)
  if ready empty:
    if summary.complete: return TeamComplete
    return Waiting
  pick = ready[0]  // 或 stable sort by manifest order
  create worktree g=claim.generation+1
  claimTask(pick)
  start tmux worker
  recordHeartbeat
```

並行：對 `ready.slice(0, maxParallel - inProgressCount)` 逐一 CAS claim（失敗則跳過）。

### Base SHA 策略（開放問題）

- **v1 現況:** 全 worker `git rev-parse HEAD` at start（leader）  
- **DAG 後:** 下游 task 的 base 應是  
  - (A) 當下 leader HEAD（含已 publish 的上游），或  
  - (B) 仍用 team start 時 snapshot  
- **建議:** (A) — 否則 integration 與 dep 語意分裂（見 §8）

---

## 6. Minimal supervisor loop 設計

### 職責邊界

| 元件 | 職責 |
|------|------|
| `assessWorker` | 純判斷（已有） |
| `probeLiveness(hb, tmux)` | 產 pane/process `ProcessLiveness` |
| `superviseOnce` | 讀 aggregate → 逐 in_progress task → assess → **寫回** status / reclaim 動作 |
| `superviseLoop` | `setInterval` 或 CLI 長跑；可檔案鎖防雙 supervisor |

### 參數建議

| 參數 | 建議預設 | 理由 |
|------|----------|------|
| `intervalMs` | **15_000** | 低於預設 lease 300_000；足夠快於人類 attach |
| `leaseMs` | 300_000（現有） | worker 需 progress 續租 |
| `staleHeartbeatMs` | 120_000 | 可選：heartbeat 過舊升級檢查（目前 assess 不看 recordedAtMs） |
| 鎖 | `teams/{id}/supervisor.lock` | 防多 leader |

### 狀態轉移（superviseOnce）

```
for task in tasks where status == in_progress:
  if claim.leasedUntilMs > now:
    report healthy; continue
  pane = probePane(heartbeat)      # has-session + owner nonce match
  proc = probeProcess(heartbeat)   # pid+startMarker（S1 修好後）
  assessment = assessWorker(...)
  switch assessment.status:
    healthy: (unreachable if lease expired unless clock skew)
    awaiting_interaction:
      setTaskStatus(task, 'awaiting_interaction')
      // 不 kill；輸出 attachCommand
    orphan_identity_unproven:
      setTaskStatus(task, 'orphan_identity_unproven')
      // 禁止 reclaim
    reclaimable:
      requireDeadProof
      // 最小：清 claim → pending（同 generation 或 +1）並保留 dirty worktree
      // 進階：開 recovery fork
```

### 與 status 的關係

`status` 應回傳：

```json
{
  "tasks": { "...": {} },
  "assessments": {
    "task-a": { "status": "healthy|...", "attachCommand": ["tmux", "select-pane", "-t", "%N"] }
  },
  "tmux": { "session": { "alive": true } }
}
```

### 不做（v1 supervisor）

- 自動 merge  
- 自動 resolve-fork  
- 自動對 alive pane send-keys  
- 全局 kill 未擁有 session  

---

## 7. Delivery → Integration → Publish 接入 orchestrator endgame

### 建議 pipeline（單一 task happy path）

```
Worker (in worktree)
  commits linear first-parent chain
  runs verification (records CommandEvidence via worker-api)
  writes DeliveryEvidence JSON (createDeliveryEvidence helpers)
  → signal: mailbox message or file `.oma-delivery.json` or CLI deliver

Leader orchestrator.finalizeTask(teamId, taskId, evidence):
  1. read aggregate + require claim match (or accept delivered path)
  2. DeliveryValidator.validate(evidence, {
       task, currentTaskRevision, manifestRevision,
       claimToken, generation,
       completedDependencies, commandEvidenceIds
     })
  3. store.acceptDelivery → status delivered_unintegrated
  4. IntegrationManager(managedRoot).prepare({
       leaderRepo, stateRevision, ownerNonce, delivery, verificationCommands?
     })
     on fail → setTaskStatus integration_blocked; stop
  5. FastForwardPublisherV1.publishCheckedOutRef(tx)
     on E_TARGET_REF_CHANGED → surface retry; do not force
  6. store.markIntegrated(taskId, rev, deliveryDigest)
  7. worktrees.removeIfSafe(desc, { ownerNonce, integrated: true })
  8. scheduleReady(teamId)   // DAG
```

### 接線位置

| 步驟 | 模組 |
|------|------|
| 編排 | `orchestrator.finalizeTask` / `runEndgame` |
| CLI | `oma team deliver` + supervise 掃描 |
| 狀態 | 已有 acceptDelivery / markIntegrated |
| 失敗 | `setTaskStatus(..., 'integration_blocked')` |
| 崩潰恢復 | 掃描 `managedRoot/integration/*.json`，`publishPhase` 非終態則 `publisher.recover` |

### Endgame 完成定義（acceptance）

- 單 task manifest：start →（mock worker commit）→ deliver → leader 含變更 → task completed → summary.complete  
- 雙 task DAG：A publish 後 B base 含 A（若採 base=leader HEAD）  
- 任何失敗 **不** 留下 leader 半套 cherry-pick（library 已保證 temp WT）  

---

## 8. 明確分歧 / 待人為或 Architect 決策

| # | 問題 | 選項 | 影響 |
|---|------|------|------|
| **D1** | Worker 是否走 full exact_env + SessionAggregate？ | (a) full managed per worker (b) team-only env (c) 無 binding 純 agy | hooks continuation、locator 複雜度 |
| **D2** | claim token durable 明文？ | (a) 改 digest-only 如 recovery-fork (b) 維持明文但 0600 (c) 外部 secret store | 與現有 `requireClaim` 比對 token 字串相容性 |
| **D3** | Task prompt / agy argv 從哪來？ | (a) manifest 擴充 `prompt` 欄 (b) 外部 tasks/*.md (c) 固定 ultrawork directive + task id | manifest schema 版本 |
| **D4** | headless 的 agy 是否存在非互動旗標？ | 需查當前 `agy --help`；可能仍是 `-i` | S1 可測性 |
| **D5** | 下游 baseSha | (a) 每次 schedule 時 leader HEAD (b) team 固定 snapshot (c) 上游 task integration tip | integration 正確性 |
| **D6** | supervise 常駐 vs 手動 tick | (a) CLI long-run (b) 外部 cron (c) start 內嵌 child supervisor | 程序模型、signal |
| **D7** | deliver 觸發 | (a) worker 主動 CLI (b) leader 掃 branch commits (c) mailbox | 自動化程度 |
| **D8** | Reclaim 後同 worktree relaunch 或新 generation worktree？ | (a) 新 gN 路徑（現 create 契約）(b) reuse path | worktree.ts 已禁 exists |
| **D9** | Recovery-fork 與 team aggregate 單一真相來源 | (a) 嵌 team store (b) 保持旁路 recovery key + 指標 | 一致性 |
| **D10** | 並行預設 maxWorkers | (a) 1 until S6 (b) ∞ ready (c) CPU-1 | 資源 |
| **D11** | stop 語意 | (a) 只殺 tmux（現況）(b) cancel tasks + 保留 dirty WT (c) 強制清 | 資料安全 |
| **D12** | Fable 建議的「零件先接 start」已完成；下一步優先 S1 還是 S4？ | 本報告建議 **S1→S3→S4→S5** | 無 agy 的 publish 只能測假 delivery |

### 與上游 OMC/OMX 的差異（research_report）

- OMC：`runtime-v2` reconcile、cmux、merge-orchestrator saga — **本 repo 無**  
- OMX：HUD、mux capture/send、madmax confirm — **本 repo 無**  
- OMA 優勢：delivery/publish **guarded FF + journal** 比多數 sibling 更嚴；缺的是編排主迴圈與真實 worker  

### 已知實作債（v1 遺留，非「缺 feature」）

1. Heartbeat `process.pid` = orchestrator pid（`orchestrator.ts` recordHeartbeat）  
2. Durable claim **明文 token**  
3. `stop` 不更新 task status、不清理 worktree  
4. `status` 未整合 `assessWorker`  
5. recovery-fork 與 team task 狀態機斷開  
6. 無 e2e team  

---

## 9. 測試策略總表（剩餘）

| 測試 ID 建議 | 層級 | 需要 | 覆蓋 |
|--------------|------|------|------|
| ORCH-S1-* | unit+tmux | mock agy | real launch env |
| ORCH-S3-* | unit+git+tmux | hold ok | DAG advance |
| ORCH-S4-* | unit+git | 可無 tmux | endgame publish via orch |
| ORCH-S5-* | unit+tmux | hold+kill | supervise reclaim |
| ORCH-S6-* | unit+tmux | hold | parallel |
| E2E-TEAM-01 | e2e | mock agy | CLI start→deliver→status complete |

沿用：`GitFixture`、`TmuxFixture`（unavailable → skip）、**禁止** `exec`、spawn 陣列。

---

## 10. 建議「完成」定義（產品可對外宣稱 Team）

同時滿足：

1. `oma team start --manifest` 對 **N≥2 有依賴的 tasks** 能跑完至 `summary.complete`  
2. Worker 為真實 `agy` 或官方支援的 mock 雙模（文件寫清）  
3. 至少一條 delivery→publish 真 git 路徑經 CLI/orchestrator  
4. `superviseOnce` 能在 worker kill 後進入明確 terminal/reclaim 狀態（非永遠 in_progress）  
5. README 完整度表與行為一致；無 stub note  
6. unit 全綠；有至少 1 條 team e2e 或 orchestrator 多 task 整合測  

**目前：僅 (部分) 1 的 N=1 hold 版本成立。**

---

## 11. 參考路徑速查

| 用途 | 路徑 |
|------|------|
| Orchestrator v1 | `src/team/orchestrator.ts` |
| CLI | `src/team/commands.ts` |
| State CAS | `src/team/state.ts` |
| Delivery/Integ/Pub | `src/team/delivery.ts`, `integration.ts`, `publisher.ts` |
| Supervisor/Reclaim | `src/team/supervisor.ts`, `reclaim.ts` |
| Managed env 範本 | `src/cli/managed-invocation.ts` |
| v1 plan | `docs/superpowers/plans/2026-07-20-team-orchestrator-v1.md` |
| Fable 審查（部分過時） | `.omc/research/fable-review/fable5-full-review.md` |

---

*本報告為 omg-analyst / research 產物；權威產品決策仍應經 architect + `omg interview` / 人類確認 §8 決策表後再進 executor。*
