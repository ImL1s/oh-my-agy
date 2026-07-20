/**
 * 薛西弗斯執行器（Continuation Enforcer）的狀態類型
 * - 'idle': 閒置中，無待辦事項或處於等待租約等狀態。
 * - 'continuing': 繼續執行中，代表偵測到未完成的待辦事項，需要注入 Prompt 喚醒 Agent。
 * - 'tripped': 熔斷狀態，代表重試次數已耗盡或發生嚴重錯誤，必須阻斷執行並尋求人工介入。
 */
export type ContinuationStatus = 'idle' | 'continuing' | 'tripped';

/**
 * 延續檢查結果的介面合約（符合 PROJECT.md 規範）
 */
export interface ContinuationResult {
  /**
   * 是否需要注入喚醒提示以繼續執行
   */
  shouldContinue: boolean;

  /**
   * 注入的喚醒提示詞（Prompt）。當 shouldContinue 為 true 時必須提供。
   */
  prompt?: string;

  /**
   * 當前的執行器狀態
   */
  status: ContinuationStatus;

  /**
   * 剩餘重試次數
   */
  remainingRetries: number;
}
