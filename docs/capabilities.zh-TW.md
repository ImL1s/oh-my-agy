# 能力矩陣

English: [capabilities.md](./capabilities.md) · [简体中文](./capabilities.zh.md) · [繁體中文](./capabilities.zh-TW.md)
OMA 將產品擁有的能力與對 Antigravity 的觀測分開。`T0` 表示不可用或未觀測；`T1` 表示觀測到公開表面或 saved projection。兩個層級都不暗示存在隱藏的原生 runtime。

| Surface | OMA implementation | Native claim | Command |
|---|---|---|---|
| Managed modes | Exact-env launch、durable state、safe process runner | Product-owned | `oma ralph -- …` |
| Autopilot | 五階段 FSM，含 CAS gate 與 evidence | Product-owned | `oma autopilot …` |
| Team | tmux/worktree workers、mailbox、fencing、delivery | Product-owned | `oma team …` |
| Repository workflows | 版本化 DAG、精確 verdict schema、精確 parent verification、authenticated receipts、captured-evidence replay、enforced ship gate | Product-owned T4；product-authenticated，非 host-signed | `oma workflow …` |
| Saved workflow prompt | `.agents/workflows/` 中的薄 CLI delegate | 僅 T1 projection | `oma workflow native-status` |
| Public Antigravity CLI/plugins | 版本與公開 help 檢查 | 觀測到時為 T1 | `oma native-status` |
| Native team/workflow runtime | 無新鮮公開證明 | T0，unclaimed | `oma native-status` |
| Host semantic LSP | 僅 registration readback | 除非已設定並觀測，否則 T0 | `oma lsp-status` |
| Private memory sidecar | 故意不探測 | T0，forbidden | `oma sidecar-status` |
| HUD | 脫敏 state/adapters projection | Product-owned | `oma hud --json` |
| Wiki | 決定性儲存庫 docs/provenance 索引 | Product-owned | `oma wiki …` |
| Notifications | Owner-fenced terminal/tmux/HTTPS adapters | Product-owned，opt-in | `oma notify …` |
| Resume/recovery | 精確 conversation resume 加上有界部分 recovery | Product-owned | `oma resume`、`oma recovery` |

## MCP surface

`.mcp.json` 啟動 `oma mcp-server`。它恰好暴露六個操作：

- `run_status.read`
- `recovery_manifest.read`
- `wiki.search`
- `team_status.read`
- `mailbox.list`
- `proposal.create`

沒有通用 shell、filesystem-write、publish 或讀 secret 工具。`proposal.create` 僅向 `.agy/artifacts/` 寫入不可變 proposal 產物；它不能修改權威狀態。

## 真實性規則

- 已設定檔案不等於 fresh-session discovery。
- UI 標籤與私有檔案不是公開能力證據。
- 可選 adapter 保持 disabled 或 unclaimed，直到明確設定。
- `oma production verify` 是 `production_verified` 宣稱的權威；普通單元測試僅建立實作證據。
- Workflow production evidence 僅由 `oma production probe workflow` 建立，並使用規範的 host、plugin、repository 與 repository-external state-root 解析。Host authority 綁定規範安裝的 `agy` realpath、位元組長度與 SHA-256——不僅依賴其回報的 version/help 輸出。Package 消費者不能 import 內部 workflow authority 或 production-evidence 模組。產品執行僅作為 non-exported CLI closure 存在；每個發出的 workflow 模組都有精確 export allowlist，且不暴露 executor、dispatcher 或 authority factory。可 import 的 generic runner 永久為 advisory，且 dispatch 零個 task，即使 package 程式碼讀取 receipt key 並重建舊的 structural marker。
