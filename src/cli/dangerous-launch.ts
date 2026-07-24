/**
 * Dangerous host-launch gate.
 *
 * OMX/OMG-aligned contract:
 * - Top-level `--madmax` is explicit operator consent → no TTY prompt; strip the
 *   wrapper token and inject Antigravity `--dangerously-skip-permissions`.
 * - Bare `--yolo` still requires TTY `yes` (or `--i-understand-dangerous-launch`).
 * - Managed modes (`oma ralph --madmax -- …`) remain rejected by the parser
 *   (no silent drop before `--`).
 */
import * as readline from 'readline';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';

export const DANGEROUS_LAUNCH_FLAGS = Object.freeze(['--madmax', '--yolo'] as const);
export type DangerousLaunchFlag = (typeof DANGEROUS_LAUNCH_FLAGS)[number];

export const DANGEROUS_OVERRIDE_FLAG = '--i-understand-dangerous-launch';
/** Closest Antigravity full-open flag (agy does not understand --madmax/--yolo). */
export const AGY_OPEN_FLAG = '--dangerously-skip-permissions';

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
  // Top-level --madmax is itself the consent token (OMX/OMG host-launcher shape).
  if (flags.includes('--madmax')) return ok(undefined);
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

/** Strip wrapper-only tokens before forwarding to agy. */
export function stripDangerousOverride(argv: readonly string[]): string[] {
  return argv.filter((token) => token !== DANGEROUS_OVERRIDE_FLAG);
}

/** Map OMA wrapper danger tokens onto the live Antigravity open flag. */
export function normalizeAgyOpenArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let hasOpen = false;
  for (const token of argv) {
    if (
      token === MADMAX_TOKEN
      || token === YOLO_TOKEN
      || token === DANGEROUS_OVERRIDE_FLAG
    ) {
      continue;
    }
    if (token === AGY_OPEN_FLAG) {
      if (!hasOpen) {
        out.push(token);
        hasOpen = true;
      }
      continue;
    }
    out.push(token);
  }
  if (!hasOpen) out.unshift(AGY_OPEN_FLAG);
  return out;
}

const MADMAX_TOKEN = '--madmax';
const YOLO_TOKEN = '--yolo';

export interface GuardDangerousArgvOptions {
  isTTY?: boolean;
  ask?: () => Promise<string>;
  stderr?: (line: string) => void;
}

/**
 * Detect → confirm → return argv safe to forward to agy.
 * Madmax/yolo wrapper tokens are never forwarded; the host open flag is.
 */
export async function guardDangerousArgv(
  argv: readonly string[],
  options: Readonly<GuardDangerousArgvOptions> = {},
): Promise<Result<readonly string[], RuntimeError>> {
  const flags = detectDangerousLaunchFlags(argv);
  if (flags.length === 0) return ok(stripDangerousOverride(argv));
  const confirmed = await confirmDangerousLaunch(flags, {
    isTTY: options.isTTY ?? Boolean(process.stdin.isTTY),
    argv,
    ask: options.ask,
    stderr: options.stderr,
  });
  if (!confirmed.ok) return confirmed;
  return ok(normalizeAgyOpenArgv(argv));
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
