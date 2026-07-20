# OMA (oh-my-agy) 全功能完整度審查報告

- 日期:2026-07-20
- Reviewer:Claude Fable 5(xhigh)— READ-ONLY 審查,未修改任何原始碼
- Repo:`/Users/iml1s/Documents/mine/oh-my-agy` @ `main`(HEAD `9e7992d`,tag `v0.1.0`)
- 驗證方式:全量原始碼閱讀 + `rg` 呼叫圖分析 + `npm run build`(通過)+ `npm run test:unit`(31 suites / 111 tests 全綠,本機有 tmux,真實 tmux 測試未被 skip)+ `npx jest e2e/tier1.spec.ts`(25/25 通過)

---

## 1. Executive Verdict(直白版)

1. **單一 agent 核心迴圈是真的、而且品質高**:managed modes(`ralph`/`ultrawork`/`search` + exact_env binding)、PreInvocation/Stop hooks、ProgressOracle、legacy enforcer/熔斷器、setup/doctor、CI/release — 端到端接線完整、測試扎實,這部分是 production-grade。
2. **tmux Team「不是產品,是零件庫」**:`src/team` 約 2,426 行(12 個模組)每一件零件都是真實作、有真 git/真 tmux 單元測試,但**沒有任何 production 程式碼把它們組起來**。`TmuxController`、`GitWorktreeManager`、`TeamStateStore`、delivery/integration/publisher、supervisor/reclaim 在 `bin/` 與 `src/cli/` 中**零呼叫者**。
3. `oma team start --manifest` 只做 manifest 驗證後印一段 JSON,連自己都承認:「`tmux worker lifecycle is started via typed Team APIs, not this CLI stub`」(`src/team/commands.ts:132`)。`--worker-mode interactive|headless` 解析後**只被回顯,無任何行為**。
4. **`--madmax` / `--yolo` / `confirmDangerousLaunch` 是純設計、零程式碼**:整個 `src/` + `bin/` 找不到任何相關 argv 處理。`oma --madmax …` 會原封不動透傳給 agy,沒有任何二次確認 gate。此概念實為 research_report 對 oh-my-codex VSCode 外掛行為的描述,被 DESIGN.md 收進藍圖。
5. 唯一真正接到 CLI 的 Team 功能是 `team resolve-fork` — 這條路徑(leader worktree 交叉證明 + CAS + 單次 claim token)是完整且嚴謹的。
6. e2e 的 Tier 3/4 有數個「mock 劇場」測試:用 `MOCK_AGY_STDOUT` 叫假 agy 印出 Worktree/AuthorityLease/Saga 字串再 assert 字串存在 — 驗證的是 mock 而不是功能。DESIGN.md 有誠實揭露這點,但測試本身無防護價值。
7. 文件誠實度整體不錯(DESIGN.md 明確分「已實作 vs 藍圖」),但有三處失準:`skills/oma-runtime/SKILL.md` 聲稱不存在的 `oma team status`;README Commands 區直接列 `oma team start --manifest <file>` 無 stub 警語;DESIGN.md 藍圖區反而**低報**了已實作的 worktree/dirty-blocker(library 已存在)。
8. 結論:OMA 今天是「**優秀的單 agent 安全包裝層 + 一座尚未通電的 Team 零件倉庫**」。要稱為 full OMC-style 產品,缺的是 orchestrator 與 autopilot 的程序驅動,不是零件。

---

## 2. tmux / Team 深度剖析

### 2.1 呼叫圖(核心證據)

`rg` 全 repo 呼叫圖分析結果:

- `TmuxController`(`src/team/tmux.ts:18`)的呼叫者**只有** `tests/team/tmux.spec.ts` — production 路徑(`bin/oma.ts`、`src/cli/**`)零引用。
- `src/team` 各模組在 `src/`(team 目錄以外)與 `bin/` 的 importer 清單:
  - `state.ts` / `publisher.ts` / `worktree.ts`(manager 部分)/ `integration.ts` / `reclaim.ts` / `tmux.ts` / `supervisor.ts` / `delivery.ts`:**無任何 production importer**。
  - 只有 `commands.ts` 被 `src/cli/services.ts:12` 引用,而 `commands.ts` 只用到 `recovery-fork.ts`、`manifest.ts`(驗證)、`worktree.ts`(僅 `resolveGitWorktreeIdentity` 身分證明函式)。

### 2.2 `oma team start` 實際做什麼

`src/team/commands.ts:105-134`:讀 manifest 檔 → `validateTeamManifest`(`src/team/manifest.ts:17`,267 行,含 write-scope/路徑正規化檢查,是真驗證)→ 印出 `{ ok, kind: 'manifest-validated', …, note: 'tmux worker lifecycle is started via typed Team APIs, not this CLI stub' }` → return 0。

**不會發生的事**:不建 worktree、不開 tmux pane、不寫 TeamStateStore、不產生 worker claim/heartbeat、不啟動 supervisor。`--worker-mode` 值(`commands.ts:71-74` 解析、`:131` 回顯)對行為零影響。

### 2.3 各零件的真實深度(皆為 LIBRARY_ONLY)

| 零件 | 檔案(LOC) | 實作深度 | 測試 |
|---|---|---|---|
| TmuxController | `tmux.ts`(133) | 真 spawnSync tmux:new-session/pane readback/`@oma_owner_nonce`+`@oma_worker_nonce` owner 選項、mismatched-owner 拒殺、失敗即 kill 清理、session 名與 nonce 白名單、shellQuote | `tests/team/tmux.spec.ts` 用**真 tmux**(無 tmux 時 skip;本機執行為真跑),fixture 有洩漏偵測(`tmux-fixture.ts:50-53`) |
| GitWorktreeManager | `worktree.ts`(163) | 真 `git worktree add -b`、owner marker(`*.owner.json`)、**dirty blocker 真實作**(`worktree.ts:92-94`:`git status --porcelain` 非空→`E_DELIVERY_UNINTEGRATED` 拒清理)、未整合 commit 保留(`:96-100`)、containment 檢查 | `tests/team/worktree.spec.ts`(真 git fixture) |
| TeamStateStore | `state.ts`(317) | claims/lease(token+generation)、heartbeats、progress、mailbox,CAS 語意 | `tests/team/state.spec.ts` |
| Delivery + Integration + Publisher | `delivery.ts`(221)+`integration.ts`(260)+`publisher.ts`(272) | 真 git:delivery evidence/scope 檢查、temporary integration 交易 journal、fast-forward-only guarded `update-ref`(expected-old-OID CAS,`publisher.ts:44-49`)、crash-recovery(`recoverLocked`) | `tests/team/delivery-integration.spec.ts`(真 git,含 non-ff 拒絕與 ref 不被污染的斷言) |
| Reclaim / Supervisor | `reclaim.ts`(48)+`supervisor.ts`(28) | 純函式:pane×process liveness fence(DeadProof/Alive/Unknown)、`assessWorker` 回 `attachCommand: ['tmux','select-pane',…]` | `reclaim.spec.ts`、`supervisor.spec.ts` |
| Recovery-fork | `recovery-fork.ts`(245) | CAS resolver、evidence digest、單次 claim token(durable 只存 digest) | `recovery-fork.spec.ts` + CLI 層 `commands.spec.ts` |

### 2.4 缺的是什麼(端到端斷鏈點)

1. **Orchestrator 不存在**:沒有任何程式把 manifest → worktree.create → tmux.startWorker → state.claim → supervisor 迴圈 → delivery → integration → publish 串起來。這是 Team 的「主程式」,目前完全缺席。
2. **Worker 端 runtime 不存在**:`StartTmuxWorkerInput.bootstrapArgv` 由呼叫者自備;沒有程式碼會為某個 team task 生成 agy 啟動命令、寫 heartbeat、回報 progress。`SupervisorHeartbeatV1` 在 production 中**沒有任何寫入者**。
3. **Supervisor 只有「判斷函式」沒有「迴圈」**:`assessWorker` 是 28 行純函式;無輪詢、無 reclaim 執行器、無 attach UX。
4. **CLI 面缺 `team status` / `stop` / `attach`**:`parseTeamCommand`(`commands.ts:34-82`)只接受 `resolve-fork` 與 `start`。
5. **e2e 零覆蓋**:`rg "autopilot|team|setup|doctor" e2e/` 只命中 tier3 的 mock stdout 字串;結構化 CLI 完全不在 e2e 範圍。

### 2.5 有接好的:`team resolve-fork`(COMPLETE)

`services.ts:83-95` → `teamCommand` → `attachLeaderActorFromRecovery`(`commands.ts:190-243`:以 caller cwd 的**真實 git worktree identity** 與 durable aggregate 的 leader worktree 四欄位交叉比對,不信任任意 state-root reader)→ `RecoveryForkResolver.resolve`(CAS + evidence digest + 單次 `issuedClaimToken`,durable 只存 digest)。CLI 層測試(`tests/cli/team-resolve-fork-services.spec.ts`、`tests/team/commands.spec.ts`)與 resolver 測試都在。這條路徑名副其實。

### 2.6 文件誠實度

- ✅ CLI stdout 自我揭露 stub(`commands.ts:132`);DESIGN.md 有「已實作 vs 藍圖」分節(`DESIGN.md:17-37`)。
- ⚠️ README `Commands` 區(`README.md:144`)列 `oma team start --manifest <file>` 無任何 stub 警語;「If you need…」表格倒是只推 `resolve-fork`。
- ❌ `skills/oma-runtime/SKILL.md` 聲稱 `oma team start|status|resolve-fork` — **`team status` 不存在**,會回 `E_VALIDATOR_REJECTED: Unknown team command`。
- ⚠️ DESIGN.md 藍圖區(`DESIGN.md:28-29`)把「Git Worktree 分配」「Dirty Blockers」列為「尚未實作」— 實際上 library 層已實作且有真 git 測試(方向是保守低報,但文件已過時)。

---

## 3. madmax / 危險旗標深度剖析

### 3.1 程式碼證據:零實作

```
rg -i "madmax|yolo|confirmDangerousLaunch|dangerous" --hidden -g '!node_modules' -g '!.git'
```
命中僅:`DESIGN.md:27`、`DESIGN.md:102`、`research_report.md:293`(描述 oh-my-codex VSCode 外掛的行為)、以及本 review brief。**`bin/` 與 `src/` 零命中。**

### 3.2 實際行為推演(依 `bin/oma.ts` 逐行)

| 輸入 | 路徑 | 結果 |
|---|---|---|
| `oma --madmax <args>` | `shouldUseStructuredCli` 不命中(`bin/oma.ts:62-74`)→ 無魔術關鍵字 → pass-through(`:271`) | `spawn('agy', ['--madmax', …])` **原樣轉發,無任何 gate**(僅剝除 `OMA_*` binding env) |
| `oma ralph --madmax task`(無 `--`) | legacy magic:剝 `ralph` 關鍵字 | `spawn('agy', ['--madmax','task'])` 同樣無 gate |
| `oma ralph --madmax -- task` | structured:`parser.ts:23-24` `argv.slice(delimiter+1)` | `--madmax` 被**靜默丟棄**(mode 與 `--` 之間的 token 既不報錯也不轉發) |

### 3.3 判定與安全意涵

- 判定:**DESIGN_ONLY**。DESIGN.md 的定位誠實(列在藍圖區),但 `DESIGN.md:102` 在「模組架構」段用「必須啟動二次確認」的規格語氣描述,讀者可能誤以為 CLI 已有此防線。
- 安全意涵:OMA 作為包裝層,對底層 agy 的高風險旗標**沒有增加任何防護**——風險面等同裸跑 agy。這不算引入新漏洞(OMA 沒放大權限,pass-through 還剝了 managed binding env 防 capability 外洩),但「宣稱有 gate 的設計 + 實際無 gate」的組合,對讀過 DESIGN.md 的使用者是一種虛假安全感。
- 附帶 parser 缺陷:managed 形式下 `--` 前的未知旗標**靜默消失**(而非報 `E_DIRECTIVE_INVALID`),違反最小驚訝原則,也讓未來加 gate 時多一個繞過面。

---

## 4. 全功能完整度矩陣

Status:COMPLETE(實作+接線+測試)| LIBRARY_ONLY(typed API 完整但無 production 呼叫者)| STUB(CLI 只做驗證)| PARTIAL | DESIGN_ONLY | ABSENT

| # | Surface | Status | CLI wired? | Tests | User-ready? | Gap 摘要 |
|---|---|---|---|---|---|---|
| 1 | Managed modes(ralph/ultrawork/search)+ exact_env | **COMPLETE** | ✅ `oma <mode> -- task` | directives/managed-invocation/application/plugin-preflight specs | ✅ | `--` 前多餘 token 靜默丟棄(parser.ts:23-24) |
| 2 | Legacy magic keyword 攔截(無 `--`) | **COMPLETE** | ✅ | e2e tier1/2/3/4(63 案) | ✅ | 僅為相容路徑,不注入 binding(by design) |
| 3 | Pass-through + `ordinaryEnvironment` env 剝除 | **COMPLETE** | ✅ | e2e + managed-invocation.spec:143 | ✅ | — |
| 4 | Hooks:PreInvocation bind + Stop ProgressOracle + processedStops | **COMPLETE** | ✅ hooks.json + CI pack 斷言 | managed-stop/continuation-decision/workspace/session-aggregate/session-locator specs | ✅ | 一切缺欄位皆 fail-open `allow`(安全取向正確,但 host 欄位漂移=靜默失效,僅 debug log 可查) |
| 5 | Continuation enforcer + 熔斷器(非破壞性) | **COMPLETE** | ✅ | breaker-safety.spec(真 git 驗證無 reset/clean)+ e2e tier1/2 | ✅ | legacy `.agy/todo.json` 專用 |
| 6 | Autopilot FSM(start/status/checkpoint/review/qa/resume/cancel/reset-breaker/doctor) | **PARTIAL**(作為產品)/ COMPLETE(作為 durable gate ledger) | ✅ 9 個子命令全接 | runtime.spec/commands.spec | ⚠️ | **純狀態機**:不 spawn agy、不驅動迴圈;`resume` 只改 binding state;`ManagedInvocationService.resumeConversation`(managed-invocation.ts:115)**無任何 CLI 呼叫者**;evidence 檔須外部產生 |
| 7 | Team `resolve-fork` | **COMPLETE** | ✅ | commands.spec + team-resolve-fork-services.spec + recovery-fork.spec | ✅ | — |
| 8 | Team `start` / tmux worker 生命週期(端到端) | **STUB**(CLI)+ 零件 LIBRARY_ONLY | ❌(僅 manifest 驗證) | 零件各有單元測試;**無整合測試、無 e2e** | ❌ | 無 orchestrator、無 worker runtime、無 heartbeat 寫入者、`--worker-mode` 無行為 |
| 9 | TmuxController(owner nonce start/inspect/kill) | **LIBRARY_ONLY** | ❌ | 真 tmux 單元測試(本機實跑通過) | ❌ | production 零呼叫者 |
| 10 | GitWorktreeManager + dirty blockers | **LIBRARY_ONLY** | ❌ | worktree.spec(真 git) | ❌ | 同上;DESIGN.md 藍圖區反而低報此項 |
| 11 | Delivery + temporary Integration + FF Publisher | **LIBRARY_ONLY** | ❌ | delivery-integration.spec(真 git、non-ff 拒絕) | ❌ | 同上 |
| 12 | Reclaim fence / Supervisor assess + heartbeat | **LIBRARY_ONLY** | ❌ | reclaim.spec/supervisor.spec | ❌ | 只有判斷函式,無輪詢迴圈與執行器 |
| 13 | TeamStateStore(claims/lease/progress/mailbox) | **LIBRARY_ONLY** | ❌ | state.spec | ❌ | 同上 |
| 14 | `--madmax`/`--yolo`/confirmDangerousLaunch | **DESIGN_ONLY** | ❌ | 無 | ❌ | 透傳無 gate;見 §3 |
| 15 | Plugin setup transaction(validate→install→enable→readback,冪等) | **COMPLETE** | ✅ `oma setup` | setup-transaction.spec | ✅ | — |
| 16 | `oma doctor`(7 檢查,strict plugin fail-closed) | **COMPLETE** | ✅ | doctor.spec | ✅ | — |
| 17 | State root / SessionAggregate / owner-safe lock / atomic write | **COMPLETE**(被 4/6/15 實際使用) | n/a | state-root/session-aggregate/lock-safety/state-store specs | ✅ | — |
| 18 | Install script / CI / release packaging | **COMPLETE** | n/a | ci.yml(Node 20/22 + pack 斷言 hooks)、release.yml(tag↔version 同步)、smoke.sh;tag `v0.1.0` | ✅ | npm 未發布(README 已標 Future) |
| 19 | Intent filter(codeblock 去噪 + 諮詢意圖 80 字元視窗) | **COMPLETE** | ✅(legacy 路徑) | e2e tier2 邊界組三 | ✅ | 僅作用於 legacy magic 路徑 |
| 20 | Process spawn 安全(全 spawn/spawnSync、signal→128+n、SIGINT 轉發、PGID 超時清理) | **COMPLETE** | ✅ | process-runner.spec + e2e SIGINT 案(Linux code null/130 已修) | ✅ | — |
| 21 | 藍圖項:Planning write-block 沙盒、maxOutputBytes、maxProcessCount、AuthorityLease/Saga、唯讀探測沙盒 | **DESIGN_ONLY** | ❌ | 僅 tier3/4 **mock 劇場**(MOCK_AGY_STDOUT 回顯斷言,e2e/tier3.spec.ts:104,115) | ❌ | DESIGN.md 已誠實標註;mock 測試無防護價值 |

其他文件/程式碼落差:
- `SKILL.md` 的 `team status` 不存在(❌ 文件 bug)。
- `AGENTS.md:33` 寫「108 unit tests」,實際 111(輕微漂移)。
- DESIGN.md「當前已實作」節只寫 legacy 三件套,未提結構化 CLI/hooks/autopilot/team(過時,保守方向)。

---

## 5. 證據索引

| 主題 | 位置 |
|---|---|
| managed 模式白名單(無 madmax) | `src/cli/parser.ts:15`、`bin/oma.ts:66-73` |
| `--` 前 token 靜默丟棄 | `src/cli/parser.ts:23-24` |
| team CLI 僅 2 子命令、start 為 stub | `src/team/commands.ts:34-82`、`:105-134`(note 於 `:132`) |
| TmuxController 全 API + owner nonce | `src/team/tmux.ts:18-99`;唯一呼叫者 `tests/team/tmux.spec.ts` |
| Dirty blocker 真實作 | `src/team/worktree.ts:92-100` |
| FF-only guarded publish + recovery | `src/team/publisher.ts:38-70`、`recoverLocked` |
| Supervisor 僅純函式 | `src/team/supervisor.ts:11-27` |
| resolve-fork leader 交叉證明 | `src/team/commands.ts:190-243` |
| Autopilot 純狀態機(start 不 spawn) | `src/autopilot/runtime.ts:118-137`、resume `:240-267` |
| resumeConversation 無 CLI 呼叫者 | `src/cli/managed-invocation.ts:115`;`rg resumeConversation` 僅 tests |
| exact_env 注入與剝除 | `src/cli/managed-invocation.ts:147-161`、`:185-193` |
| Stop hook exact-env 再驗證 + 冪等 commitStop | `src/hooks/stop.ts:101-113`、`:154-174` |
| 熔斷非破壞性 | `src/enforcer.ts:352-360`、`tests/runtime/breaker-safety.spec.ts` |
| madmax 僅存在於文件 | `DESIGN.md:27`、`:102`;來源 `research_report.md:293` |
| e2e mock 劇場 | `e2e/tier3.spec.ts:100-122` |
| e2e 未覆蓋結構化 CLI | `rg "autopilot|team|setup|doctor" e2e/` 僅 tier3:115 mock 字串 |
| CI/release/smoke | `.github/workflows/ci.yml`、`release.yml`、`scripts/smoke.sh` |
| 測試結果 | `npm run build` ✅;`npm run test:unit`:31 suites / 111 tests 全綠(含真 tmux 案 TEAM-03/11);`npx jest e2e/tier1.spec.ts`:25/25 ✅ |

---

## 6. 建議的下一步實作順序(最小可用增量)

**P0 — 撐起「full OMC-style 產品」宣稱的缺口**
1. **Team orchestrator v1(最小垂直切片)**:`oma team start` 對 manifest 中**單一 task** 執行 `GitWorktreeManager.create` → `TmuxController.startWorker`(worker 內跑 `agy` + task 指令)→ `TeamStateStore.claim` 寫入。不做 supervisor、不做 delivery,先讓「start 會真的開出一個 worker pane」成立。每個零件都已有測試,這一步純接線。
2. **Autopilot 程序驅動**:把 `ManagedInvocationService.resumeConversation` 接上 `oma autopilot resume`(或新增 `oma autopilot drive`),讓 FSM 至少能啟動/續跑 agy 對話,而非純記帳。
3. **危險旗標決策**:二選一 — (a) 實作最小 `confirmDangerousLaunch`(pass-through 前偵測高風險旗標清單 + TTY 確認);(b) 從 DESIGN.md 模組架構段移除「必須」語氣,明示「無 gate,等同裸 agy」。同時修 `parser.ts` 讓 `--` 前未知 token 回 `E_DIRECTIVE_INVALID` 而非靜默丟棄。

**P1 — 重要不完整**
4. `oma team status` / `stop`:讀 TeamStateStore + `inspectOwnedPane` + `assessWorker` 輸出 JSON;`stop` 走 `killOwnedSession`(owner nonce)。同步修正 SKILL.md。
5. 結構化 CLI 的 e2e:mock agy 下跑 `oma setup/doctor/autopilot start→checkpoint→…/team start` 全流程(目前 e2e 只測 legacy 路徑)。
6. README `Commands` 區為 `team start` 加 stub 警語;DESIGN.md「已實作」節補上結構化 CLI/hooks/autopilot,藍圖區移除已實作的 worktree/dirty-blocker。
7. Worker heartbeat 寫入者 + supervisor 輪詢迴圈(讓 reclaim fence 有實際資料來源)。

**P2 — nice-to-have**
8. Delivery→Integration→Publish 接上 orchestrator(完成 Team 後半段)。
9. 以真斷言取代或標註 tier3/4 mock 劇場測試。
10. maxOutputBytes / maxProcessCount / planning write-block 沙盒(藍圖項,依需求排期)。

---

## 7. 最終完整度評分

| 面向 | 分數 | 說明 |
|---|---|---|
| (a) 核心單 agent 迴圈 | **85%** | managed modes + hooks + oracle + enforcer + setup/doctor 完整且測試扎實。扣分:autopilot 不驅動程序、`resumeConversation` 斷頭、結構化 CLI 無 e2e、parser 靜默丟 token |
| (b) Team / tmux | **30%**(端到端)/ 零件庫本身約 70% | 零件真實且測試品質高,但 orchestrator/worker runtime/supervisor 迴圈全缺,CLI 是 stub;唯 resolve-fork 完整 |
| (c) 產品成熟度(docs/install/CI/release) | **70%** | CI/release/install/doctor 是真的;扣分:SKILL.md 幻覺子命令、README team start 無警語、DESIGN/AGENTS 數字與範疇漂移、npm 未發布 |

> 一句話:**今天可以放心把單 agent 迴圈交給使用者;Team 除了 resolve-fork 之外,一律不要對外宣稱可用。**「not wired」是準確的描述,不是「almost done」。
