# 能力矩陣

English: [capabilities.md](./capabilities.md) · [简体中文](./capabilities.zh.md) · [繁體中文](./capabilities.zh-TW.md)
OMA 將產品擁有的能力與對 Antigravity 的觀測分開。Host 觀測改用版本化 `HostCapabilityProfile` 與 `configured → installed → enabled → loadable → observed → healthy → verified` evidence tier。Repository workflow 的 `T0…T5` 是另一套產品契約，不能當作 native host 證據。

| Surface | OMA implementation | Native claim | Command |
|---|---|---|---|
| Managed modes | Exact-env launch、durable state、safe process runner | Product-owned | `oma ralph -- …` |
| Autopilot | 五階段 FSM，含 CAS gate 與 evidence | Product-owned | `oma autopilot …` |
| Team | tmux/worktree workers、mailbox、fencing、delivery | Product-owned | `oma team …` |
| Repository workflows | 版本化 DAG、精確 verdict schema、精確 parent verification、authenticated receipts、captured-evidence replay、enforced ship gate | Product-owned T4；product-authenticated，非 host-signed | `oma workflow …` |
| Saved workflow prompt | `.agents/workflows/` 中的薄 CLI delegate | 僅 T1 projection | `oma workflow native-status` |
| Host capability negotiation | 綁定 identity 的 tri-state profile、policy ceiling、cache、route candidate/receipt | 產品擁有的 truth/routing 層；每個 native claim 獨立評估 | `oma native capabilities` |
| Public Antigravity CLI/plugins | 被動 help/config/plugin readback | 不超過 source ceiling；不能只憑 version/help 達到 verified | `oma native capabilities --json` |
| 公開 hooks、custom agents、headless、sidecars、UI、conversation、project、permission、model/effort、MCP | 帶明確 fallback 的規範 profile key | 在記錄的 tier/source 上為 `supported`、`unsupported` 或 `unknown` | `oma native capabilities` / `oma native probe --live` |
| Native Team worker adapter | Issue #3 建立 profile-routed 邊界，但尚未實作 adapter | bootstrap 前以 `E_NATIVE_ADAPTER_UNAVAILABLE` fail closed | `oma team …` |
| Headless/tmux Team fallback | 現有 OMA adapter 透過綁定 profile 的 routing receipt 選擇；headless 直接使用已驗證的文字 `--print` | 產品擁有的 fallback，不是 native Team adapter 證明 | `oma team …` |
| Host semantic LSP | 僅 compatibility status projection | 不是 native/fallback routing 權威 | `oma lsp-status` |
| Private memory sidecar/brain internals | 永不探測 | Forbidden | `oma sidecar-status` |
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
- 版本字串只是 metadata 與 cache identity，不是 feature gate。
- Timeout、parse failure、矛盾/過期證據或 identity drift 都是 `unknown`，既不是 unsupported 也不是 success。
- Native probe policy 會實際限制牆鐘時間、合併輸出與程序樹數量。程序樹量測採非阻塞且共用剩餘 deadline；程序數超限或無法量測時不能產生 verified 證據，timeout cleanup 另有有界 force-settle backstop。
- `supported: true` 只是 compatibility projection；routing 還必須滿足 policy 最低 tier，並持有有效、綁定 identity 的 candidate/receipt。
- UI 標籤與私有檔案不是公開能力證據。
- 可選 adapter 保持 disabled 或 unclaimed，直到明確設定。
- `oma native capabilities` 與 `oma doctor --native` 是被動路徑；只有 `oma native probe --live` 會 opt-in。v1 只執行一個有界公開 headless canary，其他具副作用 domain 都明確維持 indeterminate。
- 離線 fixture 與測試只證明實作行為，不證明 live-host parity。詳見 [Native capability negotiation](./native-capabilities.md)。
- `oma production verify` 是 `production_verified` 宣稱的權威；普通單元測試僅建立實作證據。
- Workflow production evidence 僅由 `oma production probe workflow` 建立，並使用規範的 host、plugin、repository 與 repository-external state-root 解析。Host authority 綁定規範安裝的 `agy` realpath、位元組長度與 SHA-256——不僅依賴其回報的 version/help 輸出。Package 消費者不能 import 內部 workflow authority 或 production-evidence 模組。產品執行僅作為 non-exported CLI closure 存在；每個發出的 workflow 模組都有精確 export allowlist，且不暴露 executor、dispatcher 或 authority factory。可 import 的 generic runner 永久為 advisory，且 dispatch 零個 task，即使 package 程式碼讀取 receipt key 並重建舊的 structural marker。
