/**
 * Legacy magic spawn 的 stdio 閘門。
 *
 * 設計概念映射：對齊 oh-my-codex（OMX）互動式 host launch 的 `stdio: inherit`，
 * 以及 oh-my-grok（OMG）headless auto policy——非 TTY／CI 保持靜音，避免污染 e2e。
 * 顯式 `OMA_LEGACY_STDIO` 覆寫優先於 TTY 判斷；未知值退回 TTY 閘門，不崩潰。
 */

export type LegacyStdioMode = 'inherit' | 'ignore';

export function resolveLegacyStdio(
  env: { readonly OMA_LEGACY_STDIO?: string | undefined },
  isTTY: boolean,
): LegacyStdioMode {
  const raw = env.OMA_LEGACY_STDIO;
  if (raw === 'inherit') {
    return 'inherit';
  }
  if (raw === 'ignore') {
    return 'ignore';
  }
  return isTTY ? 'inherit' : 'ignore';
}
