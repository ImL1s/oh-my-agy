/**
 * 設計概念映射：OMC 的 Claude plugin 註冊 + OMG 的 Grok plugin install。
 * Slash-first UX：把 skills 掛進 Claude Code / Grok 發現路徑，讓 /oh-my-agy:autopilot 可用。
 * agy 既有 transaction 仍負責 Antigravity hooks。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Result, err, ok } from '../runtime/types';
import { RuntimeError, runtimeError } from '../runtime/errors';

export type SetupHost = 'agy' | 'claude' | 'grok' | 'all';

export interface HostInstallStepV1 {
  host: 'claude' | 'grok';
  status: 'ok' | 'skipped' | 'needs_manual' | 'failed';
  message: string;
  commands?: string[];
  detail?: unknown;
}

export interface HostInstallReportV1 {
  schemaVersion: 1;
  packageRoot: string;
  steps: HostInstallStepV1[];
}

/** Host CLI install 不可無限卡住（對齊 doctor agy probe 的 timeout 習慣）。 */
const HOST_CLI_TIMEOUT_MS = 60_000;

export function parseSetupHosts(argv: readonly string[]): SetupHost[] {
  const hostIdx = argv.indexOf('--host');
  if (hostIdx >= 0 && argv[hostIdx + 1]) {
    const h = argv[hostIdx + 1];
    if (h === 'agy' || h === 'claude' || h === 'grok' || h === 'all') return [h];
    // 非法值不靜默當成 all — 回傳 empty 由 caller 處理（services 可印 warn）
    return [];
  }
  if (argv.includes('--claude')) return ['claude'];
  if (argv.includes('--grok')) return ['grok'];
  if (argv.includes('--agy-only')) return ['agy'];
  return ['all'];
}

/**
 * 安裝 Claude / Grok slash surface（不取代 agy transaction）。
 */
export function installSlashHosts(
  packageRoot: string,
  hosts: ReadonlyArray<SetupHost>,
): Result<HostInstallReportV1, RuntimeError> {
  const root = path.resolve(packageRoot);
  const manifest = path.join(root, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifest)) {
    return err(runtimeError(
      'E_CORRUPT_STATE',
      'Missing .claude-plugin/plugin.json — cannot install slash skills',
      { manifest },
    ));
  }

  const want = expandHosts(hosts);
  const steps: HostInstallStepV1[] = [];

  if (want.has('claude')) {
    steps.push(installClaudeSlash(root));
  }
  if (want.has('grok')) {
    steps.push(installGrokSlash(root));
  }

  return ok({ schemaVersion: 1, packageRoot: root, steps });
}

function expandHosts(hosts: ReadonlyArray<SetupHost>): Set<'claude' | 'grok'> {
  const set = new Set<'claude' | 'grok'>();
  for (const h of hosts) {
    if (h === 'all') {
      set.add('claude');
      set.add('grok');
    } else if (h === 'claude' || h === 'grok') {
      set.add(h);
    }
  }
  return set;
}

function installClaudeSlash(packageRoot: string): HostInstallStepV1 {
  const claude = which('claude');
  const commands = [
    `claude plugin marketplace add ${shellQuote(packageRoot)}`,
    `claude plugin install oh-my-agy@oh-my-agy`,
    '# if install fails, enable after restart: claude plugin enable oh-my-agy@oh-my-agy',
    '# slash: /oh-my-agy:autopilot <goal>',
  ];

  // Prefer project-local skill visibility (highest priority for Grok; Claude also scans .claude/skills)
  const link = linkProjectSkills(packageRoot, path.join(packageRoot, '.claude', 'skills'));
  if (claude === null) {
    return {
      host: 'claude',
      status: 'needs_manual',
      message: `claude CLI not on PATH; project skills linked=${link.ok}. Install Claude Code plugin manually.`,
      commands,
      detail: link,
    };
  }

  const marketplace = spawnHostCli(claude, ['plugin', 'marketplace', 'add', packageRoot]);
  const install = spawnHostCli(claude, ['plugin', 'install', 'oh-my-agy@oh-my-agy']);

  if (install.timedOut || marketplace.timedOut) {
    return {
      host: 'claude',
      status: 'failed',
      message: 'claude plugin install timed out; run commands below manually',
      commands,
      detail: { marketplace, install, projectSkillsLink: link },
    };
  }

  if (install.status === 0) {
    return {
      host: 'claude',
      status: 'ok',
      message:
        'Claude plugin install exit 0; restart session for /oh-my-agy:autopilot (enable if not listed)',
      commands,
      detail: {
        marketplaceCode: marketplace.status,
        installStdout: (install.stdout || '').slice(0, 500),
        projectSkillsLink: link,
      },
    };
  }

  // Fallback: user-level skill symlink under namespaced plugin dir (does not steal bare /autopilot)
  const userLink = linkProjectSkills(
    packageRoot,
    path.join(os.homedir(), '.claude', 'plugins', 'oh-my-agy-local', 'skills'),
  );

  return {
    host: 'claude',
    status: 'needs_manual',
    message: 'Automatic claude plugin install failed; run commands below or use project .claude/skills',
    commands,
    detail: {
      marketplaceCode: marketplace.status,
      marketplaceErr: (marketplace.stderr || marketplace.stdout || '').slice(0, 400),
      installCode: install.status,
      installErr: (install.stderr || install.stdout || '').slice(0, 400),
      projectSkillsLink: link,
      userPluginSkillsLink: userLink,
    },
  };
}

function installGrokSlash(packageRoot: string): HostInstallStepV1 {
  const grok = which('grok');
  const commands = [
    `grok plugin install ${shellQuote(packageRoot)} --trust`,
    '# slash: /oh-my-agy:autopilot <goal>',
  ];
  const projectLink = linkProjectSkills(packageRoot, path.join(packageRoot, '.grok', 'skills'));

  if (grok === null) {
    return {
      host: 'grok',
      status: 'needs_manual',
      message: `grok CLI not on PATH; project .grok/skills linked=${projectLink.ok}`,
      commands,
      detail: projectLink,
    };
  }

  const result = spawnHostCli(grok, ['plugin', 'install', packageRoot, '--trust']);
  if (result.timedOut) {
    return {
      host: 'grok',
      status: 'failed',
      message: 'grok plugin install timed out; run commands below manually',
      commands,
      detail: { result, projectSkillsLink: projectLink },
    };
  }
  if (result.status === 0) {
    return {
      host: 'grok',
      status: 'ok',
      message: 'Grok plugin install succeeded; restart session for /oh-my-agy:autopilot',
      commands,
      detail: {
        stdout: (result.stdout || '').slice(0, 500),
        projectSkillsLink: projectLink,
      },
    };
  }

  return {
    host: 'grok',
    status: 'needs_manual',
    message: 'grok plugin install failed; project skills may still load via .grok/skills',
    commands,
    detail: {
      code: result.status,
      err: (result.stderr || result.stdout || '').slice(0, 500),
      projectSkillsLink: projectLink,
    },
  };
}

/**
 * 將 packageRoot/skills/<name> 以**絕對路徑** symlink 到 destRoot/<name>。
 * 設計概念映射：跨 /tmp sandbox 與專案根時相對 symlink 在 macOS 易斷，一律 path.resolve。
 */
export function linkProjectSkills(
  packageRoot: string,
  destRoot: string,
): { ok: boolean; linked: string[]; errors: string[]; skipped: string[] } {
  const root = path.resolve(packageRoot);
  const destBase = path.resolve(destRoot);
  const srcRoot = path.join(root, 'skills');
  const linked: string[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];
  if (!fs.existsSync(srcRoot)) {
    return { ok: false, linked, errors: ['skills/ missing'], skipped };
  }
  fs.mkdirSync(destBase, { recursive: true });
  for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(srcRoot, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const dest = path.join(destBase, entry.name);
    const src = path.resolve(srcRoot, entry.name);
    try {
      if (fs.lstatSync(dest)) {
        if (!canReplaceSkillDest(dest, src)) {
          skipped.push(`${entry.name}: existing non-OMA path preserved`);
          continue;
        }
        fs.rmSync(dest, { recursive: true, force: true });
      }
    } catch {
      // dest may not exist
    }
    try {
      fs.symlinkSync(src, dest, 'dir');
      linked.push(entry.name);
    } catch (error) {
      errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: errors.length === 0 && linked.length > 0, linked, errors, skipped };
}

/** 僅替換不存在、或已指向 skills 下的 symlink；不刪使用者真實 skill 目錄。 */
function canReplaceSkillDest(dest: string, expectedSrc: string): boolean {
  try {
    const st = fs.lstatSync(dest);
    if (!st.isSymbolicLink()) return false;
    const current = fs.readlinkSync(dest);
    const resolved = path.isAbsolute(current)
      ? path.resolve(current)
      : path.resolve(path.dirname(dest), current);
    // 允許替換舊的相對 OMA skill link，或任何已指向 expectedSrc 的 link
    if (resolved === expectedSrc) return true;
    // 相對/舊路徑若落在 .../skills/<name> 也視為 OMA 管理
    const base = path.basename(resolved);
    const parent = path.basename(path.dirname(resolved));
    return parent === 'skills' && base === path.basename(expectedSrc);
  } catch {
    return true;
  }
}

interface HostCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

function spawnHostCli(cmd: string, args: string[]): HostCliResult {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: HOST_CLI_TIMEOUT_MS,
  });
  const timedOut = Boolean(result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT')
    || (result.signal === 'SIGTERM' && result.status === null && result.error);
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    timedOut: Boolean(timedOut || (result.error && /ETIMEDOUT|timed out/i.test(result.error.message))),
    error: result.error ? result.error.message : undefined,
  };
}

function which(cmd: string): string | null {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const line = (result.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line || null;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
