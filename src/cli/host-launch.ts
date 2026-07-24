/**
 * OMX/Sol-aligned root host launcher for Antigravity (`agy`).
 * Case IDs: GRAM-01..05, POL-01..05, SAFE-01, OBS-01
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGY_OPEN_FLAG,
  DANGEROUS_OVERRIDE_FLAG,
  guardDangerousArgv,
} from './dangerous-launch';

export const MADMAX_FLAG = '--madmax';
export const YOLO_FLAG = '--yolo';
export const DIRECT_FLAG = '--direct';
export const TMUX_FLAG = '--tmux';
export const END_OF_OPTIONS = '--';

export const STRUCTURED_FIRST_TOKENS = Object.freeze(new Set([
  '--help', '-h', '--version', '-v',
  'help', 'version',
  'autopilot', 'team', 'setup', 'doctor', 'skill',
  'workflow', 'mcp-server', 'wiki', 'hud',
  'native-status', 'lsp-status', 'sidecar-status', 'notify',
  'resume', 'recovery', 'update', 'uninstall', 'parity', 'production',
]));

export const LAUNCHER_ONLY_FLAGS = Object.freeze(new Set([
  MADMAX_FLAG, YOLO_FLAG, DIRECT_FLAG, TMUX_FLAG,
]));

export type LaunchPolicy = 'auto' | 'tmux' | 'direct';

export class HostLaunchUsageError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'HostLaunchUsageError';
    this.exitCode = exitCode;
  }
}

export function splitAtEndOfOptions(argv: readonly string[]): {
  readonly head: readonly string[];
  readonly suffix: readonly string[];
} {
  const idx = argv.indexOf(END_OF_OPTIONS);
  if (idx < 0) return { head: [...argv], suffix: [] };
  return { head: argv.slice(0, idx), suffix: argv.slice(idx) };
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): LaunchPolicy | undefined {
  const raw = env.OMA_LAUNCH_POLICY?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'auto') return 'auto';
  if (raw === 'direct') return 'direct';
  if (raw === 'tmux' || raw === 'detached-tmux') return 'tmux';
  throw new HostLaunchUsageError(
    `oma: invalid OMA_LAUNCH_POLICY=${JSON.stringify(raw)} (expected auto|direct|tmux|detached-tmux)`,
  );
}

export function resolveLaunchPolicy(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { policy: LaunchPolicy; rest: string[]; suffix: readonly string[] } {
  const { head, suffix } = splitAtEndOfOptions(argv);
  let policy: LaunchPolicy = policyFromEnv(env) ?? 'auto';
  const rest: string[] = [];
  for (const arg of head) {
    if (arg === DIRECT_FLAG) {
      policy = 'direct';
      continue;
    }
    if (arg === TMUX_FLAG) {
      policy = 'tmux';
      continue;
    }
    rest.push(arg);
  }
  return { policy, rest, suffix };
}

const LEGACY_MAGIC_FIRST = Object.freeze(new Set([
  'ralph', 'ultrawork', 'uw', 'ulw', 'search',
]));

const INLINE_MAGIC_RE = /\b(ralph|ultrawork|uw|ulw|search)\b/i;

/** True when pre-`--` head looks like legacy inline magic (GRAM-04: ignore suffix). */
export function hasInlineMagicKeyword(argv: readonly string[]): boolean {
  const { head } = splitAtEndOfOptions(argv);
  const cleaned = head.join(' ')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');
  return INLINE_MAGIC_RE.test(cleaned);
}

/** GRAM-05: launcher-only flags after a recognized first token → usage/2. */
export function rejectLauncherFlagsAfterSubcommand(argv: readonly string[]): void {
  const { head } = splitAtEndOfOptions(argv);
  if (head.length === 0) return;
  const first = head[0] ?? '';
  const owned = STRUCTURED_FIRST_TOKENS.has(first) || LEGACY_MAGIC_FIRST.has(first.toLowerCase());
  if (!owned) return;
  for (const tok of head.slice(1)) {
    if (LAUNCHER_ONLY_FLAGS.has(tok)) {
      throw new HostLaunchUsageError(
        `oma: E_LAUNCH_USAGE — ${tok} is a host launcher flag and cannot follow command ${JSON.stringify(first)}`,
      );
    }
  }
}

/** True when root host-launch should run (before structured/magic/continuation). */
export function shouldHostLaunch(argv: readonly string[]): boolean {
  rejectLauncherFlagsAfterSubcommand(argv);
  if (argv.length === 0) return true;
  const { head } = splitAtEndOfOptions(argv);
  const first = head[0] ?? '';
  if (STRUCTURED_FIRST_TOKENS.has(first)) return false;
  if (LEGACY_MAGIC_FIRST.has(first.toLowerCase())) return false;
  if (head.includes(MADMAX_FLAG)) return true;
  if (head.includes(YOLO_FLAG)) return true;
  if (hasInlineMagicKeyword(argv)) return false;
  return true;
}

export function normalizeAgyHostArgv(argv: readonly string[], options: {
  readonly madmax: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly stderr?: (text: string) => void;
}): string[] {
  const { rest, suffix } = resolveLaunchPolicy(argv, options.env);
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const out: string[] = [];
  let sawOpen = false;
  let sawModePlan = false;
  let sawSandbox = false;
  let sawOverride = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === MADMAX_FLAG || arg === YOLO_FLAG) continue;
    if (arg === DANGEROUS_OVERRIDE_FLAG) {
      sawOverride = true;
      continue;
    }
    if (arg === AGY_OPEN_FLAG) {
      if (!sawOpen) {
        out.push(arg);
        sawOpen = true;
      }
      continue;
    }
    if (arg === '--mode') {
      const value = rest[i + 1];
      if (value === 'plan') sawModePlan = true;
      out.push(arg);
      if (value !== undefined && !value.startsWith('-')) {
        out.push(value);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--mode=')) {
      if (arg.slice('--mode='.length) === 'plan') sawModePlan = true;
      out.push(arg);
      continue;
    }
    if (arg === '--sandbox' || arg.startsWith('--sandbox=')) {
      sawSandbox = true;
      out.push(arg);
      if (arg === '--sandbox') {
        const value = rest[i + 1];
        if (value !== undefined && !value.startsWith('-')) {
          out.push(value);
          i += 1;
        }
      }
      continue;
    }
    out.push(arg);
  }

  if (sawOverride) {
    stderr('oma: warning: --i-understand-dangerous-launch is deprecated for top-level --madmax (consent is implied)\n');
  }
  if (options.madmax) {
    if (sawModePlan) {
      throw new HostLaunchUsageError('oma madmax: refusing --mode plan (full-open host launch)');
    }
    if (sawSandbox) {
      throw new HostLaunchUsageError('oma madmax: refusing --sandbox (full-open host launch)');
    }
    if (!sawOpen) out.unshift(AGY_OPEN_FLAG);
  }

  out.push(...suffix);
  return out;
}

function executableOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathEnv = env.PATH ?? '';
  // Windows: only accept native binaries (.exe / extensionless). Never resolve
  // .cmd/.bat shims — spawning them requires unsafe cmd.exe string encoding (OBS-01).
  const exts = process.platform === 'win32' ? ['.EXE', '.exe', ''] : [''];
  const seen = new Set<string>();
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // try next
      }
    }
  }
  return undefined;
}

function insideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TMUX || env.TMUX_PANE);
}

function tmuxAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(executableOnPath('tmux', env));
}

function isInteractiveTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function cwdDigest(cwd: string): string {
  return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 8);
}

function sessionNameForCwd(cwd: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const nonce = crypto.randomBytes(3).toString('hex');
  return `oma-${cwdDigest(cwd)}-${stamp}-${nonce}`;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildPaneCommand(executable: string, argv: readonly string[], exitFile: string): string {
  // Avoid `exec` so we can record the host exit code (LIFE-01).
  const body = [
    [executable, ...argv].map(shellEscape).join(' '),
    `ec=$?`,
    `printf '%s' "$ec" > ${shellEscape(exitFile)}`,
    `exit "$ec"`,
  ].join('; ');
  const shell = process.env.SHELL || '/bin/zsh';
  return `exec ${shellEscape(shell)} -lc ${shellEscape(body)}`;
}

async function runDirect(executable: string, argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    throw new HostLaunchUsageError(
      'oma: Windows host launch requires a native .exe (set OMA_AGY_BIN); .cmd/.bat shims are not argv-safe',
      127,
    );
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...argv], { cwd, env, stdio: 'inherit', shell: false });
    child.once('error', (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') resolve(127);
      else reject(error);
    });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

async function runInTmux(
  executable: string,
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  required: boolean,
  stderr: (text: string) => void,
): Promise<number> {
  if (!tmuxAvailable(env)) {
    if (required) {
      throw new HostLaunchUsageError(
        'oma: E_LAUNCH_TMUX_UNAVAILABLE — tmux requested but not installed (brew install tmux)',
        1,
      );
    }
    stderr('oma: tmux unavailable; falling back to direct launch\n');
    return runDirect(executable, argv, cwd, env);
  }
  if (required && !isInteractiveTty() && !insideTmux(env)) {
    throw new HostLaunchUsageError(
      'oma: E_LAUNCH_TTY_REQUIRED — explicit --tmux needs a TTY outside an existing tmux session',
      1,
    );
  }
  const name = sessionNameForCwd(cwd);
  const exitFile = path.join(os.tmpdir(), `oma-host-exit-${process.pid}-${name}.code`);
  try { fs.unlinkSync(exitFile); } catch { /* ignore */ }
  const pane = buildPaneCommand(executable, argv, exitFile);
  const create = spawnSync('tmux', ['new-session', '-d', '-s', name, '-c', cwd, pane], {
    encoding: 'utf8',
    env,
  });
  if (create.status !== 0) {
    throw new HostLaunchUsageError(`oma: failed to create tmux session ${JSON.stringify(name)}`, 1);
  }
  spawnSync('tmux', ['set-option', '-t', name, 'mouse', 'on'], { encoding: 'utf8' });
  stderr(`oma: created detached session ${name}; attaching (reattach: tmux attach -t ${name})\n`);
  const attach = spawnSync('tmux', ['attach-session', '-t', name], { stdio: 'inherit', env });
  const attachRc = attach.status ?? 1;
  let hostRc: number | undefined;
  try {
    const raw = fs.readFileSync(exitFile, 'utf8').trim();
    const code = Number.parseInt(raw, 10);
    if (Number.isFinite(code)) hostRc = code;
  } catch { /* ignore */ }
  if (attachRc !== 0) {
    if (hostRc !== undefined && hostRc !== 0) return hostRc;
    return attachRc;
  }
  if (hostRc !== undefined) return hostRc;
  const stillAlive = spawnSync('tmux', ['has-session', '-t', name], { encoding: 'utf8' }).status === 0;
  if (stillAlive) return attachRc;
  return 1;
}

export async function runHostLaunch(argv: readonly string[], options: {
  readonly cwd?: string;
  readonly agyCommand?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stderr?: (text: string) => void;
}): Promise<number> {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const requested = options.agyCommand ?? env.OMA_AGY_BIN?.trim() ?? 'agy';
  const resolved = path.isAbsolute(requested) || requested.includes('/') || requested.includes('\\')
    ? requested
    : (executableOnPath(requested, env) ?? requested);
  if (!path.isAbsolute(resolved) && resolved === requested && !executableOnPath(requested, env)) {
    stderr(`oma: ${requested} not on PATH\n`);
    return 127;
  }
  const executable = resolved;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    stderr('oma: Windows host launch requires a native .exe (set OMA_AGY_BIN); .cmd/.bat shims are not argv-safe\n');
    return 127;
  }
  const { head } = splitAtEndOfOptions(argv);
  const madmax = head.includes(MADMAX_FLAG);
  const hasYolo = head.includes(YOLO_FLAG);

  // GRAM-03: --madmax is consent. Bare --yolo still needs TTY / override.
  // GRAM-04: only the pre-`--` head may influence consent / override detection.
  if (hasYolo && !madmax) {
    const guarded = await guardDangerousArgv([...head], {
      isTTY: Boolean(process.stdin.isTTY),
      stderr,
    });
    if (!guarded.ok) {
      stderr(`${guarded.error.code}: ${guarded.error.message}\n`);
      return 2;
    }
  }

  const { policy } = resolveLaunchPolicy(argv, env);
  const openLaunch = madmax || hasYolo;
  const hostArgv = normalizeAgyHostArgv(argv, { madmax: openLaunch, env, stderr });
  const label = madmax ? 'oma madmax' : 'oma';
  stderr(`${label}: ${executable} ${hostArgv.map((a) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(a) ? a : shellEscape(a))).join(' ') || '(no args)'}\n`);

  // POL-02 → POL-05 → print/auto shortcuts.
  if (insideTmux(env) || policy === 'direct') {
    return runDirect(executable, hostArgv, cwd, env);
  }
  if (policy === 'auto' && process.platform === 'win32') {
    return runDirect(executable, hostArgv, cwd, env);
  }
  if (policy === 'tmux') {
    return runInTmux(executable, hostArgv, cwd, env, true, stderr);
  }
  if (policy === 'auto' && !isInteractiveTty()) {
    return runDirect(executable, hostArgv, cwd, env);
  }
  return runInTmux(executable, hostArgv, cwd, env, false, stderr);
}
