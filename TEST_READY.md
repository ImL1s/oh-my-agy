# oh-my-agy E2E 測試套件已就緒 (TEST_READY.md)

本專案的端到端（E2E）測試套件已完全準備就緒，並且可以在未來專案編譯或實作完成後一鍵執行。所有測試程式碼與文件完全使用繁體中文撰寫。

---

## 一、 測試執行方式 (Test Runner Command)

請在專案根目錄下執行以下指令以執行完整的 E2E 測試套件：

```bash
# 安裝依賴 (首次執行)
npm install

# 執行所有 E2E 測試
npm run test:e2e
```

**預期結果**：在主程式功能（`bin/oma.ts`、`src/enforcer.ts` 等）開發完成後，所有 63 個測試案例均應通過，並以 Exit Code 0 結束。

---

## 二、 測試覆蓋統計 (Coverage Summary)

| 測試分類 (Tier) | 測試案例數量 | 描述 |
| :--- | :---: | :--- |
| **Tier 1: Feature Coverage** | 25 | 覆蓋 5 大核心功能的基礎 Happy Path 流程、關鍵字攔截與指令透傳。 |
| **Tier 2: Boundary & Corner** | 25 | 覆蓋空檔案、無效 JSON、極長引數、中斷信號 (SIGINT) 以及 1000 個 tasks 性能邊界等極端情況。 |
| **Tier 3: Cross-Feature** | 8 | 覆蓋交叉組合場景，如關鍵字攔截與熔斷狀態共存，並補齊了Looks/Works租約搶占、Git Worktree與熔斷回滾等測試。 |
| **Tier 4: Real-World Scenarios** | 5 | 模擬完整的 Sisyphus 喚醒推進直到完成、3次失敗熔斷，以及Enforcer倒數時遭受中斷的真實生命週期。 |
| **總計 (Total)** | **63** | **符合最低測試案例門檻（最低 49 個，本套件共 63 個）** |

---

## 三、 功能測試覆蓋清單 (Feature Checklist)

本測試套件覆蓋的 5 大核心功能與 3 個設計機制查核表如下：

| 功能與設計機制 (Feature / Design Module) | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
| :--- | :---: | :---: | :---: | :---: |
| **功能一：指令透傳與 I/O 管道** | 5 案例 | 5 案例 | ✓ | ✓ |
| **功能二：魔術關鍵字攔截與模式切換** | 5 案例 | 5 案例 | ✓ | ✓ |
| **功能三：薛西弗斯待辦任務持續喚醒 (Enforcer)** | 5 案例 | 5 案例 | ✓ | ✓ |
| **功能四：死鎖熔斷器與重試控制 (Circuit Breaker)** | 5 案例 | 5 案例 | ✓ | ✓ |
| **功能五：Todo 檔案解析與異常安全防禦** | 5 案例 | 5 案例 | ✓ | ✓ |
| **機制六：Looks vs Works Saga 併發排它租約** | - | - | TC-T3-06 | - |
| **機制七：工作區管理 (Git Worktree) 與 Blocker** | - | - | TC-T3-07 | - |
| **機制八：熔斷觸發時 Git 自動回滾** | - | - | TC-T3-08 | - |

---

## 四、 測試案例詳細對照表 (Test Cases Checklist)

### Tier 1: Feature Coverage (TC-T1-01 ~ TC-T1-25)
- [ ] **TC-T1-01**: 基本指令透傳驗證 (透傳 help)
- [ ] **TC-T1-02**: 帶有選項與參數的指令透傳 (透傳 write)
- [ ] **TC-T1-03**: 標準輸入 (stdin) 透傳管道
- [ ] **TC-T1-04**: 透傳指令失敗狀態傳播 (錯誤碼傳播)
- [ ] **TC-T1-05**: 大量輸出之 Buffer 透傳 (1MB數據)
- [ ] **TC-T1-06**: Ralph 關鍵字攔截與 System Instruction 注入
- [ ] **TC-T1-07**: Ultrawork 關鍵字攔截與 System Instruction 注入
- [ ] **TC-T1-08**: Search 關鍵字攔截與 System Instruction 注入
- [ ] **TC-T1-09**: 縮寫關鍵字攔截 (ulw/uw)
- [ ] **TC-T1-10**: 關鍵字剝離與原始 Prompt 傳遞
- [ ] **TC-T1-11**: 單一未完成任務之黃色警告倒數與喚醒流程
- [ ] **TC-T1-12**: 所有任務皆已完成之正常結束 (不喚醒)
- [ ] **TC-T1-13**: 部分完成與未完成任務混合之喚醒
- [ ] **TC-T1-14**: 倒數警告輸出格式高亮與排版驗證
- [ ] **TC-T1-15**: tasks 欄位不存在之正常結束
- [ ] **TC-T1-16**: 連續失敗時 remainingRetries 遞減
- [ ] **TC-T1-17**: 任務狀態有推進時 remainingRetries 重置為 3
- [ ] **TC-T1-18**: 失敗次數達 3 次觸發 tripped 熔斷與阻斷
- [ ] **TC-T1-19**: 熔斷後第二次執行直接防禦攔截 (Exit Code 1)
- [ ] **TC-T1-20**: 自動重置熔斷器 (remainingRetries 重回 3)
- [ ] **TC-T1-21**: 正常的 todo.json 檔案讀取與解析
- [ ] **TC-T1-22**: Enforcer 寫入 todo.json 狀態同步 (continuing)
- [ ] **TC-T1-23**: 熔斷狀態自動同步寫入 todo.json (tripped)
- [ ] **TC-T1-24**: todo.json 檔案不存在時預設結構初始化
- [ ] **TC-T1-25**: 空物件 `{}` 的容錯與安全防禦

### Tier 2: Boundary & Corner Cases (TC-T2-01 ~ TC-T2-25)
- [ ] **TC-T2-01**: 0 位元組空 todo.json 解析防禦與安全退回
- [ ] **TC-T2-02**: JSON 語法損壞 (Malformed JSON) 異常安全防禦
- [ ] **TC-T2-03**: todo.json 無讀寫權限 (Permission Denied) 安全防禦
- [ ] **TC-T2-04**: todo.json 被建立為目錄之衝突安全退回
- [ ] **TC-T2-05**: tasks 屬性型別錯誤 (非 Array) 安全防禦
- [ ] **TC-T2-06**: remainingRetries 臨界邊界值 0 次驗證
- [ ] **TC-T2-07**: remainingRetries 超過上限 (如 10 次) 限制與重置
- [ ] **TC-T2-08**: tripped 狀態下外部直接呼叫之阻斷與錯誤狀態碼
- [ ] **TC-T2-09**: remainingRetries 在臨界邊界 1 次與 2 次時之變更
- [ ] **TC-T2-10**: 任務推進與失敗交錯發生時 remainingRetries 之重置界線
- [ ] **TC-T2-11**: Markdown 程式碼區塊內包含 magic keywords 防誤觸過濾
- [ ] **TC-T2-12**: 行內程式碼 (Inline Code) 包含關鍵字防誤觸過濾
- [ ] **TC-T2-13**: 諮詢性語境 (如 "what is ralph") 防誤觸過濾
- [ ] **TC-T2-14**: 單字黏連 (如 "ralphdeploy") 防誤觸過濾
- [ ] **TC-T2-15**: 多個關鍵字共存時優先級判定 (如 uw 與 search 共存)
- [ ] **TC-T2-16**: CLI 傳入空格或空引數之安全透傳
- [ ] **TC-T2-17**: 傳入超過 10 萬字元之極長選項透傳
- [ ] **TC-T2-18**: Shell 特殊字元 (`;`, `|`, `&`) 之安全防注防禦
- [ ] **TC-T2-19**: 程序睡眠期間接收外部中斷信號 (SIGINT) 傳播
- [ ] **TC-T2-20**: 執行超時 (Timeout) 程序熔斷中斷防禦
- [ ] **TC-T2-21**: tasks 欄位為空陣列 `[]` 時之不喚醒正常退出
- [ ] **TC-T2-22**: todo.json 缺少 `remainingRetries` 欄位 fallback 預設值 3
- [ ] **TC-T2-23**: todo.json 的 status 屬性為未知狀態時之安全回退
- [ ] **TC-T2-24**: 1000 個 tasks 巨量資料解析效能邊界驗證
- [ ] **TC-T2-25**: 併發多程序檔案讀寫競爭鎖定與防禦

### Tier 3: Cross-Feature Combinations (TC-T3-01 ~ TC-T3-08)
- [ ] **TC-T3-01**: 關鍵字觸發同時面臨熔斷狀態 (熔斷優先攔截)
- [ ] **TC-T3-02**: 關鍵字攔截下執行中 todo.json 動態建立觸發喚醒
- [ ] **TC-T3-03**: 透傳命令失敗與 todo.json 臨界失敗熔斷疊加
- [ ] **TC-T3-04**: 關鍵字攔截下 todo.json 格式損壞之安全退回
- [ ] **TC-T3-05**: 多關鍵字共存與 todo.json 熔斷狀態自動解鎖重置
- [ ] **TC-T3-06**: Looks vs Works Saga 併發排它租約與衝突搶占防禦
- [ ] **TC-T3-07**: 工作區管理 (Git Worktree) 物理建立與 Blocker 清理防禦
- [ ] **TC-T3-08**: Enforcer 連續 3 次失敗觸發熔斷時 Git 自動回滾

### Tier 4: Real-World Application Scenarios (TC-T4-01 ~ TC-T4-05)
- [ ] **TC-T4-01**: 模擬 Sisyphus 薛西弗斯「推巨石」完整推進直至任務完成退出生命週期
- [ ] **TC-T4-02**: 模擬連續 3 次失敗觸發 Circuit Breaker 熔斷之完整生命週期
- [ ] **TC-T4-03**: 模擬任務推進時重試次數重置與最後完成退出週期
- [ ] **TC-T4-04**: 連續透傳一般指令（如 compile 與 test）與 todo.json 動態變更之交互執行流
- [ ] **TC-T4-05**: 薛西弗斯喚醒倒數過程中遭受外部 SIGINT 中斷 (Exit Code 130，無喚醒)
