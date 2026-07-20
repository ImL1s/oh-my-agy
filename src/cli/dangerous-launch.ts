/**
 * 設計概念映射：confirmDangerousLaunch 旗標偵測，對齊 oh-my-codex VSCode 高危 launch 確認概念（research_report）。
 * 僅 exact argv token；不掃 prompt 字串。
 */
export const DANGEROUS_LAUNCH_FLAGS = Object.freeze(['--madmax', '--yolo'] as const);
export type DangerousLaunchFlag = (typeof DANGEROUS_LAUNCH_FLAGS)[number];

export function detectDangerousLaunchFlags(argv: readonly string[]): DangerousLaunchFlag[] {
  const found: DangerousLaunchFlag[] = [];
  for (const flag of DANGEROUS_LAUNCH_FLAGS) {
    if (argv.includes(flag)) found.push(flag);
  }
  return found;
}
