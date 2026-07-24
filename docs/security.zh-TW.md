# 安全模型

English | [简体中文](./security.zh.md) | [繁體中文](./security.zh-TW.md)

## 權限邊界

OMA 使用外部 per-user 狀態根存放權威 aggregate，儲存庫本地的 `.agy/` 僅保留計畫、workflow 定義/執行、recovery 副本與 proposal 產物。狀態更新使用 revision/generation 檢查；過期的 owner 不能靜默覆寫較新的狀態。

Managed launch 需要精確的 session ID、launch nonce 與 invocation generation。一般的 `agy` pass-through 會剝除這些變數。診斷中對 nonce 與目標位址做指紋化或脫敏。

## 程序與檔案系統安全

- 外部命令使用 `spawn`/`spawnSync` 與 argv 陣列，從不使用 shell `exec`。
- 危險的 `--madmax`/`--yolo` launch 需要明確確認。
- Circuit breaker 從不執行 `git reset --hard` 或 `git clean -fd`。
- Worktree/team 操作使用 lease、claim token、generation 與 delivery-scope 驗證。
- 執行時檔案限制在規範根目錄之下；在契約要求不可變之處，拒絕 symlink 逃逸與可變替換。
- Install/update/uninstall 操作與 receipt 綁定且具備 ownership 感知。

## Workflow 與 MCP 權限

Repository workflow 將每個 stage 編譯為凍結的 permission envelope。唯讀 stage 不獲得寫路徑；產品寫入僅限 proposal；沒有已對帳 receipt 的外部效應會變成 `effect_unknown`。禁止巢狀 supervisor 與 worker release authority。

MCP server 暴露固定 allowlist 的讀操作加上不可變 proposal 建立。它不是命令執行代理。

## Recovery 與通知

`oma recovery` 讀取不可變、有界後綴副本並如實報告部分 recovery。它保留 `W_BROKEN_CHAIN`、`W_UNKNOWN_RECORD_TYPE`、`W_PARTIAL_RECOVERY` 等警告；prompt 僅在 `--include-prompt` 時輸出。

通知預設關閉。測試派送需要相符的 owner ID、owner nonce 與 generation。HTTPS 目標有 host allowlist 並拒絕非公網目的地；status 輸出從不列印 secret。

## 發佈安全

CI 與 release 驗證以唯讀 GitHub 權限執行。發佈是獨立的特權交易，需要精確的位元組、tag、asset 與 readback 證明。`oma production verify` 會拒絕缺失、過期、跳過或 commit 錯誤的 live evidence。Parity CLI 路由僅用於驗證；簽章金鑰與狀態轉換不會作為通用命令暴露。

請私下向儲存庫 owner 回報漏洞；不要在 issue 中包含 live 憑證、nonce 或私有 transcript 內容。
