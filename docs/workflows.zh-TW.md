# 儲存庫 Workflow

English: [workflows.md](./workflows.md) · [简体中文](./workflows.zh.md) · [繁體中文](./workflows.zh-TW.md)
OMA workflow 將經過審查的多 agent 流程保存為版本化的 `repository-workflow/v1` 定義。該定義固定 DAG、有界 fan-out、role、capability mode、MCP allowlist、寫入範圍、artifact 契約、retry budget、verification command 與 ship predicate。公開 CLI 提供 T4 產品擁有的 authority：OMA 啟動每個 worker 與 verification 程序，用 repository-external trust root 認證 receipt，並自行計算 decision。這是 product-authenticated，而非 host-signed identity claim。

## 快速開始

將打包的 production safety review 安裝到儲存庫 runtime state：

```bash
oma workflow install
oma workflow list
printf '{"candidate_commit":"%s"}\n' "$(git rev-parse HEAD)" > /tmp/oma-input.json
oma workflow run production-safety-review --input /tmp/oma-input.json
```

使用 `--source <definition.json>` 安裝其他已驗證定義。定義存放在 `.agy/workflows/`；run state 與不可變 journal 位於 `.agy/state/workflows/<run-id>/`。

通用 library adapter 以終端 `no_ship` 與 `E_WORKFLOW_PRODUCT_AUTHORITY_UNAVAILABLE` 退出。只有封閉的公開 CLI executor 能達到 `ship`。Worker JSON 必須匹配 stage 的精確 `{artifacts, verdict}` schema。verdict 可回報 `pass`、`approve`、`ship`、`reject`、`no_ship` 或 `failed`；負面 verdict 需要 findings，任何 `error` finding 都會阻止正面 decision。Worker 不能提供 approval、status、verification receipt、MAC 或 ship-proof 欄位。

無需重新派送 worker 即可檢查或 replay run：

```bash
oma workflow status --run <run-id>
oma workflow replay --run <run-id>
```

## Production safety review

打包定義描述四個並行唯讀審查：secrets、deployment gates、cron/R2 operations，以及 API/operations 文件。獨立 skeptic 檢查其 findings，獨立 verifier 檢查 candidate，然後唯讀 ship gate 才會以 authenticated product-owned receipts 決定 `ship` 或 `no_ship`。最大並行度為四，最大 agent 數量為七。

## 執行與失敗語意

1. OMA 載入一個精確的 name/version/digest 並驗證其 DAG。
2. 每個 task 接收凍結的 `oma_worker_envelope`；巢狀 supervisor 與未宣告 path/tool 會被拒絕。
3. CLI parent 記錄不同的 process/start identity，重讀受限的 owner-only artifact 與 command transcript，然後用 repository-external trust root 認證綁定的 receipt。
4. Parent 僅在精確 stage schema 允許該值、不存在 error finding，且每個精確 verification argv 以零退出時，才接受正面 verdict。
5. Retry 受定義約束。未對帳的外部效應變成 `effect_unknown` 並 fail closed。
6. Skeptic 與 verifier approval 仍是必要條件，但對 `ship` 不充分；還需要 authenticated product-owned authority。通用注入 adapter 永遠不會獲得該 authority。

目前打包 review 為唯讀。Worker 輸出為嚴格 JSON；OMA 將宣告的 artifact 持久化為 proposal 位元組，而不是授予儲存庫寫入權限。Production evidence 擷取規範 definition、input、plan、journal、artifact 與 verification transcript。Aggregate verification 重讀這些位元組、重算 digest、replay journal，並再次執行 keyed review；刪除或竄改會 fail closed。

`oma production probe workflow` 是唯一支援的 production-evidence 入口。它從活躍 `PATH` 解析字面量 `agy` 可執行檔，要求其 realpath 為規範 owner 安裝的 `~/.local/bin/agy`，透過單一穩定檔案描述符對可執行位元組做 hash，驗證支援的 1.1.6 公開契約與精確安裝的 OMA plugin identity，從目前儲存庫衍生 candidate，並僅寫入 repository-external platform state root。它拒絕 `OMA_STATE_ROOT`、plugin-config root override 與 `OMA_PRODUCTION_RUN_ID`；呼叫方不能注入可執行檔、adapter、candidate、package identity 或 evidence root。內部 runner export 不暴露 product executor 或 dispatcher，product authority 不暴露 adapter factory，executor 保持 non-exported CLI closure。Package 迴歸測試鎖定每個發出的 workflow 模組的精確 allowlist，並阻止 package deep import。Production evidence 僅暴露由 process-private prepared-handle identity 支撐的 data preparation/recording 步驟；不接受 executor callback。可 import 的 generic runner 為 advisory，且始終執行零次 dispatch，因此磁碟 HMAC 保護 receipt integrity，但從不授予 in-process execution privilege。

## Live worker 契約（Antigravity 1.1.6）

每個 workflow task 是一個全新的 headless `agy` session。Launch grammar 已凍結並驗證（`src/team/agy-argv.ts`）；以下細節為 load-bearing，且僅在真實 host 上顯現，mock CLI 不會：

- **Model 固定**為目前 `agy models` id（`gemini-3.6-flash-high`）。agy 的環境預設可能被退役（例如缺失的預設 `gemini-2.5-pro` 會讓每個 worker 以通用 *"Agent execution terminated due to error"* 失敗，容易被誤認為 quota 耗盡）。
- **儲存庫透過 `--add-dir` 掛載。** Headless agy 綁定自己的工作區，而非 process cwd，因此 worker 除非明確加入 repository root（並在 prompt 中命名），否則看不到 candidate commit。
- **Prompt 是 `--print` 的即時值。** 尾隨 prompt 會讓 agy 1.1.6 把後續 flag 吞進 prompt 文字。
- **Worker stdout 是最後一個平衡的頂層 JSON object。** Live session 會在最終答案前敘述進度，且從不輸出 byte-canonical JSON，因此 parser 擷取最後一個 object、拒絕重複 key，然後在 hash 前 canonical 重序列化。
- **Stage 預算 300s**（headless print 上限 5m）並攜帶 retry budget，因此單次 transient agy error 不會讓整個 DAG 失敗。每個 task 的 proposal root 在每次嘗試前清理，使每次 dispatch 對當機或重複 run 的 stale proposal 具有冪等性。

fresh-session plugin-discovery canary 同樣固定，並容忍 agy 1.1.6 的尾隨雙換行，canonical 化儲存的 evidence 位元組。

## Antigravity saved prompt

`.agents/workflows/production-safety-review.md` 刻意是委派給 CLI 的薄 saved prompt。它是 T1 source projection，不是重複或原生 workflow engine。用以下命令檢查目前真相：

```bash
oma workflow native-status
```

Fresh native workflow/team discovery 仍為 unclaimed。強制 gate 是 OMA product authority，並不暗示原生 Antigravity workflow runtime。
