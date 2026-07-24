# 能力矩阵

English | [简体中文](./capabilities.zh.md) | [繁體中文](./capabilities.zh-TW.md)

OMA 将产品拥有的能力与对 Antigravity 的观测分开。`T0` 表示不可用或未观测；`T1` 表示观测到公开表面或 saved projection。两个层级都不暗示存在隐藏的原生 runtime。

| Surface | OMA implementation | Native claim | Command |
|---|---|---|---|
| Managed modes | Exact-env launch、durable state、safe process runner | Product-owned | `oma ralph -- …` |
| Autopilot | 五阶段 FSM，含 CAS gate 与 evidence | Product-owned | `oma autopilot …` |
| Team | tmux/worktree workers、mailbox、fencing、delivery | Product-owned | `oma team …` |
| Repository workflows | 版本化 DAG、精确 verdict schema、精确 parent verification、authenticated receipts、captured-evidence replay、enforced ship gate | Product-owned T4；product-authenticated，非 host-signed | `oma workflow …` |
| Saved workflow prompt | `.agents/workflows/` 中的薄 CLI delegate | 仅 T1 projection | `oma workflow native-status` |
| Public Antigravity CLI/plugins | 版本与公开 help 检查 | 观测到时为 T1 | `oma native-status` |
| Native team/workflow runtime | 无新鲜公开证明 | T0，unclaimed | `oma native-status` |
| Host semantic LSP | 仅 registration readback | 除非已配置并观测，否则 T0 | `oma lsp-status` |
| Private memory sidecar | 故意不探测 | T0，forbidden | `oma sidecar-status` |
| HUD | 脱敏 state/adapters projection | Product-owned | `oma hud --json` |
| Wiki | 确定性仓库 docs/provenance 索引 | Product-owned | `oma wiki …` |
| Notifications | Owner-fenced terminal/tmux/HTTPS adapters | Product-owned，opt-in | `oma notify …` |
| Resume/recovery | 精确 conversation resume 加上有界部分 recovery | Product-owned | `oma resume`、`oma recovery` |

## MCP surface

`.mcp.json` 启动 `oma mcp-server`。它恰好暴露六个操作：

- `run_status.read`
- `recovery_manifest.read`
- `wiki.search`
- `team_status.read`
- `mailbox.list`
- `proposal.create`

没有通用 shell、filesystem-write、publish 或读 secret 工具。`proposal.create` 仅向 `.agy/artifacts/` 写入不可变 proposal 产物；它不能修改权威状态。

## 真实性规则

- 已配置文件不等于 fresh-session discovery。
- UI 标签与私有文件不是公开能力证据。
- 可选 adapter 保持 disabled 或 unclaimed，直到显式配置。
- `oma production verify` 是 `production_verified` 宣称的权威；普通单元测试仅建立实现证据。
- Workflow production evidence 仅由 `oma production probe workflow` 创建，并使用规范的 host、plugin、repository 与 repository-external state-root 解析。Host authority 绑定规范安装的 `agy` realpath、字节长度与 SHA-256——不仅依赖其报告的 version/help 输出。Package 消费者不能 import 内部 workflow authority 或 production-evidence 模块。产品执行仅作为 non-exported CLI closure 存在；每个发出的 workflow 模块都有精确 export allowlist，且不暴露 executor、dispatcher 或 authority factory。可 import 的 generic runner 永久为 advisory，且 dispatch 零个 task，即使 package 代码读取 receipt key 并重建旧的 structural marker。
