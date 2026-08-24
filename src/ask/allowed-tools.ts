/**
 * 生產 capture 與 `oma ask` 共用的外部 CLI 允許清單。
 *
 * 設計概念映射：`src/production/evidence.ts` 的 fail-closed allowlist
 *（OMC/OMX advisor CLI、OMG `PROVIDERS`）。抽出後 production gate 成員不得增減。
 */
export const ALLOWED_CAPTURE_TOOL_NAMES = [
  'codex',
  'claude',
  'grok',
  'agy',
  'cursor-agent',
] as const;

export type AllowedCaptureTool = typeof ALLOWED_CAPTURE_TOOL_NAMES[number];

/** 與抽出前 `evidence.ts` 相同的五個 basename；production `.has()` 語意不變。 */
export const ALLOWED_CAPTURE_TOOLS = new Set<string>(ALLOWED_CAPTURE_TOOL_NAMES);

export function isAllowedCaptureTool(value: string): value is AllowedCaptureTool {
  return ALLOWED_CAPTURE_TOOLS.has(value);
}
