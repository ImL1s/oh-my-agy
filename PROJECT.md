# 專案說明文件 (PROJECT.md) - oh-my-agy

## 一、 系統架構 (Architecture)

* **CLI 進入點 (`bin/oma.ts`)**：雙路徑入口。結構化子命令（`autopilot` / `team` / `setup` / explicit `ralph|ultrawork|search --`）走 `src/cli/application.ts` + `createDefaultServices`；自然語言魔術關鍵字與一般透傳仍走 legacy enforcer 路徑。
* **結構化 CLI (`src/cli/*`)**：argv 解析、managed invocation（exact-env binding）、Autopilot / Team / Setup wiring。
* **Autopilot FSM (`src/autopilot/*`)**：durable `SessionAggregateV1` 狀態機，支援 start / checkpoint / review / qa / resume / cancel / doctor / reset-breaker。
* **Team runtime (`src/team/*`)**：manifest DAG、tmux ownership、worktree、reclaim、recovery-fork、delivery、guarded publish。
* **Repository workflow (`src/workflows/*`)**：versioned DAG、permission envelope、bounded dispatch、journal replay、skeptic/verifier 與 ship/no-ship gate。
* **MCP / Wiki / HUD (`src/mcp/*`, `src/wiki/*`, `src/hud/*`)**：六個受限 read/proposal tools、deterministic 文件索引與 redacted 狀態投影。
* **Native / Notify adapters (`src/native/*`, `src/notify/*`)**：`HostCapabilityProfile` 以 tri-state outcome、evidence tier/source、exact host/plugin identity 與 route receipt 統一 native/fallback truth；通知需 owner nonce + generation，預設停用。
* **Resume / Recovery (`src/continuation/*`)**：exact conversation resume 與 immutable bounded partial recovery。
* **Install lifecycle (`src/setup/*`)**：verified installer receipt、immutable update、ownership-aware uninstall、release-mode doctor。
* **薛西弗斯延續器 (`src/enforcer.ts`)**：監聽 `.agy/todo.json`，未完成任務時倒數並注入 continuation prompt。
* **熔斷器**：連續無進度達上限時進入 `tripped`；**絕不**執行 `git reset --hard` / `git clean -fd`。
* **Plugin hooks**：僅 PreInvocation + Stop（`plugin.json` / `hooks.json` → `dist/src/hooks/*.js`）。

## 二、 檔案結構 (Code Structure)

* `bin/oma.ts`：可執行 CLI
* `src/cli/`：application、parser、managed-invocation、services
* `src/autopilot/`：commands（argv）+ runtime（FSM）
* `src/continuation/`：session aggregate、progress oracle、locator
* `src/team/`：manifest、state、tmux、worktree、delivery、publisher、commands
* `src/workflows/`：repository workflow registry / planner / runner / replay / permissions
* `src/mcp/`、`src/wiki/`、`src/hud/`、`src/native/`、`src/notify/`：public composition surfaces
* `src/setup/`：plugin preflight + setup transaction
* `src/hooks/`：PreInvocation / Stop
* `src/runtime/`：lock、atomic、state-store、process、errors
* `src/enforcer.ts`：legacy continuation
* `tests/**`：unit；`e2e/**`：legacy CLI e2e
* `plugin.json`、`hooks.json`、`skills/`、`rules/`

## 三、 建置與測試

```bash
npm install
npm run build
npm run test:unit
npm run test:e2e
npm run test:package
npm run smoke
# live gate；沒有 fresh candidate-bound evidence 時預期 exit 1
npm run test:production
```

## 四、 介面契約摘要

* Autopilot 狀態 authority：`SessionAggregateV1`（expected revision CAS）
* Managed binding env：`OMA_SESSION_ID` / `OMA_LAUNCH_NONCE` / `OMA_INVOCATION_GENERATION`
* Team：`teamCommand(argv, context)`；`resolve-fork` 語意由 `RecoveryForkResolver` 擁有
* Setup：snapshot → validate → install → enable → list/readback；partial failure 不 uninstall
* Workflow：`.agy/workflows/` definition；`.agy/state/workflows/<run-id>/` journal；effect unknown fail-closed
* Production：七個 live seams 全部以 exact Git OID + 24h freshness 驗證，缺任一項即失敗
