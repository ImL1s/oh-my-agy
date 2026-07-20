# OMA (oh-my-agy) Feature Completeness Council 報告 — Fable 5
日期:2026-07-20|Branch:`feat/team-orchestrator-v1`(HEAD `15b3dfa`)|審查者:Claude Fable 5(READ-ONLY)
Brief 來源:`.omc/research/fable-review/full-feature-review-brief-safe.md`(指令中的 `council/BRIEF-safe.md` 不存在,以此檔為準)

---

## 1. Executive Verdict(直白版)

1. **單代理核心迴圈是真的、可用的**:pass-through、magic keyword 攔截、意圖過濾、薛西弗斯 enforcer、熔斷器、PreInvocation/Stop hooks、setup/doctor 全部接線完成,build 綠、114 個 unit tests 全過、CI 三層(unit/package/e2e)驗證。
2. **本 branch 的 TeamOrchestrator v1 已推翻 brief hint #3 的舊狀態**:`oma team start --manifest` 現在真的會驗證 manifest → 建 Team aggregate → 建 git worktree → 開 owned tmux pane → 記 heartbeat,不再只是 CLI stub。
3. **但 tmux pane 裡沒有 agent 在工作**:pane 跑的是 `worker-hold.js`,它只寫一個 ready marker 然後 `setInterval` 空轉。原始碼註解自承「不啟動 agy(後續 plan)」。Team 是「骨架已立、心臟未裝」。
4. **`--madmax` / `--yolo` / `confirmDangerousLaunch` 是零程式碼**:整個 `src/` + `bin/` 找不到任何相關 argv 處理。`oma --madmax …` 會原樣透傳給 agy,沒有任何 gate。DESIGN.md §三.1 卻用「必須啟動二次確認」的義務語氣,與程式碼矛盾。
5. **delivery / integration / publisher / supervisor / reclaim 全是 library-only**:型別完整、單元測試齊,但 production 路徑(bin/、cli/、orchestrator)零呼叫者。
6. README 對 team v1 的描述誠實(「starts FIRST ready task … worker-hold」),文件債主要集中在 DESIGN.md。
7. 結論:這是一個**核心 wrapper 產品級、Team 子系統前 40% 垂直切片**的 codebase。距離「full OMC-style product」還缺 worker 真正執行、任務完成動線、與危險旗標 gate 三大塊。

---

## 2. tmux / Team 深度剖析

### 2.1 現在真的會發生什麼(`oma team start --manifest m.json`)

呼叫鏈:`bin/oma.ts:66`(structured 路由)→ `src/cli/application.ts:72` → `src/cli/services.ts:83-95`(`buildTeamContext`:stateRoot + git workspace identity)→ `src/team/commands.ts:137`(`teamCommand`)→ `src/team/orchestrator.ts:122`(`startFromManifest`)。

實際執行步驟(每步皆有真實作):
| 步驟 | 位置 | 狀態 |
|---|---|---|
| Manifest 驗證(schema、DAG 無環、依賴唯一) | `src/team/manifest.ts:23-55` | ✅ 真實 |
| Team aggregate 建立(revision/ownerNonce) | `orchestrator.ts:141-154` → `state.ts` | ✅ 真實 |
| 挑第一個無依賴 ready task(**只挑一個**) | `orchestrator.ts:156-159, 314-316` | ⚠️ v1 限制 |
| Git worktree 建立(branch `oma-team/{team}/{worker}-g1`) | `orchestrator.ts:167-176` → `worktree.ts:41-79` | ✅ 真實 |
| claimTask(lease 300s、token digest) | `orchestrator.ts:178-190` → `state.ts:63-83` | ✅ 真實 |
| tmux session 啟動(owner/worker nonce 雙標記) | `orchestrator.ts:212-226` → `tmux.ts:19-59` | ✅ 真實 |
| Heartbeat 記錄(`startMarker: tmux:<session>`) | `orchestrator.ts:229-242` | ✅ 真實 |
| 失敗路徑 cleanup(descriptor 移除 + worktree removeIfSafe + session kill) | `orchestrator.ts:221-226, 239-242` | ✅ 真實 |

`oma team status --team <id>` 讀 aggregate、用 `startMarker` 反推 session、`tmux has-session` 查存活(`orchestrator.ts:261-290`);`oma team stop` 用 ownerNonce 驗證後 kill(`:292-311`,`tmux.ts:81-90` 拒殺 nonce 不符的 session)。皆已接 CLI 並有測試(`tests/team/commands.spec.ts` 312 行注入 fake orchestrator 測 wiring;`tests/team/orchestrator.spec.ts` 用**真 tmux** fixture 測 ORCH-01 全鏈)。

### 2.2 缺什麼(hard truth)

1. **Worker 不做事**:`src/team/worker-hold.ts:1-27` 明文「僅維持 tmux pane 存活並寫入 ready marker;**不啟動 agy**(後續 plan)」。pane 內容 = `fs.writeFileSync(marker)` + `setInterval(() => {}, 60_000)`。`--worker-mode interactive|headless` 解析後只寫進 descriptor JSON(`orchestrator.ts:197-207`),**無行為差異**。
2. **只啟第一個 task**:`pickFirstReadyTask` 只回傳一個;多 task DAG 排程明列 out of scope(`docs/superpowers/plans/2026-07-20-team-orchestrator-v1.md:11`)。
3. **無任務完成動線**:`completeReadOnlyTask` / `recordProgress` / `recordValidation`(`state.ts:87+`)在 production 路徑**零呼叫者**(grep 驗證)。task claim 之後永遠停在 claimed,lease 300s 過期後也沒人 renew、reclaim 或收割。
4. **delivery → integration → publish 未接**:`DeliveryValidator`(`delivery.ts:75`)、`IntegrationManager`(`integration.ts:64`)、`FastForwardPublisherV1`(`publisher.ts:22`)只有 typed API + unit tests(`tests/team/delivery-integration.spec.ts` 等),orchestrator 註解自承 v1 不含(`orchestrator.ts:3`)。
5. **Supervisor 無 poll loop**:`supervisor.ts` 只有一個純函式 `assessWorker`(healthy/reclaimable/orphan 判定 + attach 指令建議),沒有任何常駐監控、也沒有 CLI 呼叫它。
6. **CI 的真 tmux 覆蓋不保證**:`tests/team/tmux.spec.ts:7` 與 `orchestrator.spec.ts:8` 用 `TmuxFixture.available() ? test : test.skip` — tmux 不存在時整組靜默 skip;`.github/workflows/ci.yml` 未顯式安裝 tmux,綠燈不必然代表真 tmux 路徑在 CI 執行過。
7. **e2e 零 team 覆蓋**:tier1–4 全是 mock-agy 的 wrapper 行為測試;tier3 的「worktree/dirty blocker」場景(TC-T3-07)只是 `MOCK_AGY_STDOUT` 印出來的字串(`e2e/tier3.spec.ts:115`),不是真流程。

### 2.3 值得肯定的工程品質

- tmux 所有權模型嚴謹:session `@oma_owner_nonce` + pane `@oma_worker_nonce` 雙 nonce,kill 前 readback 驗證(`tmux.ts:81-90`),session 名稱/nonce/路徑全部消毒(`tmux.ts:118-131`)。
- Worktree 安全:路徑 containment、branchName/SHA 白名單、dirty blocker 真實存在(`worktree.ts:92-94` 以 `git status --porcelain=v1 --untracked-files=all` 拒清髒 worktree)、owner marker 交叉驗證(`:85-91`)。
- resolve-fork 的 leader 身分證明是全 repo 最強的一段:caller 的 git worktree identity(realpath/repoKey/gitCommonDir/workspaceKey)必須與 durable aggregate 的 canonical leader 四重相符(`commands.ts:255-308`),claimToken 只存 digest、明文單次發放(`commands.ts:236-247`)。

---

## 3. madmax / 危險旗標深度剖析

### 3.1 程式碼證據:零實作

`grep -rn -i "madmax|yolo|confirmDangerousLaunch"` 於 `src/` + `bin/`:**0 命中**(僅 DESIGN.md 與 plan 文件)。三條路徑逐一驗證:

| 輸入 | 路徑 | 實際行為 |
|---|---|---|
| `oma --madmax <args>` | `shouldUseStructuredCli` 不命中(`bin/oma.ts:62-74`)→ 無 magic keyword → pass-through | `spawn('agy', ['--madmax', …])` **原樣轉發、無任何 gate**(`bin/oma.ts:271`;僅剝 `OMA_*` binding env) |
| `oma ralph --madmax task`(無 `--`) | legacy magic:剝 `ralph` 後轉發 | `spawn('agy', ['--madmax','task'])` 同樣無 gate(`bin/oma.ts:203`) |
| `oma ralph --madmax -- task` | structured:`parser.ts:23-24` 取 `--` 後為 task | `--madmax` 被**靜默丟棄**——mode 與 `--` 之間的 token 不報錯、不轉發、不留痕 |

### 3.2 文件矛盾

- `DESIGN.md:27`(設計藍圖段):誠實列為未實作 Future Plan。✅
- `DESIGN.md:102`(模組架構 §三.1):「若偵測到 `--madmax` 或 `--yolo` 等高風險標記,**必須**啟動二次確認彈出視窗」— 義務語氣描述現行模組,**與程式碼不符**。❌
- `docs/superpowers/plans/2026-07-20-team-orchestrator-v1.md:11, 987`:明列 out of scope。✅

### 3.3 安全含義

OMA 自我定位是「safe Antigravity orchestration」(`application.ts:22`)。使用者若因 DESIGN.md §三.1 相信 wrapper 會攔高風險旗標,實際得到的是**裸 agy 行為**。這不是漏洞(wrapper 本來就透傳),但是**安全語意的文件詐欺風險**。另 `parser.ts` 靜默丟 token 是行為缺陷:使用者打 `oma ralph --some-flag -- task` 會以為 flag 生效了。

---

## 4. 全表面完整性矩陣

Status:COMPLETE|LIBRARY_ONLY|STUB|PARTIAL|DESIGN_ONLY|ABSENT

| # | Surface | Status | CLI wired? | Tests | User-ready? | Gap 摘要 |
|---|---|---|---|---|---|---|
| 1 | Pass-through + env strip | **COMPLETE** | ✅ | e2e T1/T2 | ✅ | `ordinaryEnvironment` 剝 5 個 `OMA_*`(`managed-invocation.ts:187-191`) |
| 2 | Legacy magic 攔截(ralph/ultrawork/search) | **COMPLETE** | ✅ | e2e T1-06~10, T2-11~15 | ✅ | — |
| 3 | Managed modes(`-- ` + exact_env binding) | **COMPLETE** | ✅ | unit(parser/managed-invocation) | ✅ | 注入 SESSION_ID/LAUNCH_NONCE/GENERATION(`:153-161`) |
| 4 | Intent filter(codeblock 去噪 + 諮詢語境) | **COMPLETE** | ✅ | e2e T2-11~14 | ✅ | — |
| 5 | Continuation enforcer + 熔斷器 | **COMPLETE** | ✅ | e2e T1 功能三/四、T4 | ✅ | 無 destructive git(enforcer.ts 僅 `rev-parse`) |
| 6 | Autopilot FSM(9 子命令) | **PARTIAL** | ✅ | unit ×2 spec | ⚠️ | 純簿記狀態機:**不 spawn agy**,`resume --conversation` 只記 id;process drive 明列 out of scope |
| 7 | Team start/status/stop | **PARTIAL** | ✅(本 branch 新增) | unit(fake + 真 tmux) | ⚠️ | worker-hold 空轉;單 task;無 complete/renew;§2.2 |
| 8 | Team resolve-fork | **COMPLETE** | ✅ | unit ×2 spec | ✅ | leader 四重身分證明;token 單次發放 |
| 9 | TmuxController | **COMPLETE**(as lib) | 經 orchestrator | 真 tmux unit(可 skip) | ✅ | CI 未保證真 tmux 執行 |
| 10 | GitWorktreeManager + dirty blocker | **COMPLETE**(as lib) | 經 orchestrator | unit + 真 git fixture | ✅ | cleanup 只在 start 失敗路徑觸發 |
| 11 | Delivery / Integration / Publisher | **LIBRARY_ONLY** | ❌ | unit | ❌ | production 零呼叫者 |
| 12 | Supervisor / Reclaim | **LIBRARY_ONLY** | ❌ | unit | ❌ | 純函式,無 poll loop |
| 13 | `--madmax`/`--yolo`/confirmDangerousLaunch | **DESIGN_ONLY** | ❌ | 無 | ❌ | 透傳無 gate;DESIGN.md §三.1 語氣誤導;§3 |
| 14 | Hooks PreInvocation + Stop | **COMPLETE** | plugin hooks.json | unit ×3 spec | ✅ | 官方契約對齊、fail-open |
| 15 | Setup transaction + doctor | **COMPLETE** | ✅ | unit ×3 spec | ✅ | — |
| 16 | State root / lock / session aggregate | **COMPLETE** | 內部 | unit ×8 spec | ✅ | — |
| 17 | CI / release / install / smoke | **COMPLETE** | — | GHA 3 jobs | ✅ | ci.yml 無 tmux 安裝步驟 |
| 18 | Sandbox / write-block / maxOutputBytes / maxProcessCount | **DESIGN_ONLY** | ❌ | 僅 mock e2e | ❌ | DESIGN.md 藍圖段誠實標註 |

---

## 5. 證據索引

| 主張 | 證據 |
|---|---|
| worker-hold 不啟 agy | `src/team/worker-hold.ts:3, 26-27` |
| v1 僅單 task、無 delivery/supervisor | `src/team/orchestrator.ts:2-3, 156-159` |
| team CLI 已接 orchestrator | `src/team/commands.ts:120-132, 148-200`;`src/cli/services.ts:83-95` |
| tmux 雙 nonce 所有權 | `src/team/tmux.ts:47-58, 81-90` |
| dirty blocker 真實 | `src/team/worktree.ts:92-94` |
| leader 身分四重證明 | `src/team/commands.ts:276-291` |
| madmax 零程式碼 | grep 全 repo 僅 DESIGN.md/plan 命中;`bin/oma.ts:62-74, 271` |
| `--` 前 token 靜默丟棄 | `src/cli/parser.ts:23-25` |
| autopilot 不 spawn process | `src/autopilot/runtime.ts` 全檔無 spawn/exec;`services.ts:66-82` |
| completeTask 零 production 呼叫者 | grep `completeReadOnlyTask|recordProgress|recordValidation` 僅 `state.ts` 自身 |
| 真 tmux 測試可 skip | `tests/team/tmux.spec.ts:7`;`.github/workflows/ci.yml` 無 tmux 安裝 |
| e2e team 場景是 mock 字串 | `e2e/tier3.spec.ts:115` |
| build + unit 綠 | 本次實跑:`tsc` 成功、32 suites / 114 tests 全過(13.9s) |
| DESIGN.md 矛盾 | `DESIGN.md:27`(藍圖,誠實)vs `DESIGN.md:102`(義務語氣,不符) |

---

## 6. 建議下一步實作順序(最小有用增量)

1. **P0 — worker 真正執行**:worker-hold 讀 descriptor 後 exec `agy`(或 managed `oma ralph -- <task.goal>`),task prompt 來自 manifest;完成後呼叫 `completeReadOnlyTask` / 寫 evidence。這一步把 Team 從「骨架」變「能做事」。
2. **P0 — 危險旗標決策(二選一)**:(a) 在 pass-through 前實作最小 `confirmDangerousLaunch`(高風險旗標清單 + TTY 確認);或 (b) 改 DESIGN.md §三.1 為藍圖語氣,明示「無 gate,等同裸 agy」。同時修 `parser.ts`:`--` 前未知 token 回 `E_DIRECTIVE_INVALID` 而非靜默丟棄。
3. **P1 — lease 生命週期閉環**:worker heartbeat 續 lease;`team status` 顯示 lease 過期;接 `assessWorker` 做 reclaim 判定 CLI(`oma team reclaim`)。
4. **P1 — 完成動線垂直切片**:單 worker 的 delivery evidence → `DeliveryValidator` → `IntegrationManager` → `FastForwardPublisherV1`,接成 `oma team integrate`。
5. **P1 — CI 顯式安裝 tmux** 並斷言真 tmux 測試未被 skip(防綠燈假象)。
6. **P2 — 多 task DAG 排程**(依賴解鎖後啟下一個 worker)、`worker-mode` 實質行為差異、autopilot process drive(`resumeConversation` wiring)。

---

## 7. 最終評分

| 面向 | 完整度 | 理由 |
|---|---|---|
| (a) 核心單代理迴圈 | **85%** | pass-through/magic/managed/enforcer/hooks/setup/doctor 全接線且測試綠;扣分:autopilot 是純簿記(沒有東西真的被驅動)、madmax gate 缺席 |
| (b) Team / tmux | **40%** | start→claim→worktree→tmux→heartbeat 垂直切片真實且工程品質高;但 worker 空轉、單 task、無完成/交付/監督動線,e2e 零覆蓋 |
| (c) 產品 polish | **65%** | CI/release/install/doctor/README 誠實到位;扣分:DESIGN.md §三.1 語氣矛盾、CI 真 tmux 不保證、parser 靜默丟 token |

**一句話總結**:OMA 今天是一個**可信賴的 agy 安全 wrapper + 正在長出第一隻手臂的 Team 編排器**;說它是「full OMC-style product」還早——worker 得先學會做事,危險旗標的承諾得先兌現或撤回。
