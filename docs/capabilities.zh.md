# 能力矩阵

English: [capabilities.md](./capabilities.md) · [简体中文](./capabilities.zh.md) · [繁體中文](./capabilities.zh-TW.md)
OMA 将产品拥有的能力与对 Antigravity 的观测分开。Host 观测改用版本化 `HostCapabilityProfile` 与 `configured → installed → enabled → loadable → observed → healthy → verified` evidence tier。Repository workflow 的 `T0…T5` 是另一套产品契约，不能当作 native host 证据。

| Surface | OMA implementation | Native claim | Command |
|---|---|---|---|
| Managed modes | Exact-env launch、durable state、safe process runner | Product-owned | `oma ralph -- …` |
| Autopilot | 五阶段 FSM，含 CAS gate 与 evidence | Product-owned | `oma autopilot …` |
| Team | tmux/worktree workers、mailbox、fencing、delivery | Product-owned | `oma team …` |
| Repository workflows | 版本化 DAG、精确 verdict schema、精确 parent verification、authenticated receipts、captured-evidence replay、enforced ship gate | Product-owned T4；product-authenticated，非 host-signed | `oma workflow …` |
| Saved workflow prompt | `.agents/workflows/` 中的薄 CLI delegate | 仅 T1 projection | `oma workflow native-status` |
| Host capability negotiation | 绑定 identity 的 tri-state profile、policy ceiling、cache、route candidate/receipt | 产品拥有的 truth/routing 层；每个 native claim 独立评估 | `oma native capabilities` |
| Public Antigravity CLI/plugins | 被动 help/config/plugin readback | 不超过 source ceiling；不能只凭 version/help 达到 verified | `oma native capabilities --json` |
| 公开 hooks、custom agents、headless、sidecars、UI、conversation、project、permission、model/effort、MCP | 带显式 fallback 的规范 profile key | 在记录的 tier/source 上为 `supported`、`unsupported` 或 `unknown` | `oma native capabilities` / `oma native probe --live` |
| Native Team worker adapter | Issue #3 建立 profile-routed 边界，但尚未实现 adapter | bootstrap 前以 `E_NATIVE_ADAPTER_UNAVAILABLE` fail closed | `oma team …` |
| Headless/tmux Team fallback | 现有 OMA adapter 通过绑定 profile 的 routing receipt 选择；headless 直接使用已验证的文本 `--print` | 产品拥有的 fallback，不是 native Team adapter 证明 | `oma team …` |
| Host semantic LSP | 仅 compatibility status projection | 不是 native/fallback routing 权威 | `oma lsp-status` |
| Private memory sidecar/brain internals | 永不探测 | Forbidden | `oma sidecar-status` |
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
- 版本字符串只是 metadata 与 cache identity，不是 feature gate。
- Timeout、parse failure、矛盾/过期证据或 identity drift 都是 `unknown`，既不是 unsupported 也不是 success。
- Native probe policy 会实际限制墙钟时间、合并输出与进程树数量。进程树测量采用非阻塞方式并共享剩余 deadline；POSIX probe 会在 spawn 前绑定 PID/start-marker baseline，再跨 snapshot 保留由 parent-tree/process-group 关系证实的 lineage。已观测的 detached descendant 在 root 退出后仍会计数，无关、PID reuse 与 zombie 进程则不会误计；没有 parent-tree 或 process-group 证明的 PID-1 baseline-delta 进程不会被收编，因此高负载下的无关进程不会造成假性 processCountOverflow。进程数超限或无法测量时不能产生 verified 证据，timeout cleanup 另有有界 force-settle backstop。
- `supported: true` 只是 compatibility projection；routing 还必须满足 policy 最低 tier，并持有有效、绑定 identity 的 candidate/receipt。
- UI 标签与私有文件不是公开能力证据。
- 可选 adapter 保持 disabled 或 unclaimed，直到显式配置。
- `oma native capabilities` 与 `oma doctor --native` 是被动路径；只有 `oma native probe --live` 会 opt-in。v1 在 help 声明 JSON 时先执行 optional JSON canary，接着在 repository 外的 disposable empty workspace 验证 read-write `accept-edits` grammar，最后再以相同 production worker argv builder、read-only `plan --sandbox` 与 `--add-dir <current-repository>` 授权 route。两种 grammar 都必须通过；这不声明通用 filesystem-write 能力，其他带副作用 domain 仍明确保持 indeterminate。
- 离线 fixture 与测试只证明实现行为，不证明 live-host parity。详见 [Native capability negotiation](./native-capabilities.md)。
- `oma production verify` 是 `production_verified` 宣称的权威；普通单元测试仅建立实现证据。
- Workflow production evidence 仅由 `oma production probe workflow` 创建，并使用规范的 host、plugin、repository 与 repository-external state-root 解析。Host authority 绑定规范安装的 `agy` realpath、字节长度与 SHA-256——不仅依赖其报告的 version/help 输出。Package 消费者不能 import 内部 workflow authority 或 production-evidence 模块。产品执行仅作为 non-exported CLI closure 存在；每个发出的 workflow 模块都有精确 export allowlist，且不暴露 executor、dispatcher 或 authority factory。可 import 的 generic runner 永久为 advisory，且 dispatch 零个 task，即使 package 代码读取 receipt key 并重建旧的 structural marker。
