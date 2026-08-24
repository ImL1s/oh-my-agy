# oh-my-agy (OMA / OMY)

English: [README.md](../../README.md) · [简体中文](./README.zh.md) · [繁體中文](./README.zh-TW.md)

<p align="center">
  <img src="../../assets/oma-character.png" alt="oh-my-agy character" width="300">
  <br>
  <em>先把 Antigravity 拉起来 — 再交给 OMA 管 managed modes、exact-env binding 与 continuation。</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node.js 20+">
  <img src="https://img.shields.io/badge/host-Antigravity%20CLI-black" alt="Antigravity CLI">
  <img src="https://img.shields.io/badge/hooks-PreInvocation%20%2B%20Stop-blue" alt="hooks">
</p>

**Google Antigravity CLI（`agy`）的编排层。**  
与 [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)（OMC）、[oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex)（OMX）、[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）、[oh-my-grok](https://github.com/ImL1s/oh-my-grok)（OMG）为同一类 *orchestration 想法*，执行面是 **Antigravity-native**。

_不必背每个 `agy` flag。优先用 **in-session slash skills**（agy 上 `/autopilot`，Claude/Grok 上 `/oh-my-agy:autopilot`）。需要时再使用可选 `oma` / `omy` CLI 绑定 managed modes 与 durable ledger。_

> **Session-first（主要）：** `oma setup` 后重启 host，在 session 内运行 slash skills。在 **Antigravity（`agy`）** 上 plugin skill 为裸 **`/autopilot`**。在 **Claude Code / Grok** 上用命名空间 **`/oh-my-agy:autopilot`**，以便 OMC 保留裸 `/autopilot`。  
> **CLI（次要）：** `oma ralph|ultrawork|search|autopilot|team` 用于 managed exact_env / durable FSM。Skill 正文仍是 loop 的 source of truth。

> **非官方。** 与 Google / Antigravity 无关联。Managed hooks 需要 `PATH` 上可用且已认证的 `agy`。

---

## 心智模型

OMA **不取代** Antigravity。

| 层 | 职责 |
|-------|-----|
| **`agy`** | Agent 工作（TUI、工具、对话） |
| **Plugin + hooks** | `PreInvocation` / `Stop` lifecycle 入口 |
| **`oma` CLI** | Managed modes、Autopilot FSM、Team、setup |
| **Session skills** | Plugin `skills/*` workflow（autopilot/ralph/ultrawork/…）— **in-session** 协议（OMC/OMX 风格） |
| **State root** | Session aggregate、binding、processedStops（仅 owner） |

| 组件 | 角色 |
|-----------|------|
| **Plugin** | `plugin.json` + `hooks.json`（仅 PreInvocation、Stop） |
| **Workspace hooks** | 可选 `.agents/hooks.json` 用于项目本地 host 加载 |
| **`oma` / `omy`** | 同一二进制 → managed launch / autopilot / team / pass-through |

---

## 快速开始

### 主要 UX（in-session slash）

安装后 **重启 host session** 并输入：

| Host | 规范 slash |
|------|-----------------|
| **Antigravity（`agy`）** | `/autopilot <goal>`（oh-my-agy plugin skill） |
| **Claude Code / Grok** | `/oh-my-agy:autopilot <goal>`（命名空间；与 OMC 裸 `/autopilot` 共存） |

```text
# agy session
/autopilot <your goal>

# Claude Code / Grok session
/oh-my-agy:autopilot <your goal>
```

还有：`ralph`、`ultrawork`、`team` 等（agy 上裸名；Claude/Grok 上 `/oh-my-agy:…`）。

### 一次性安装（clone）

```bash
git clone https://github.com/ImL1s/oh-my-agy.git
cd oh-my-agy
./scripts/install.sh
# build + PATH + oma setup（agy plugin + Claude/Grok slash surface）
oma doctor --no-strict-plugin
# 重启 host，然后：
#   agy:     /autopilot …
#   Claude/Grok: /oh-my-agy:autopilot …
```

### 可选：Antigravity managed CLI ledger

**要求：** Node **20+** · `PATH` 上有 `agy`（用于 managed modes / hooks）

```bash
npm ci && npm run build
ln -sf "$(pwd)/dist/bin/oma.js" ~/.local/bin/oma
oma setup                    # agy plugin + Claude/Grok slash surface
oma setup --host claude      # 仅 slash（agy 不硬失败）
oma setup --host agy         # 仅 agy plugin
oma setup --host all         # 同默认；agy 失败仍继续 slash 安装
oma autopilot start -- "…"   # durable SessionAggregate（可选）
```

可选项目本地 hooks（部分 host 更可靠地加载 `.agents/hooks.json`）：

```text
.agents/hooks.json → node "../dist/src/hooks/{pre-invocation,stop}.js"
```

Smoke：

```bash
oma --help
oma ralph -- "Reply with exactly one word: pong"
```

### 已验证 release 安装

Registry 发布**未配置**：不要从 npmjs.org 安装无关的未 scoped `oh-my-agy` package，也不要假设 `@iml1s/oh-my-agy` 存在于 registry。从 GitHub Release 安装，其中包含 package tarball 与 `SHA256SUMS`。

便捷一行（最新已验证 release 为 `v0.5.2`）：

```bash
curl -fsSL https://raw.githubusercontent.com/ImL1s/oh-my-agy/main/scripts/install.sh \
  | bash -s -- --github --tag v0.5.2
```

手动 / 可复现选项：

```bash
# 先下载 installer，再解析 pinned release。
curl -fsSLo /tmp/oma-install.sh \
  https://raw.githubusercontent.com/ImL1s/oh-my-agy/main/scripts/install.sh
bash /tmp/oma-install.sh --github --tag v0.5.2

# 完全离线：验证并安装精确文件，无网络/npm/build 步骤。
bash /tmp/oma-install.sh \
  --asset ./iml1s-oh-my-agy-0.5.2.tgz \
  --checksums ./SHA256SUMS
```

Release 字节在激活前经 checksum 验证。installer 写入 immutable receipt，供 ownership-aware 的 `oma update` 与 `oma uninstall` 使用。  
见 [发布与安装](../RELEASE.zh.md) 与 [registry 策略](../npm-publishing.md)。

---

## 推荐默认流程

任务非平凡时（**session-first**）：

```text
1. 安装一次：./scripts/install.sh   # 或：oma setup
2. 重启 agy / Claude Code / Grok
3. /autopilot <goal>   (agy)  或  /oh-my-agy:autopilot <goal>  (Claude/Grok)
4. 留在 session 内；产物写在 .agy/ 下
5. 可选 durable ledger（跨 session）：oma autopilot start|drive|…
```

**OMX 对齐的 Autopilot 阶段：** `deep-interview → ralplan → ultragoal → code-review → ultraqa`  
发现 skills：host slash 菜单，或 `oma skill list` / `oma skill show autopilot`。

| 若你需要… | 使用 |
|--------------|-----|
| 完整自主交付 | `/autopilot`（agy）或 `/oh-my-agy:autopilot`（Claude/Grok） |
| 持久单任务循环 | `/oh-my-agy:ralph` 或 `oma ralph -- "…"` |
| 并行 / 高吞吐 | `/oh-my-agy:ultrawork` 或 `oma ultrawork -- "…"` |
| 只读 plan 风格启动 | `oma search -- "…"` |
| Durable Autopilot FSM | `oma autopilot start / status / checkpoint / resume` |
| 多 agent 首个 worker（v1） | 先运行 `oma native probe --live`，再用 `oma team start --manifest … --worker-mode headless` |
| Team mailbox / claim API（P0） | `oma team api <op> --input JSON`（OMX 子集，非 33-op 全量） |
| Team fork 解析 | `oma team resolve-fork …` |
| 版本化仓库审查 | `oma workflow install`，然后 `oma workflow run …` |
| MCP 读/proposal 工具 | 配置 [`.mcp.json`](../../.mcp.json) 或运行 `oma mcp-server` |
| 状态概览 | `oma hud --json`（可选 `--watch`） |
| 文档索引 | `oma wiki index`，然后 `oma wiki search <query>` |
| 诚实的 host 能力视图 | `oma native capabilities`（被动）/ `oma native probe --live`（显式 opt-in） |
| 精确 continuation / 有界 recovery | `oma resume …` / `oma recovery …` |
| 普通 `agy` | `oma <agy args…>`（pass-through；剥离 managed binding env） |

**Hook 触发 ≠ 任务完成。** 首次 Stop 可能 `continue`；无进展 streak 后 trip；不要把 fail-open 的 `allow` 当作成功。

---

## 命令

```bash
oma --help
# Managed exact_env（推荐 — 注意 -- 分隔符）
oma ralph -- <task>
oma ultrawork -- <task>
oma search -- <read-only query>

oma autopilot start -- <goal>
oma autopilot status --session <id>
oma autopilot checkpoint --session <id> --expected-revision <n> --evidence <file>
oma autopilot resume --session <id> --conversation <id> --expected-revision <n>
  # 仅 ledger binding 更新（不 spawn）
oma autopilot drive --session <id> --conversation <id> --expected-revision <n>
  # ledger bind + 经 resumeConversation 的 managed agy spawn（需先前 exact_env bind）
oma autopilot cancel --session <id> --expected-revision <n> --reason <text>
oma autopilot doctor --session <id>
oma autopilot review|qa|reset-breaker …   # 见 oma --help

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
oma <agy args...>   # pass-through（剥离 managed binding env）
```

Build 后二进制：`oma`、`omy` → `dist/bin/oma.js`。

`oma doctor` 检查 Node ≥20、`dist` hooks、`package.json`/`plugin.json` 版本同步、`PATH` 上的 `agy`、state root，以及 plugin 已安装并启用（默认 fail-closed）。`oma doctor --native` 只增加被动、绑定 identity 的能力诊断，不会执行 live probe。

### Native 能力证据

`oma native capabilities` 输出 native/fallback routing 使用的版本化 `HostCapabilityProfile`。它区分 `supported`、`unsupported`、`unknown`，记录 evidence tier/source 和显式 fallback，并把 cache 绑定到精确的 `agy` 与已安装 plugin identity。版本字符串只是 metadata，不是 feature gate；timeout、parse error、过期证据或 identity drift 都保持 `unknown` 并 fail closed。

`oma native probe --live` 是显式 opt-in；v1 只执行一个有界公开 headless canary，其他带副作用 domain 都明确记录为 unavailable/indeterminate。普通能力显示与 `oma doctor --native` 都是被动路径。离线 fixture、help、文档和通过的测试只证明 OMA 实现，**不证明 live host parity**。详见 [Native capability negotiation](../native-capabilities.md)。

### 双入口路径（请读）

| 调用 | 路径 | Binding |
|------------|------|---------|
| `oma ralph -- "task"` | **Managed**（structured CLI） | 注入 `OMA_*` exact_env |
| `oma ralph task`（无 `--`） | **Legacy magic**（e2e / keyword intercept） | 无 exact_env；剥离环境 binding |
| `oma models list` / 其他 | **Pass-through** | 剥离 managed binding env |

生产 continuation 优先使用 **`--` managed 形式**。

---

## Hooks（权威表面）

仅 **PreInvocation** 与 **Stop**（package surface 无 PreToolUse/PostToolUse）。

| 事件 | 职责 |
|-------|-----|
| **PreInvocation** | exact_env bind（`OMA_SESSION_ID` + launch nonce + generation）→ SessionLocator |
| **Stop** | ProgressOracle continue/allow；durable `processedStops`；exact-env 重检 |

Managed launch 注入：

- `OMA_SESSION_ID` / `OMA_LAUNCH_NONCE` / `OMA_INVOCATION_GENERATION`
- `OMA_STATE_ROOT` / `OMA_PACKAGE_ROOT` / `OMA_WORKSPACE_PATH`

Host workspace identity 优先 **`workspacePaths` / `OMA_WORKSPACE_PATH`** — hook cwd 是包含 `hooks.json` 的目录（常为 `.agents/`），不是 repo root。

Live host Antigravity 1.1.4 对正常 idle stop 常发送 `terminationReason: NO_TOOL_CALL`；oracle 将其与 `model_stop` 一并视为 eligible。

---

## 安全

- Circuit breaker 从不执行 `git reset --hard` / `git clean -fd`。
- Managed binding 需要 exact env；普通 pass-through 剥离 binding env。
- Launch nonce 是 capability 材料 — debug log 仅存 fingerprint，不存明文。
- Workflow worker 接收冻结 permission envelope；仓库写入仅 proposal。
- MCP 暴露六个有界读/proposal 操作，不是通用命令 runner。
- Transcript recovery 明确为部分，并保留 broken-chain / unknown-record 警告。
- Native workflow/team/LSP/private-sidecar 宣称在缺少新鲜公开证据时仍为 T0。
- `oma production verify` 仅读取规范 product-owned receipt，且每个 live seam 缺少新鲜、commit-bound 证据时会 fail closed。
- `oma production probe <seam>` 从实际 product/host 行为派生 claim；`capture review|ultraqa` 仅执行 allowlisted independent CLI 并记录有界 transcript。不信任调用方提供的 claim JSON 与 evidence path。
- 不要在没有 intentional merge policy 的情况下修改 `AGENTS.md`。
- **Host launch／危险 launch gate：** 裸 `oma` 以安全默认启动互动 `agy`（符合条件时走 tmux）。顶层 `--madmax` 视为明确同意（不必 TTY `yes`）；剥离 wrapper token 并注入 `--dangerously-skip-permissions`。单独 `--yolo` 仍需 TTY 确认或 `--i-understand-dangerous-launch`。传输策略：`OMA_LAUNCH_POLICY`／`--direct`／`--tmux`。Managed 形式 `oma ralph --madmax -- task` **被拒绝**。Legacy magic 关键词仍拦截。

---

## 故障排除

OMA 的失败模式几乎都是刻意的 **fail-closed** 或 **静默 fail-open**，所以错误讯息本身往往不会告诉你怎么修。先跑 `oma doctor`。本发行版 **没有** `oma hooks status` 这条诊断指令 — 不要把它当成可执行的排查命令。

| 症状 | 诊断 | 修法 |
|------|------|------|
| hooks 没有触发 | `oma doctor`（plugin 已安装且已启用）。检查 `DISABLE_OMA` / `OMA_SKIP_HOOKS`。在 `OMA_HOOK_DEBUG=1` 且已设 `OMA_STATE_ROOT` 时，查看 `<state-root>/logs/hook-debug.jsonl`。 | `oma setup`，然后 **重启 host**。plugin install 只是一半的表面。取消 kill-switch 环境变量。可选项目级 `.agents/hooks.json`。 |
| `E_PLUGIN_NOT_ACTIVE`（已安装但未启用） | `oma doctor` / `oma doctor --json`，寻找 `plugin is installed but not enabled` 或 registry 缺失。 | `oma setup`。再用 `oma doctor` 确认。仅 slash 的 host 可用 `oma doctor --no-strict-plugin`（plugin 检查降为 warn）。 |
| `oma setup` 后 slash skill 没出现 | `oma skill list`；`oma doctor` 的 `slash_skills` 与 `slash_collision`。 | 重启 host session。Claude/Grok 使用 `/oh-my-agy:autopilot`（OMC 可能占用裸 `/autopilot`）。重跑 `oma setup --host claude` 或 `--host grok`。 |
| Legacy magic（`oma ralph task`，无 `--`）只印模式横幅然后没输出 | 非 TTY（CI）会忽略子进程 stdio，除非 `OMA_LEGACY_STDIO=inherit`。 | 优先用 managed `oma ralph -- "task"`。互动 TTY 默认 inherit；可用 `OMA_LEGACY_STDIO=inherit` 或 `ignore` 覆写。 |

### 环境变量

只列出操作者会设的变量。Binding env（`OMA_SESSION_ID`、`OMA_LAUNCH_NONCE` 等）由 managed launch 注入，不要手设。

没有 `OMA_STATE_DIR`；出货名称是 `OMA_STATE_ROOT`。

| 变量 | 默认值 | 作用 |
|------|--------|------|
| `DISABLE_OMA` | 未设置（关） | `1` 或 `true`（大小写不敏感）关闭 **全部** Antigravity hook。被抑制的 PreInvocation/Stop 回传 `allow`、空的 `injectSteps`、exit 0；不会解析 workspace，也不会创建 state root。 |
| `OMA_SKIP_HOOKS` | 未设置 | 逗号分隔的逻辑 hook 名：`pre-invocation`、`stop`、`session-start`、`post-invocation`（忽略空白与大小写）。 |
| `OMA_HOOK_DEBUG` | 未设置（关） | `1` 或 `true` 把已脱敏诊断追加到 `<OMA_STATE_ROOT>/logs/hook-debug.jsonl`（上限 1 MiB）。默认关闭；绝不写入安装目录。未设 `OMA_STATE_ROOT` 时不写。 |
| `OMA_LEGACY_STDIO` | TTY 闸门 | Legacy magic spawn 的 stdio。未设置：TTY 上 `inherit`，否则 `ignore`。显式 `inherit` 或 `ignore` 覆写；未知值退回 TTY 闸门。 |
| `OMA_TIMEOUT_MS` | 依路径 | 正的毫秒数。Managed headless（`oma ralph --` / `OMA_MANAGED_HEADLESS=1`）：默认 `3600000`。Autopilot `drive` 有界 spawn：默认 `30000`。Legacy 透传：未设置则无超时。 |
| `OMA_LAUNCH_POLICY` | `auto` | 裸 host-launch 传输：`auto`、`direct`、`tmux` 或 `detached-tmux`（后者映射为 `tmux`）。CLI `--direct` / `--tmux` 覆写（后者优先）。 |
| `OMA_STATE_ROOT` | 平台默认 | 持久 state root（session aggregate、hook debug log）。macOS：`~/Library/Application Support/oh-my-agy/state`。Windows：`%LOCALAPPDATA%/oh-my-agy/state`。其它：`${XDG_STATE_HOME:-~/.local/state}/oh-my-agy`。 |

---

## 测试 / CI / release

```bash
npm run build
npm run test:unit
npm run test:e2e
npm run test:package
npm run smoke
npm run test:production    # 无新鲜 live evidence 时故意失败
```

| 表面 | 内容 |
|---------|------|
| **CI** | `.github/workflows/ci.yml` — Node 20/22 build + unit + pack smoke；e2e 用 mock `agy` |
| **Release 验证** | `.github/workflows/release.yml` — 只读 build/test/package/readback；验证 live production gate 无证据时 fail closed；**不**发布 |
| **Install script** | `./scripts/install.sh` |
| **Release 流程** | [docs/RELEASE.zh.md](../RELEASE.zh.md) — candidate、live evidence、external publication、readback 边界 |
| **Registry 策略** | [docs/npm-publishing.md](../npm-publishing.md) — 无已配置 registry channel |

Tag 示例：

```bash
# 仅在确定性检查、live evidence、independent review 与 UltraQA 通过后。
# Tag 必须匹配 package.json / plugin.json / .claude-plugin version。
git tag -a v0.5.2 -m "v0.5.2"
git push origin v0.5.2
```

Changelog：**[CHANGELOG.md](../../CHANGELOG.md)**。  
在本仓库 workflow 中，打 tag 不会发布 artifact。GitHub Release 创建/上传与精确 readback 是独立的特权操作。目前不宣称 npm registry channel。

---

## 姊妹项目

| 项目 | Host | 别名 |
|---------|------|-------|
| [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | Claude Code | OMC |
| [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) | OpenAI Codex CLI | OMX |
| [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | OpenCode | OmO |
| [oh-my-grok](https://github.com/ImL1s/oh-my-grok) | Grok Build | OMG |
| **oh-my-agy**（本仓库） | Antigravity CLI | **OMA** |

同一家族理念：**更好的 host agent 工作流**，不是替代 agent。

---

## 贡献与安全

- [Contributing](../../CONTRIBUTING.md) — 开发设置、本地 gate、基本规则。
- [Security policy](../../SECURITY.md) 与 [安全模型](../security.zh.md) — 隔离边界与私有漏洞报告。
- [Code of Conduct](../../CODE_OF_CONDUCT.md)。

## 语言

| 语言 | README |
| --- | --- |
| English | [README.md](../../README.md) |
| 简体中文 | [README.zh.md](./README.zh.md) |
| 繁體中文 | [README.zh-TW.md](./README.zh-TW.md) |

翻译索引与维护规则：[docs/readme/README.md](./README.md)。

## 许可证

[MIT](../../LICENSE) — 见仓库根目录的 `LICENSE` 文件。
