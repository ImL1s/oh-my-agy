# 發佈與安裝

English: [RELEASE.md](./RELEASE.md) · [简体中文](./RELEASE.zh.md) · [繁體中文](./RELEASE.zh-TW.md)
## 目前渠道策略

OMA `0.3.0` 將 GitHub Release tarball 加 `SHA256SUMS` 視為唯一可安裝的發佈渠道。本儲存庫**目前不**發佈到 npmjs.org 或 GitHub Packages。`@iml1s/oh-my-agy` 是 tarball 內的 package identity，不能證明 registry 條目存在。

`.github/workflows/release.yml` 刻意僅做驗證。它擁有唯讀權限，不能建立 tag、GitHub Release、asset 或 package。

## 安裝

原始碼 checkout 是始終可用的路徑：

```bash
git clone https://github.com/ImL1s/oh-my-agy.git
cd oh-my-agy
./scripts/install.sh
oma doctor --no-strict-plugin
```

GitHub Release 發佈後，使用獨立的已驗證 bootstrap：

```bash
curl -fsSLo /tmp/oma-install.sh \
  https://raw.githubusercontent.com/ImL1s/oh-my-agy/main/scripts/install.sh
bash /tmp/oma-install.sh --github --tag vX.Y.Z
```

離線安裝時，提供精確的 tarball 與 checksum manifest：

```bash
bash /tmp/oma-install.sh \
  --asset ./iml1s-oh-my-agy-X.Y.Z.tgz \
  --checksums ./SHA256SUMS
```

離線模式不執行網路、相依安裝或 build 步驟。

## 候選驗證

在乾淨的候選 commit 上執行：

```bash
npm ci
npm run build
npm run test:unit
npm run test:e2e
npm run test:package
npm run smoke
npm pack --dry-run
```

`npm run test:production` 是獨立的 live gate。它僅接受新鮮（24 小時內）、schema-v1、且綁定精確候選 Git OID 的證據，涵蓋：

- 已安裝 plugin discovery；
- managed PreInvocation/Stop lifecycle；
- exact conversation resume；
- interactive 與 headless worker cleanup/delivery；
- MCP visibility 與 public LSP status；
- workflow DAG、replay、skeptic、verifier 與 ship decision；
- independent code review 與 UltraQA。

證據僅由產品擁有的 probe/capture 命令產生：

```bash
# 省略 --run-id 時使用 OMA_PRODUCTION_RUN_ID，再使用精確候選 OID。
oma production probe plugin-discovery --run-id "$RUN_ID"
oma production probe managed-lifecycle --run-id "$RUN_ID"
oma production probe exact-resume --run-id "$RUN_ID"
oma production probe worker-runtime --run-id "$RUN_ID"
oma production probe mcp-lsp --run-id "$RUN_ID"
oma production probe workflow --run-id "$RUN_ID"

# 以下會執行實際的 allowlisted independent CLI。命令輸出必須
# 分別恰好包含 VERDICT: APPROVE 或 ULTRAQA: PASS。
oma production capture review --run-id "$RUN_ID" -- codex <review-args>
oma production capture ultraqa --run-id "$RUN_ID" -- claude <qa-args>
oma production verify --run-id "$RUN_ID"
```

Receipt、規範 artifact 與有界 transcript 寫入平台 state root 下的 `production-evidence/<run-id>/`。verifier 不接受呼叫方選擇的 evidence path 或 claim JSON。它驗證規範位元組、owner-only modes、hash、argv、精確候選 OID、新鮮度，以及不同的 review/UltraQA tool identity。缺失、過期、跳過或不匹配的證據回傳 `E_PRODUCTION_EVIDENCE` 並以非零退出。驗證為唯讀：缺失證據不會建立 state root 或 run 目錄。

## 發佈邊界

僅在決定性檢查、live evidence、independent review 與 UltraQA 全部通過後，特權 release operator 才可 push/read back 分支與 tag、建立 prerelease、上傳凍結的 tarball 與 `SHA256SUMS`、attest 位元組、promote，並驗證全新安裝。任何 timeout 都是 `unknown`，不是 success。凍結 bundle 後不要 rebuild。

`oma update --release` 啟動已驗證的不可變 package root。`oma uninstall --receipt <path>` 僅移除 receipt-owned inventory；`--purge` 還需要精確的 project-state path。
