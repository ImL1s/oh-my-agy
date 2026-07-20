/**
 * 設計概念映射：confirmDangerousLaunch 高危 launch 確認，對齊 oh-my-codex VSCode 危險旗標二次確認。
 * 僅 exact argv token；不掃 prompt 字串。TTY 確認；非 TTY fail-closed，除非顯式 override。
 */
import * as readline from 'readline';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';

export const DANGEROUS_LAUNCH_FLAGS = Object.freeze(['--madmax', '--yolo'] as const);
export type DangerousLaunchFlag = (typeof DANGEROUS_LAUNCH_FLAGS)[number];

export const DANGEROUS_OVERRIDE_FLAG = '--i-understand-dangerous-launch';

export function detectDangerousLaunchFlags(argv: readonly string[]): DangerousLaunchFlag[] {
  const found: DangerousLaunchFlag[] = [];
  for (const flag of DANGEROUS_LAUNCH_FLAGS) {
    if (argv.includes(flag)) found.push(flag);
  }
  return found;
}

export interface ConfirmDangerousLaunchOptions {
  isTTY: boolean;
  argv: readonly string[];
  ask?: () => Promise<string>;
  stderr?: (line: string) => void;
}

export async function confirmDangerousLaunch(
  flags: readonly DangerousLaunchFlag[],
  options: Readonly<ConfirmDangerousLaunchOptions>,
): Promise<Result<void, RuntimeError>> {
  if (flags.length === 0) return ok(undefined);
  if (options.argv.includes(DANGEROUS_OVERRIDE_FLAG)) return ok(undefined);

  const list = flags.join(', ');
  const stderr = options.stderr ?? ((line) => { process.stderr.write(line); });

  if (!options.isTTY) {
    return err(runtimeError(
      'E_VALIDATOR_REJECTED',
      `Dangerous flags ${list} require a TTY confirmation or ${DANGEROUS_OVERRIDE_FLAG}`,
    ));
  }

  stderr(`WARNING: dangerous launch flags detected: ${list}\nType 'yes' to continue: `);
  const answer = options.ask ? await options.ask() : await defaultAsk();
  if (answer.trim().toLowerCase() !== 'yes') {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'Dangerous launch cancelled by operator'));
  }
  return ok(undefined);
}

/** 剝除 override 旗標後再轉發給 agy；保留 --madmax/--yolo 本體。 */
export function stripDangerousOverride(argv: readonly string[]): string[] {
  return argv.filter((token) => token !== DANGEROUS_OVERRIDE_FLAG);
}

export interface GuardDangerousArgvOptions {
  isTTY?: boolean;
  ask?: () => Promise<string>;
  stderr?: (line: string) => void;
}

/**
 * 偵測 → 確認 → 回傳可轉發給 agy 的 argv（已剝 override）。
 */
export async function guardDangerousArgv(
  argv: readonly string[],
  options: Readonly<GuardDangerousArgvOptions> = {},
): Promise<Result<readonly string[], RuntimeError>> {
  const flags = detectDangerousLaunchFlags(argv);
  const confirmed = await confirmDangerousLaunch(flags, {
    isTTY: options.isTTY ?? Boolean(process.stdin.isTTY),
    argv,
    ask: options.ask,
    stderr: options.stderr,
  });
  if (!confirmed.ok) return confirmed;
  return ok(stripDangerousOverride(argv));
}

function defaultAsk(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question('', (line) => {
      rl.close();
      resolve(line);
    });
  });
}
