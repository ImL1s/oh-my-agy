# oh-my-agy (OMA / OMY)

English: [README.md](../../README.md) · [简体中文](./README.zh.md) · [繁體中文](./README.zh-TW.md)

<p align="center">
  <img src="../../assets/oma-character.png" alt="oh-my-agy character" width="300">
  <br>
  <em>先把 Antigravity 拉起來 — 再交給 OMA 管 managed modes、exact-env binding 與 continuation。</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node.js 20+">
  <img src="https://img.shields.io/badge/host-Antigravity%20CLI-black" alt="Antigravity CLI">
  <img src="https://img.shields.io/badge/hooks-PreInvocation%20%2B%20Stop-blue" alt="hooks">
</p>

**Google Antigravity CLI（`agy`）的編排層。**  
與 [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)（OMC）、[oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex)（OMX）、[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）、[oh-my-grok](https://github.com/ImL1s/oh-my-grok)（OMG）為同一類 *orchestration 想法*，執行面是 **Antigravity-native**。

_不必背每個 `agy` flag。優先用 **in-session slash skills**（agy 上 `/autopilot`，Claude/Grok 上 `/oh-my-agy:autopilot`）。需要時再使用可選 `oma` / `omy` CLI 綁定 managed modes 與 durable ledger。_

> **Session-first（主要）：** `oma setup` 後重啟 host，在 session 內執行 slash skills。在 **Antigravity（`agy`）** 上 plugin skill 為裸 **`/autopilot`**。在 **Claude Code / Grok** 上用命名空間 **`/oh-my-agy:autopilot`**，以便 OMC 保留裸 `/autopilot`。  
> **CLI（次要）：** `oma ralph|ultrawork|search|autopilot|team` 用於 managed exact_env / durable FSM。Skill 正文仍是 loop 的 source of truth。

> **非官方。** 與 Google / Antigravity 無關聯。Managed hooks 需要 `PATH` 上可用且已認證的 `agy`。

---

## 心智模型

OMA **不取代** Antigravity。

| 層 | 職責 |
|-------|-----|
| **`agy`** | Agent 工作（TUI、工具、對話） |
| **Plugin + hooks** | `PreInvocation` / `Stop` lifecycle 入口 |
| **`oma` CLI** | Managed modes、Autopilot FSM、Team、setup |
| **Session skills** | Plugin `skills/*` workflow（autopilot/ralph/ultrawork/…）— **in-session** 協定（OMC/OMX 風格） |
| **State root** | Session aggregate、binding、processedStops（僅 owner） |

| 元件 | 角色 |
|-----------|------|
| **Plugin** | `plugin.json` + `hooks.json`（僅 PreInvocation、Stop） |
| **Workspace hooks** | 可選 `.agents/hooks.json` 用於專案本地 host 載入 |
| **`oma` / `omy`** | 同一二進位 → managed launch / autopilot / team / pass-through |

---

## 快速開始

### 主要 UX（in-session slash）

安裝後 **重啟 host session** 並輸入：

| Host | 規範 slash |
|------|-----------------|
| **Antigravity（`agy`）** | `/autopilot <goal>`（oh-my-agy plugin skill） |
| **Claude Code / Grok** | `/oh-my-agy:autopilot <goal>`（命名空間；與 OMC 裸 `/autopilot` 共存） |

```text
# agy session
/autopilot <your goal>

# Claude Code / Grok session
/oh-my-agy:autopilot <your goal>
```

還有：`ralph`、`ultrawork`、`team` 等（agy 上裸名；Claude/Grok 上 `/oh-my-agy:…`）。

### 一次性安裝（clone）

```bash
git clone https://github.com/ImL1s/oh-my-agy.git
cd oh-my-agy
./scripts/install.sh
# build + PATH + oma setup（agy plugin + Claude/Grok slash surface）
oma doctor --no-strict-plugin
# 重啟 host，然後：
#   agy:     /autopilot …
#   Claude/Grok: /oh-my-agy:autopilot …
```

### 可選：Antigravity managed CLI ledger

**要求：** Node **20+** · `PATH` 上有 `agy`（用於 managed modes / hooks）

```bash
npm ci && npm run build
ln -sf "$(pwd)/dist/bin/oma.js" ~/.local/bin/oma
oma setup                    # agy plugin + Claude/Grok slash surface
oma setup --host claude      # 僅 slash（agy 不硬失敗）
oma setup --host agy         # 僅 agy plugin
oma setup --host all         # 同預設；agy 失敗仍繼續 slash 安裝
oma autopilot start -- "…"   # durable SessionAggregate（可選）
```

可選專案本地 hooks（部分 host 更可靠地載入 `.agents/hooks.json`）：

```text
.agents/hooks.json → node "../dist/src/hooks/{pre-invocation,stop}.js"
```

Smoke：

```bash
oma --help
oma ralph -- "Reply with exactly one word: pong"
```

### 已驗證 release 安裝

Registry 發佈**未設定**：不要從 npmjs.org 安裝無關的未 scoped `oh-my-agy` package，也不要假設 `@iml1s/oh-my-agy` 存在於 registry。從 GitHub Release 安裝，其中包含 package tarball 與 `SHA256SUMS`。

便捷一行（最新已驗證 release 為 `v0.5.2`）：

```bash
curl -fsSL https://raw.githubusercontent.com/ImL1s/oh-my-agy/main/scripts/install.sh \
  | bash -s -- --github --tag v0.5.2
```

手動 / 可重現選項：

```bash
# 先下載 installer，再解析 pinned release。
curl -fsSLo /tmp/oma-install.sh \
  https://raw.githubusercontent.com/ImL1s/oh-my-agy/main/scripts/install.sh
bash /tmp/oma-install.sh --github --tag v0.5.2

# 完全離線：驗證並安裝精確檔案，無網路/npm/build 步驟。
bash /tmp/oma-install.sh \
  --asset ./iml1s-oh-my-agy-0.5.2.tgz \
  --checksums ./SHA256SUMS
```

Release 位元組在啟動前經 checksum 驗證。installer 寫入 immutable receipt，供 ownership-aware 的 `oma update` 與 `oma uninstall` 使用。  
見 [發佈與安裝](../RELEASE.zh-TW.md) 與 [registry 策略](../npm-publishing.md)。

---

## 推薦預設流程

任務非平凡時（**session-first**）：

```text
1. 安裝一次：./scripts/install.sh   # 或：oma setup
2. 重啟 agy / Claude Code / Grok
3. /autopilot <goal>   (agy)  或  /oh-my-agy:autopilot <goal>  (Claude/Grok)
4. 留在 session 內；產物寫在 .agy/ 下
5. 可選 durable ledger（跨 session）：oma autopilot start|drive|…
```

**OMX 對齊的 Autopilot 階段：** `deep-interview → ralplan → ultragoal → code-review → ultraqa`  
發現 skills：host slash 選單，或 `oma skill list` / `oma skill show autopilot`。

| 若你需要… | 使用 |
|--------------|-----|
| 完整自主交付 | `/autopilot`（agy）或 `/oh-my-agy:autopilot`（Claude/Grok） |
| 持久單任務迴圈 | `/oh-my-agy:ralph` 或 `oma ralph -- "…"` |
| 並行 / 高吞吐 | `/oh-my-agy:ultrawork` 或 `oma ultrawork -- "…"` |
| 唯讀 plan 風格啟動 | `oma search -- "…"` |
| Durable Autopilot FSM | `oma autopilot start / status / checkpoint / resume` |
| 多 agent 首個 worker（v1） | 先執行 `oma native probe --live`，再用 `oma team start --manifest … --worker-mode headless` |
| Team mailbox / claim API（P0） | `oma team api <op> --input JSON`（OMX 子集，非 33-op 全量） |
| Team fork 解析 | `oma team resolve-fork …` |
| 版本化儲存庫審查 | `oma workflow install`，然後 `oma workflow run …` |
| MCP 讀/proposal 工具 | 設定 [`.mcp.json`](../../.mcp.json) 或執行 `oma mcp-server` |
| 狀態概覽 | `oma hud --json`（可選 `--watch`） |
| 文件索引 | `oma wiki index`，然後 `oma wiki search <query>` |
| 誠實的 host 能力檢視 | `oma native capabilities`（被動）/ `oma native probe --live`（明確 opt-in） |
| 精確 continuation / 有界 recovery | `oma resume …` / `oma recovery …` |
| 普通 `agy` | `oma <agy args…>`（pass-through；剝除 managed binding env） |

**Hook 觸發 ≠ 任務完成。** 首次 Stop 可能 `continue`；無進展 streak 後 trip；不要把 fail-open 的 `allow` 當作成功。

---

## 命令

```bash
oma --help
# Managed exact_env（推薦 — 注意 -- 分隔符）
oma ralph -- <task>
oma ultrawork -- <task>
oma search -- <read-only query>

oma autopilot start -- <goal>
oma autopilot status --session <id>
oma autopilot checkpoint --session <id> --expected-revision <n> --evidence <file>
oma autopilot resume --session <id> --conversation <id> --expected-revision <n>
  # 僅 ledger binding 更新（不 spawn）
oma autopilot drive --session <id> --conversation <id> --expected-revision <n>
  # ledger bind + 經 resumeConversation 的 managed agy spawn（需先前 exact_env bind）
oma autopilot cancel --session <id> --expected-revision <n> --reason <text>
oma autopilot doctor --session <id>
oma autopilot review|qa|reset-breaker …   # 見 oma --help

oma team start --manifest <file> [--worker-mode interactive|headless] [--max-parallel <n>]
  # Ready task（deps completed）至多 max-parallel；managed worktree + tmux + agy bootstrap。
oma team status --team <id>
oma team stop --team <id>
oma team supervise --team <id>
oma team reclaim --team <id> --task <id> --expected-revision <n> --pane dead --process dead
oma team deliver --team <id> --task <id> --expected-revision <n> --claim-token <tok> --generation <n> --worktree <path>
oma team tick --team <id> [--max-parallel <n>]
oma team api <op> --input '{"team_name":"<id>",…}' [--json]
  # P0 only（非完整 OMX）：send-message / mailbox-list / mailbox-mark-delivered /
  # create-task / list-tasks / claim-task / transition-task-status /
  # release-task-claim / get-summary / write-worker-inbox
oma team resolve-fork --team <id> --fork <id> --winner-generation <n> --expected-revision <n> --evidence <file>

oma workflow install [--source <repository-workflow-v1.json>]
oma workflow list|native-status
oma workflow run <name> --input <input.json> [--version <semver>] [--generation <n>]
oma workflow status|replay --run <run-id>
oma mcp-server
oma wiki index|list|search <query> [--limit <1..50>]
oma hud [--json] [--watch] [--preset minimal|focused|full] [--session <id> --workspace-key <key>]
oma native capabilities [--json]
oma native probe --live [--json]
oma native-status | lsp-status | sidecar-status
oma notify status|test …
oma resume --session <id> --conversation <id> --expected-revision <n>
oma recovery --source <transcript.jsonl> [--include-prompt]
oma update [--release] …
oma uninstall --receipt <receipt.json> [--project-state <.agy>] [--purge]
oma parity verify-composition --run-id <id> --aggregate <aggregate-handoff.json>
oma production verify [--run-id <id>]
oma production probe <seam> [--run-id <id>]
oma production capture <review|ultraqa> [--run-id <id>] -- <allowlisted-cli> …

oma setup
oma doctor [--json] [--no-strict-plugin] [--native]
oma <agy args...>   # pass-through（剝除 managed binding env）
```

Build 後二進位：`oma`、`omy` → `dist/bin/oma.js`。

`oma doctor` 檢查 Node ≥20、`dist` hooks、`package.json`/`plugin.json` 版本同步、`PATH` 上的 `agy`、state root，以及 plugin 已安裝並啟用（預設 fail-closed）。`oma doctor --native` 只增加被動、綁定 identity 的能力診斷，不會執行 live probe。

### Native 能力證據

`oma native capabilities` 輸出 native/fallback routing 使用的版本化 `HostCapabilityProfile`。它區分 `supported`、`unsupported`、`unknown`，記錄 evidence tier/source 與明確 fallback，並把 cache 綁定至精確的 `agy` 與已安裝 plugin identity。版本字串只是 metadata，不是 feature gate；timeout、parse error、過期證據或 identity drift 都保持 `unknown` 並 fail closed。

`oma native probe --live` 是明確 opt-in；v1 只執行一個有界公開 headless canary，其他具副作用 domain 都明確記錄為 unavailable/indeterminate。普通能力顯示與 `oma doctor --native` 都是被動路徑。離線 fixture、help、文件與通過的測試只證明 OMA 實作，**不證明 live host parity**。詳見 [Native capability negotiation](../native-capabilities.md)。

### 雙入口路徑（請讀）

| 呼叫 | 路徑 | Binding |
|------------|------|---------|
| `oma ralph -- "task"` | **Managed**（structured CLI） | 注入 `OMA_*` exact_env |
| `oma ralph task`（無 `--`） | **Legacy magic**（e2e / keyword intercept） | 無 exact_env；剝除環境 binding |
| `oma models list` / 其他 | **Pass-through** | 剝除 managed binding env |

生產 continuation 優先使用 **`--` managed 形式**。

---

## Hooks（權威表面）

僅 **PreInvocation** 與 **Stop**（package surface 無 PreToolUse/PostToolUse）。

| 事件 | 職責 |
|-------|-----|
| **PreInvocation** | exact_env bind（`OMA_SESSION_ID` + launch nonce + generation）→ SessionLocator |
| **Stop** | ProgressOracle continue/allow；durable `processedStops`；exact-env 重檢 |

Managed launch 注入：

- `OMA_SESSION_ID` / `OMA_LAUNCH_NONCE` / `OMA_INVOCATION_GENERATION`
- `OMA_STATE_ROOT` / `OMA_PACKAGE_ROOT` / `OMA_WORKSPACE_PATH`

Host workspace identity 優先 **`workspacePaths` / `OMA_WORKSPACE_PATH`** — hook cwd 是包含 `hooks.json` 的目錄（常為 `.agents/`），不是 repo root。

Live host Antigravity 1.1.4 對正常 idle stop 常傳送 `terminationReason: NO_TOOL_CALL`；oracle 將其與 `model_stop` 一併視為 eligible。

---

## 安全

- Circuit breaker 從不執行 `git reset --hard` / `git clean -fd`。
- Managed binding 需要 exact env；普通 pass-through 剝除 binding env。
- Launch nonce 是 capability 材料 — debug log 僅存 fingerprint，不存明文。
- Workflow worker 接收凍結 permission envelope；儲存庫寫入僅 proposal。
- MCP 暴露六個有界讀/proposal 操作，不是通用命令 runner。
- Transcript recovery 明確為部分，並保留 broken-chain / unknown-record 警告。
- Native workflow/team/LSP/private-sidecar 宣稱在缺少新鮮公開證據時仍為 T0。
- `oma production verify` 僅讀取規範 product-owned receipt，且每個 live seam 缺少新鮮、commit-bound 證據時會 fail closed。
- `oma production probe <seam>` 從實際 product/host 行為衍生 claim；`capture review|ultraqa` 僅執行 allowlisted independent CLI 並記錄有界 transcript。不信任呼叫方提供的 claim JSON 與 evidence path。
- 不要在沒有 intentional merge policy 的情況下修改 `AGENTS.md`。
- **Host launch／危險 launch gate：** 裸 `oma` 以安全預設啟動互動 `agy`（符合條件時走 tmux）。頂層 `--madmax` 視為明確同意（不必 TTY `yes`）；剝除 wrapper token 並注入 `--dangerously-skip-permissions`。單獨 `--yolo` 仍需 TTY 確認或 `--i-understand-dangerous-launch`。傳輸策略：`OMA_LAUNCH_POLICY`／`--direct`／`--tmux`。Managed 形式 `oma ralph --madmax -- task` **被拒絕**。Legacy magic 關鍵詞仍攔截。

---

## 疑難排解

OMA 的失敗模式幾乎都是刻意的 **fail-closed** 或 **靜默 fail-open**，所以錯誤訊息本身往往不會告訴你怎麼修。先跑 `oma doctor`。本發行版 **沒有** `oma hooks status` 這條診斷指令 — 不要把它當成可執行的排查命令。

| 症狀 | 診斷 | 修法 |
|------|------|------|
| hooks 沒有觸發 | `oma doctor`（plugin 已安裝且已啟用）。檢查 `DISABLE_OMA` / `OMA_SKIP_HOOKS`。在 `OMA_HOOK_DEBUG=1` 且已設 `OMA_STATE_ROOT` 時，查看 `<state-root>/logs/hook-debug.jsonl`。 | `oma setup`，然後 **重啟 host**。plugin install 只是一半的表面。取消 kill-switch 環境變數。可選專案級 `.agents/hooks.json`。 |
| `E_PLUGIN_NOT_ACTIVE`（已安裝但未啟用） | `oma doctor` / `oma doctor --json`，尋找 `plugin is installed but not enabled` 或 registry 缺失。 | `oma setup`。再用 `oma doctor` 確認。僅 slash 的 host 可用 `oma doctor --no-strict-plugin`（plugin 檢查降為 warn）。 |
| `oma setup` 後 slash skill 沒出現 | `oma skill list`；`oma doctor` 的 `slash_skills` 與 `slash_collision`。 | 重啟 host session。Claude/Grok 使用 `/oh-my-agy:autopilot`（OMC 可能占用裸 `/autopilot`）。重跑 `oma setup --host claude` 或 `--host grok`。 |
| Legacy magic（`oma ralph task`，無 `--`）只印模式橫幅然後沒輸出 | 非 TTY（CI）會忽略子程序 stdio，除非 `OMA_LEGACY_STDIO=inherit`。 | 優先用 managed `oma ralph -- "task"`。互動 TTY 預設 inherit；可用 `OMA_LEGACY_STDIO=inherit` 或 `ignore` 覆寫。 |

### 環境變數

只列出操作者會設的變數。Binding env（`OMA_SESSION_ID`、`OMA_LAUNCH_NONCE` 等）由 managed launch 注入，不要手設。

沒有 `OMA_STATE_DIR`；出貨名稱是 `OMA_STATE_ROOT`。

| 變數 | 預設值 | 作用 |
|------|--------|------|
| `DISABLE_OMA` | 未設定（關） | `1` 或 `true`（大小寫不敏感）關閉 **全部** Antigravity hook。被抑制的 PreInvocation/Stop 回傳 `allow`、空的 `injectSteps`、exit 0；不會解析 workspace，也不會建立 state root。 |
| `OMA_SKIP_HOOKS` | 未設定 | 逗號分隔的邏輯 hook 名：`pre-invocation`、`stop`、`session-start`、`post-invocation`（忽略空白與大小寫）。 |
| `OMA_HOOK_DEBUG` | 未設定（關） | `1` 或 `true` 把已脫敏診斷追加到 `<OMA_STATE_ROOT>/logs/hook-debug.jsonl`（上限 1 MiB）。預設關閉；絕不寫入安裝目錄。未設 `OMA_STATE_ROOT` 時不寫。 |
| `OMA_LEGACY_STDIO` | TTY 閘門 | Legacy magic spawn 的 stdio。未設定：TTY 上 `inherit`，否則 `ignore`。顯式 `inherit` 或 `ignore` 覆寫；未知值退回 TTY 閘門。 |
| `OMA_TIMEOUT_MS` | 依路徑 | 正的毫秒數。Managed headless（`oma ralph --` / `OMA_MANAGED_HEADLESS=1`）：預設 `3600000`。Autopilot `drive` 有界 spawn：預設 `30000`。Legacy 透傳：未設定則無逾時。 |
| `OMA_LAUNCH_POLICY` | `auto` | 裸 host-launch 傳輸：`auto`、`direct`、`tmux` 或 `detached-tmux`（後者對應 `tmux`）。CLI `--direct` / `--tmux` 覆寫（後者優先）。 |
| `OMA_STATE_ROOT` | 平台預設 | 持久 state root（session aggregate、hook debug log）。macOS：`~/Library/Application Support/oh-my-agy/state`。Windows：`%LOCALAPPDATA%/oh-my-agy/state`。其它：`${XDG_STATE_HOME:-~/.local/state}/oh-my-agy`。 |

---

## 測試 / CI / release

```bash
npm run build
npm run test:unit
npm run test:e2e
npm run test:package
npm run smoke
npm run test:production    # 無新鮮 live evidence 時故意失敗
```

| 表面 | 內容 |
|---------|------|
| **CI** | `.github/workflows/ci.yml` — Node 20/22 build + unit + pack smoke；e2e 用 mock `agy` |
| **Release 驗證** | `.github/workflows/release.yml` — 唯讀 build/test/package/readback；驗證 live production gate 無證據時 fail closed；**不**發佈 |
| **Install script** | `./scripts/install.sh` |
| **Release 流程** | [docs/RELEASE.zh-TW.md](../RELEASE.zh-TW.md) — candidate、live evidence、external publication、readback 邊界 |
| **Registry 策略** | [docs/npm-publishing.md](../npm-publishing.md) — 無已設定 registry channel |

Tag 範例：

```bash
# 僅在決定性檢查、live evidence、independent review 與 UltraQA 通過後。
# Tag 必須匹配 package.json / plugin.json / .claude-plugin version。
git tag -a v0.5.2 -m "v0.5.2"
git push origin v0.5.2
```

Changelog：**[CHANGELOG.md](../../CHANGELOG.md)**。  
在本儲存庫 workflow 中，打 tag 不會發佈 artifact。GitHub Release 建立/上傳與精確 readback 是獨立的特權操作。目前不宣稱 npm registry channel。

---

## 姊妹專案

| 專案 | Host | 別名 |
|---------|------|-------|
| [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | Claude Code | OMC |
| [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) | OpenAI Codex CLI | OMX |
| [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | OpenCode | OmO |
| [oh-my-grok](https://github.com/ImL1s/oh-my-grok) | Grok Build | OMG |
| **oh-my-agy**（本儲存庫） | Antigravity CLI | **OMA** |

同一家族理念：**更好的 host agent 工作流**，不是替代 agent。

---

## 貢獻與安全

- [Contributing](../../CONTRIBUTING.md) — 開發設定、本地 gate、基本規則。
- [Security policy](../../SECURITY.md) 與 [安全模型](../security.zh-TW.md) — 隔離邊界與私有漏洞回報。
- [Code of Conduct](../../CODE_OF_CONDUCT.md)。

## 語言

| 語言 | README |
| --- | --- |
| English | [README.md](../../README.md) |
| 简体中文 | [README.zh.md](./README.zh.md) |
| 繁體中文 | [README.zh-TW.md](./README.zh-TW.md) |

翻譯索引與維護規則：[docs/readme/README.md](./README.md)。

## 授權

[MIT](../../LICENSE) — 見儲存庫根目錄的 `LICENSE` 檔案。
