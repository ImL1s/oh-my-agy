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
import {
  InstallCommandReceiptV1,
  OwnedInstallPathV1,
  commandReceipt,
} from './receipt';

export type SetupHost = 'agy' | 'claude' | 'grok' | 'all';

export interface HostInstallStepV1 {
  host: 'claude' | 'grok';
  status: 'ok' | 'skipped' | 'needs_manual' | 'failed';
  message: string;
  commands?: string[];
  commandReceipts?: InstallCommandReceiptV1[];
  ownedPaths?: OwnedInstallPathV1[];
  detail?: unknown;
}

export interface HostInstallReportV1 {
  schemaVersion: 1;
  packageRoot: string;
  steps: HostInstallStepV1[];
}

export interface HostCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export interface PrimaryInstallAuthorityV1 {
  status: 'ok' | 'warning' | 'failed';
}

export interface HostInstallAuthorityV1 {
  status: 'installed' | 'completed_with_warning' | 'failed';
  exitCode: 0 | 1 | 2;
  primary: PrimaryInstallAuthorityV1['status'];
  auxiliary: 'ok' | 'warning' | 'failed';
}

/** 可注入 adapter：unit test 禁止碰真 claude/grok CLI。 */
export interface HostCliAdapter {
  which(cmd: string): string | null;
  run(cmd: string, args: readonly string[]): HostCliResult;
}

/** Host CLI install 不可無限卡住（對齊 doctor agy probe 的 timeout 習慣）。 */
export const HOST_CLI_TIMEOUT_MS = 60_000;

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

/** Claude Code plugin spec，對齊 OMC marketplace install 識別字。 */
export const CLAUDE_PLUGIN_INSTALL_SPEC = 'oh-my-agy@oh-my-agy';

/** 實際會交給 `claude` 的 argv（不含可執行檔）。dry-run 與 install 共用，避免計畫漂移。 */
export function claudeMarketplaceAddArgs(packageRoot: string): readonly string[] {
  return ['plugin', 'marketplace', 'add', packageRoot];
}

export function claudePluginInstallArgs(): readonly string[] {
  return ['plugin', 'install', CLAUDE_PLUGIN_INSTALL_SPEC];
}

/** 實際會交給 `grok` 的 argv（不含可執行檔）。對齊 OMG `plugin install --trust`。 */
export function grokPluginInstallArgs(packageRoot: string): readonly string[] {
  return ['plugin', 'install', packageRoot, '--trust'];
}

/**
 * 將被 spawn 的完整 argv（含 host 可執行檔名稱）。
 * 設計概念映射：OMX `setup --dry-run` 先列計畫；此處輸出可直接複製執行的 argv 陣列。
 */
export function plannedClaudeSlashSpawns(packageRoot: string): readonly (readonly string[])[] {
  return [
    ['claude', ...claudeMarketplaceAddArgs(packageRoot)],
    ['claude', ...claudePluginInstallArgs()],
  ];
}

export function plannedGrokSlashSpawns(packageRoot: string): readonly (readonly string[])[] {
  return [
    ['grok', ...grokPluginInstallArgs(packageRoot)],
  ];
}

/** slash steps 是否有硬失敗（timeout 等）— setup exit 1。needs_manual 不算 hard fail。 */
export function slashReportHasHardFailure(report: HostInstallReportV1): boolean {
  return report.steps.some((s) => s.status === 'failed');
}

/**
 * Antigravity is the authoritative install. Auxiliary Claude/Grok success can
 * never turn a primary failure into success; manual auxiliary work is a warn.
 */
export function evaluateHostInstallAuthority(
  primary: Readonly<PrimaryInstallAuthorityV1>,
  report: Readonly<HostInstallReportV1>,
): HostInstallAuthorityV1 {
  const auxiliary = report.steps.some((step) => step.status === 'failed')
    ? 'failed'
    : report.steps.some((step) => step.status === 'needs_manual') ? 'warning' : 'ok';
  if (primary.status === 'failed' || auxiliary === 'failed') {
    return { status: 'failed', exitCode: 1, primary: primary.status, auxiliary };
  }
  if (primary.status === 'warning' || auxiliary === 'warning') {
    return {
      status: 'completed_with_warning',
      exitCode: 2,
      primary: primary.status,
      auxiliary,
    };
  }
  return { status: 'installed', exitCode: 0, primary: primary.status, auxiliary };
}

/**
 * 安裝 Claude / Grok slash surface（不取代 agy transaction）。
 */
export function installSlashHosts(
  packageRoot: string,
  hosts: ReadonlyArray<SetupHost>,
  adapter?: HostCliAdapter,
): Result<HostInstallReportV1, RuntimeError> {
  const hostAdapter = adapter ?? defaultHostCliAdapter();
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
    steps.push(installClaudeSlash(root, hostAdapter));
  }
  if (want.has('grok')) {
    steps.push(installGrokSlash(root, hostAdapter));
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

function installClaudeSlash(packageRoot: string, adapter: HostCliAdapter): HostInstallStepV1 {
  const claude = adapter.which('claude');
  const marketplaceArgs = claudeMarketplaceAddArgs(packageRoot);
  const installArgs = claudePluginInstallArgs();
  const commands = [
    ['claude', ...marketplaceArgs].map(shellQuote).join(' '),
    ['claude', ...installArgs].map(shellQuote).join(' '),
    `# if install fails, enable after restart: claude plugin enable ${CLAUDE_PLUGIN_INSTALL_SPEC}`,
    '# slash: /oh-my-agy:autopilot <goal>',
  ];

  // packageRoot 下的 skill link 僅利於「在 OMA repo 當 workspace」的本機開發，不是 global workspace 安裝
  const link = linkProjectSkills(packageRoot, path.join(packageRoot, '.claude', 'skills'));
  if (claude === null) {
    return {
      host: 'claude',
      status: 'needs_manual',
      message:
        `claude CLI not on PATH; linked skills under packageRoot (.claude/skills)=${link.ok}. `
        + 'Install Claude Code plugin manually (see commands).',
      commands,
      ownedPaths: link.ownedPaths,
      detail: { packageRootSkillsLink: link },
    };
  }

  const marketplace = adapter.run(claude, marketplaceArgs);
  const install = adapter.run(claude, installArgs);
  const commandReceipts = [
    hostCommandReceipt(claude, marketplaceArgs, marketplace),
    hostCommandReceipt(claude, installArgs, install),
  ];

  if (install.timedOut || marketplace.timedOut) {
    return {
      host: 'claude',
      status: 'failed',
      message: 'claude plugin install timed out; run commands below manually',
      commands,
      commandReceipts,
      ownedPaths: link.ownedPaths,
      detail: {
        marketplaceCode: marketplace.status,
        installCode: install.status,
        packageRootSkillsLink: link,
      },
    };
  }

  if (install.status === 0 || isAlreadyInstalled(install)) {
    return {
      host: 'claude',
      status: 'ok',
      message:
        install.status === 0
          ? 'Claude plugin install exit 0; restart session for /oh-my-agy:autopilot (enable if not listed)'
          : 'Claude plugin already installed; restart session for /oh-my-agy:autopilot',
      commands,
      commandReceipts,
      ownedPaths: link.ownedPaths,
      detail: {
        marketplaceCode: marketplace.status,
        packageRootSkillsLink: link,
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
    message:
      'Automatic claude plugin install failed; run commands below. '
      + 'packageRoot .claude/skills is only for OMA-repo local discovery.',
    commands,
    commandReceipts,
    ownedPaths: [...link.ownedPaths, ...userLink.ownedPaths],
    detail: {
      marketplaceCode: marketplace.status,
      installCode: install.status,
      packageRootSkillsLink: link,
      userPluginSkillsLink: userLink,
    },
  };
}

function installGrokSlash(packageRoot: string, adapter: HostCliAdapter): HostInstallStepV1 {
  const grok = adapter.which('grok');
  const installArgs = grokPluginInstallArgs(packageRoot);
  const commands = [
    ['grok', ...installArgs].map(shellQuote).join(' '),
    '# slash: /oh-my-agy:autopilot <goal>',
  ];
  const packageLink = linkProjectSkills(packageRoot, path.join(packageRoot, '.grok', 'skills'));

  if (grok === null) {
    return {
      host: 'grok',
      status: 'needs_manual',
      message:
        `grok CLI not on PATH; linked skills under packageRoot (.grok/skills)=${packageLink.ok}. `
        + 'Run plugin install manually (see commands).',
      commands,
      ownedPaths: packageLink.ownedPaths,
      detail: { packageRootSkillsLink: packageLink },
    };
  }

  const result = adapter.run(grok, installArgs);
  const commandReceipts = [
    hostCommandReceipt(grok, installArgs, result),
  ];
  if (result.timedOut) {
    return {
      host: 'grok',
      status: 'failed',
      message: 'grok plugin install timed out; run commands below manually',
      commands,
      commandReceipts,
      ownedPaths: packageLink.ownedPaths,
      detail: { code: result.status, packageRootSkillsLink: packageLink },
    };
  }
  if (result.status === 0) {
    return {
      host: 'grok',
      status: 'ok',
      message: 'Grok plugin install succeeded; restart session for /oh-my-agy:autopilot',
      commands,
      commandReceipts,
      ownedPaths: packageLink.ownedPaths,
      detail: {
        packageRootSkillsLink: packageLink,
      },
    };
  }

  // Idempotent: already installed is success for slash-first setup
  if (isAlreadyInstalled(result)) {
    return {
      host: 'grok',
      status: 'ok',
      message: 'Grok plugin already installed; restart session for /oh-my-agy:autopilot',
      commands,
      commandReceipts,
      ownedPaths: packageLink.ownedPaths,
      detail: {
        code: result.status,
        packageRootSkillsLink: packageLink,
      },
    };
  }

  return {
    host: 'grok',
    status: 'needs_manual',
    message:
      'grok plugin install failed; packageRoot .grok/skills is only for OMA-repo local discovery',
    commands,
    commandReceipts,
    ownedPaths: packageLink.ownedPaths,
    detail: {
      code: result.status,
      packageRootSkillsLink: packageLink,
    },
  };
}

function isAlreadyInstalled(result: HostCliResult): boolean {
  const combined = `${result.stderr || ''}\n${result.stdout || ''}`;
  return /already installed/i.test(combined);
}

/**
 * 將 packageRoot/skills/<name> 以**絕對路徑** symlink 到 destRoot/<name>。
 * 設計概念映射：跨 /tmp sandbox 與專案根時相對 symlink 在 macOS 易斷，一律 path.resolve。
 */
export function linkProjectSkills(
  packageRoot: string,
  destRoot: string,
): {
  ok: boolean;
  linked: string[];
  errors: string[];
  skipped: string[];
  ownedPaths: OwnedInstallPathV1[];
} {
  const root = path.resolve(packageRoot);
  const destBase = path.resolve(destRoot);
  const srcRoot = path.join(root, 'skills');
  const linked: string[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];
  const ownedPaths: OwnedInstallPathV1[] = [];
  if (!fs.existsSync(srcRoot)) {
    return { ok: false, linked, errors: ['skills/ missing'], skipped, ownedPaths };
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
        if (!canReplaceSkillDest(dest, src, srcRoot)) {
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
      ownedPaths.push({ path: dest, kind: 'host_skill_symlink', identity: src });
    } catch (error) {
      errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  ownedPaths.sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  ));
  return { ok: errors.length === 0 && linked.length > 0, linked, errors, skipped, ownedPaths };
}

function hostCommandReceipt(
  command: string,
  argv: readonly string[],
  result: Readonly<HostCliResult>,
): InstallCommandReceiptV1 {
  return commandReceipt(
    [command, ...argv],
    result.status ?? (result.timedOut ? 124 : 1),
    result.stdout,
    result.stderr || result.error || '',
  );
}

/**
 * 僅替換不存在、或已指向 **此 packageRoot/skills** 的 symlink；
 * 不刪使用者真實 skill 目錄，也不砍指向其他工具 skills 的 link。
 */
function canReplaceSkillDest(dest: string, expectedSrc: string, packageSkillsRoot: string): boolean {
  try {
    const st = fs.lstatSync(dest);
    if (!st.isSymbolicLink()) return false;
    const current = fs.readlinkSync(dest);
    const resolved = path.isAbsolute(current)
      ? path.resolve(current)
      : path.resolve(path.dirname(dest), current);
    if (resolved === expectedSrc) return true;
    const skillsRoot = path.resolve(packageSkillsRoot);
    const relative = path.relative(skillsRoot, resolved);
    return relative !== ''
      && !relative.startsWith('..')
      && !path.isAbsolute(relative)
      && path.basename(resolved) === path.basename(expectedSrc);
  } catch {
    return true;
  }
}

export function defaultHostCliAdapter(): HostCliAdapter {
  return {
    which(cmd: string): string | null {
      const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      if (result.status !== 0) return null;
      const line = (result.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      return line || null;
    },
    run(cmd: string, args: readonly string[]): HostCliResult {
      const result = spawnSync(cmd, [...args], {
        encoding: 'utf8',
        timeout: HOST_CLI_TIMEOUT_MS,
      });
      const timedOut = Boolean(
        result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT',
      ) || Boolean(
        result.error && /ETIMEDOUT|timed out/i.test(result.error.message),
      );
      return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        timedOut,
        error: result.error ? result.error.message : undefined,
      };
    },
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
