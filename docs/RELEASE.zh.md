# 发布与安装

English: [RELEASE.md](./RELEASE.md) · [简体中文](./RELEASE.zh.md) · [繁體中文](./RELEASE.zh-TW.md)
## 当前渠道策略

OMA `0.5.1` 将 GitHub Release tarball 加 `SHA256SUMS` 视为唯一可安装的发布渠道。本仓库**目前不**发布到 npmjs.org 或 GitHub Packages。`@iml1s/oh-my-agy` 是 tarball 内的 package identity，不能证明 registry 条目存在。

`.github/workflows/release.yml` 刻意仅做验证。它拥有只读权限，不能创建 tag、GitHub Release、asset 或 package。

`v0.5.0` 已由 `v0.5.1` 取代：该 archive 保留了生成后 CLI 的不可执行权限，导致安装后的 `oma`/`omy` symlink 无法直接执行。请使用 `v0.5.1` 或更新版本。

## 安装

源码 checkout 是始终可用的路径：

```bash
git clone https://github.com/ImL1s/oh-my-agy.git
cd oh-my-agy
./scripts/install.sh
oma doctor --no-strict-plugin
```

GitHub Release 发布后，使用独立的已验证 bootstrap：

```bash
curl -fsSLo /tmp/oma-install.sh \
  https://raw.githubusercontent.com/ImL1s/oh-my-agy/main/scripts/install.sh
bash /tmp/oma-install.sh --github --tag vX.Y.Z
```

离线安装时，提供精确的 tarball 与 checksum manifest：

```bash
bash /tmp/oma-install.sh \
  --asset ./iml1s-oh-my-agy-X.Y.Z.tgz \
  --checksums ./SHA256SUMS
```

离线模式不执行网络、依赖安装或 build 步骤。

## 候选验证

在干净的候选 commit 上运行：

```bash
npm ci
npm run build
npm run test:unit
npm run test:e2e
npm run test:package
npm run smoke
npm pack --dry-run
```

确定性 gate 要求构建后的 CLI 可执行；全新 HOME 的 release installer 测试会直接执行 `oma --version` 与 `omy --version`。如果 archive 丢失 execute bit，install preflight 会在任何 host 变更前拒绝它。

`npm run test:production` 是独立的 live gate。它仅接受新鲜（24 小时内）、schema-v1、且绑定精确候选 Git OID 的证据，涵盖：

- 已安装 plugin discovery；
- managed PreInvocation/Stop lifecycle；
- exact conversation resume；
- interactive 与 headless worker cleanup/delivery；
- MCP visibility 与 public LSP status；
- workflow DAG、replay、skeptic、verifier 与 ship decision；
- independent code review 与 UltraQA。

证据仅由产品拥有的 probe/capture 命令产生：

```bash
# 省略 --run-id 时使用 OMA_PRODUCTION_RUN_ID，再使用精确候选 OID。
oma production probe plugin-discovery --run-id "$RUN_ID"
oma production probe managed-lifecycle --run-id "$RUN_ID"
oma production probe exact-resume --run-id "$RUN_ID"
oma production probe worker-runtime --run-id "$RUN_ID"
oma production probe mcp-lsp --run-id "$RUN_ID"
oma production probe workflow --run-id "$RUN_ID"

# 以下会执行实际的 allowlisted independent CLI。命令输出必须
# 分别恰好包含 VERDICT: APPROVE 或 ULTRAQA: PASS。
oma production capture review --run-id "$RUN_ID" -- codex <review-args>
oma production capture ultraqa --run-id "$RUN_ID" -- claude <qa-args>
oma production verify --run-id "$RUN_ID"
```

Receipt、规范 artifact 与有界 transcript 写入平台 state root 下的 `production-evidence/<run-id>/`。verifier 不接受调用方选择的 evidence path 或 claim JSON。它验证规范字节、owner-only modes、hash、argv、精确候选 OID、新鲜度，以及不同的 review/UltraQA tool identity。缺失、过期、跳过或不匹配的证据返回 `E_PRODUCTION_EVIDENCE` 并以非零退出。验证为只读：缺失证据不会创建 state root 或 run 目录。

## 发布边界

仅在确定性检查、live evidence、independent review 与 UltraQA 全部通过后，特权 release operator 才可 push/read back 分支与 tag、创建 prerelease、上传冻结的 tarball 与 `SHA256SUMS`、attest 字节、promote，并验证全新安装。任何 timeout 都是 `unknown`，不是 success。冻结 bundle 后不要 rebuild。

`oma update --release` 激活已验证的不可变 package root。`oma uninstall --receipt <path>` 仅移除 receipt-owned inventory；`--purge` 还需要精确的 project-state path。
