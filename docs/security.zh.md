# 安全模型

English | [简体中文](./security.zh.md) | [繁體中文](./security.zh-TW.md)

## 权限边界

OMA 使用外部 per-user 状态根存放权威 aggregate，仓库本地的 `.agy/` 仅保留计划、workflow 定义/运行、recovery 副本与 proposal 产物。状态更新使用 revision/generation 检查；过期的 owner 不能静默覆盖较新的状态。

Managed launch 需要精确的 session ID、launch nonce 与 invocation generation。普通的 `agy` pass-through 会剥离这些变量。诊断中对 nonce 与目标地址做指纹化或脱敏。

## 进程与文件系统安全

- 外部命令使用 `spawn`/`spawnSync` 与 argv 数组，从不使用 shell `exec`。
- 危险的 `--madmax`/`--yolo` launch 需要显式确认。
- Circuit breaker 从不执行 `git reset --hard` 或 `git clean -fd`。
- Worktree/team 操作使用 lease、claim token、generation 与 delivery-scope 校验。
- 运行时文件限制在规范根目录之下；在契约要求不可变之处，拒绝 symlink 逃逸与可变替换。
- Install/update/uninstall 操作与 receipt 绑定且具备 ownership 感知。

## Workflow 与 MCP 权限

Repository workflow 将每个 stage 编译为冻结的 permission envelope。只读 stage 不获得写路径；产品写入仅限 proposal；没有已对账 receipt 的外部效应会变成 `effect_unknown`。禁止嵌套 supervisor 与 worker release authority。

MCP server 暴露固定 allowlist 的读操作加上不可变 proposal 创建。它不是命令执行代理。

## Recovery 与通知

`oma recovery` 读取不可变、有界后缀副本并如实报告部分 recovery。它保留 `W_BROKEN_CHAIN`、`W_UNKNOWN_RECORD_TYPE`、`W_PARTIAL_RECOVERY` 等警告；prompt 仅在 `--include-prompt` 时输出。

通知默认关闭。测试派发需要匹配的 owner ID、owner nonce 与 generation。HTTPS 目标有 host allowlist 并拒绝非公网目的地；status 输出从不打印 secret。

## 发布安全

CI 与 release 验证以只读 GitHub 权限运行。发布是独立的特权事务，需要精确的字节、tag、asset 与 readback 证明。`oma production verify` 会拒绝缺失、过期、跳过或 commit 错误的 live evidence。Parity CLI 路由仅用于验证；签名密钥与状态转换不会作为通用命令暴露。

请私下向仓库 owner 报告漏洞；不要在 issue 中包含 live 凭证、nonce 或私有 transcript 内容。
