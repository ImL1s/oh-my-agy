# 仓库 Workflow

English: [workflows.md](./workflows.md) · [简体中文](./workflows.zh.md) · [繁體中文](./workflows.zh-TW.md)
OMA workflow 将经过审查的多 agent 流程保存为版本化的 `repository-workflow/v1` 定义。该定义固定 DAG、有界 fan-out、role、capability mode、MCP allowlist、写范围、artifact 契约、retry budget、verification command 与 ship predicate。公开 CLI 提供 T4 产品拥有的 authority：OMA 启动每个 worker 与 verification 进程，用 repository-external trust root 认证 receipt，并自行计算 decision。这是 product-authenticated，而非 host-signed identity claim。

## 快速开始

将打包的 production safety review 安装到仓库 runtime state：

```bash
oma workflow install
oma workflow list
printf '{"candidate_commit":"%s"}\n' "$(git rev-parse HEAD)" > /tmp/oma-input.json
oma workflow run production-safety-review --input /tmp/oma-input.json
```

使用 `--source <definition.json>` 安装其他已验证定义。定义存放在 `.agy/workflows/`；run state 与不可变 journal 位于 `.agy/state/workflows/<run-id>/`。

通用 library adapter 以终端 `no_ship` 与 `E_WORKFLOW_PRODUCT_AUTHORITY_UNAVAILABLE` 退出。只有封闭的公开 CLI executor 能达到 `ship`。Worker JSON 必须匹配 stage 的精确 `{artifacts, verdict}` schema。verdict 可报告 `pass`、`approve`、`ship`、`reject`、`no_ship` 或 `failed`；负面 verdict 需要 findings，任何 `error` finding 都会阻止正面 decision。Worker 不能提供 approval、status、verification receipt、MAC 或 ship-proof 字段。

无需重新派发 worker 即可检查或 replay run：

```bash
oma workflow status --run <run-id>
oma workflow replay --run <run-id>
```

## Production safety review

打包定义描述四个并行只读审查：secrets、deployment gates、cron/R2 operations，以及 API/operations 文档。独立 skeptic 检查其 findings，独立 verifier 检查 candidate，然后只读 ship gate 才会以 authenticated product-owned receipts 决定 `ship` 或 `no_ship`。最大并行度为四，最大 agent 数量为七。

## 执行与失败语义

1. OMA 加载一个精确的 name/version/digest 并验证其 DAG。
2. 每个 task 接收冻结的 `oma_worker_envelope`；嵌套 supervisor 与未声明 path/tool 会被拒绝。
3. CLI parent 记录不同的 process/start identity，重读受限的 owner-only artifact 与 command transcript，然后用 repository-external trust root 认证绑定的 receipt。
4. Parent 仅在精确 stage schema 允许该值、不存在 error finding，且每个精确 verification argv 以零退出时，才接受正面 verdict。
5. Retry 受定义约束。未对账的外部效应变成 `effect_unknown` 并 fail closed。
6. Skeptic 与 verifier approval 仍是必要条件，但对 `ship` 不充分；还需要 authenticated product-owned authority。通用注入 adapter 永远不会获得该 authority。

当前打包 review 为只读。Worker 输出为严格 JSON；OMA 将声明的 artifact 持久化为 proposal 字节，而不是授予仓库写权限。Production evidence 捕获规范 definition、input、plan、journal、artifact 与 verification transcript。Aggregate verification 重读这些字节、重算 digest、replay journal，并再次执行 keyed review；删除或篡改会 fail closed。

`oma production probe workflow` 是唯一支持的 production-evidence 入口。它从活跃 `PATH` 解析字面量 `agy` 可执行文件，要求其 realpath 为规范 owner 安装的 `~/.local/bin/agy`，通过单一稳定文件描述符对可执行字节做 hash，验证支持的 1.1.6 公开契约与精确安装的 OMA plugin identity，从当前 repository 派生 candidate，并仅写入 repository-external platform state root。它拒绝 `OMA_STATE_ROOT`、plugin-config root override 与 `OMA_PRODUCTION_RUN_ID`；调用方不能注入可执行文件、adapter、candidate、package identity 或 evidence root。内部 runner export 不暴露 product executor 或 dispatcher，product authority 不暴露 adapter factory，executor 保持 non-exported CLI closure。Package 回归测试锁定每个发出的 workflow 模块的精确 allowlist，并阻止 package deep import。Production evidence 仅暴露由 process-private prepared-handle identity 支撑的 data preparation/recording 步骤；不接受 executor callback。可 import 的 generic runner 为 advisory，且始终执行零次 dispatch，因此磁盘 HMAC 保护 receipt integrity，但从不授予 in-process execution privilege。

## Live worker 契约（Antigravity 1.1.6）

每个 workflow task 是一个全新的 headless `agy` session。Launch grammar 已冻结并验证（`src/team/agy-argv.ts`）；以下细节为 load-bearing，且仅在真实 host 上显现，mock CLI 不会：

- **Model 固定**为当前 `agy models` id（`gemini-3.6-flash-high`）。agy 的环境默认可能被退役（例如缺失的默认 `gemini-2.5-pro` 会让每个 worker 以通用 *"Agent execution terminated due to error"* 失败，容易被误认为 quota 耗尽）。
- **仓库通过 `--add-dir` 挂载。** Headless agy 绑定自己的工作区，而非 process cwd，因此 worker 除非显式添加 repository root（并在 prompt 中命名），否则看不到 candidate commit。
- **Prompt 是 `--print` 的即时值。** 尾随 prompt 会让 agy 1.1.6 把后续 flag 吞进 prompt 文本。
- **Worker stdout 是最后一个平衡的顶层 JSON object。** Live session 会在最终答案前叙述进度，且从不输出 byte-canonical JSON，因此 parser 提取最后一个 object、拒绝重复 key，然后在 hash 前 canonical 重序列化。
- **Stage 预算 300s**（headless print 上限 5m）并携带 retry budget，因此单次 transient agy error 不会让整个 DAG 失败。每个 task 的 proposal root 在每次尝试前清理，使每次 dispatch 对崩溃或重复 run 的 stale proposal 具有幂等性。

fresh-session plugin-discovery canary 同样固定，并容忍 agy 1.1.6 的尾随双换行，canonical 化存储的 evidence 字节。

## Antigravity saved prompt

`.agents/workflows/production-safety-review.md` 刻意是委托给 CLI 的薄 saved prompt。它是 T1 source projection，不是重复或原生 workflow engine。用以下命令检查当前真相：

```bash
oma workflow native-status
```

Fresh native workflow/team discovery 仍为 unclaimed。强制 gate 是 OMA product authority，并不暗示原生 Antigravity workflow runtime。
