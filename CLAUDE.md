# oh-my-agy 專案開發指引

此文件記載本專案的建置、測試指令以及程式碼風格與規範。請開發人員嚴格遵守。

## 建置與測試指令

### 1. 安裝相依項目
```bash
npm install
```

### 2. 建置與編譯專案
```bash
npm run build
```

### 3. 執行單元測試
```bash
npm run test:unit
```
涵蓋 runtime、CLI、Autopilot FSM、Team/tmux/temp-Git、plugin setup 等契約測試。

### 4. 執行 E2E 測試
```bash
npm run test:e2e
```
或單一階段：
```bash
npx jest e2e/tier1.spec.ts --runInBand
```

### 5. Package surface
```bash
npm run test:package
```

## 程式碼風格與開發規範

### 命名規範
* **類別 (Class)、型別 (Type) 及介面 (Interface)**：`PascalCase`
* **變數 (Variable)、函式 (Function) 及引數 (Argument)**：`camelCase`
* **常數 (Constant)**：`UPPER_SNAKE_CASE`

### 註解規範
* 所有註解必須使用**繁體中文**，並採用台灣軟體專業術語。
* 註解內必須包含明確的**設計概念映射**（例如參考 `oh-my-claudecode` / `oh-my-codex`）。

### 安全規範
* 禁止使用 `exec` 執行外部命令；必須使用 `spawn` / `spawnSync` 與引數陣列。
* Circuit breaker **禁止** `git reset --hard` / `git clean -fd`。
* 不得修改 `AGENTS.md`。
