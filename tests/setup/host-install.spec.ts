import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HostCliAdapter,
  HostCliResult,
  evaluateHostInstallAuthority,
  installSlashHosts,
  linkProjectSkills,
  parseSetupHosts,
  plannedClaudeSlashSpawns,
  plannedGrokSlashSpawns,
  slashReportHasHardFailure,
} from '../../src/setup/host-install';

function fakeResult(partial: Partial<HostCliResult> = {}): HostCliResult {
  return {
    status: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...partial,
  };
}

function mockAdapter(opts: {
  which?: Record<string, string | null>;
  run?: (cmd: string, args: readonly string[]) => HostCliResult;
}): HostCliAdapter {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  return {
    which(cmd: string) {
      if (opts.which && cmd in opts.which) return opts.which[cmd] ?? null;
      return null;
    },
    run(cmd: string, args: readonly string[]) {
      calls.push({ cmd, args });
      if (opts.run) return opts.run(cmd, args);
      return fakeResult({ status: 0, stdout: 'ok' });
    },
    // expose for assertions
    ...({ calls } as object),
  } as HostCliAdapter & { calls: Array<{ cmd: string; args: readonly string[] }> };
}

describe('slash host install helpers', () => {
  test('parseSetupHosts defaults to all', () => {
    expect(parseSetupHosts([])).toEqual(['all']);
    expect(parseSetupHosts(['--host', 'claude'])).toEqual(['claude']);
    expect(parseSetupHosts(['--host', 'grok'])).toEqual(['grok']);
    expect(parseSetupHosts(['--host', 'agy'])).toEqual(['agy']);
    expect(parseSetupHosts(['--agy-only'])).toEqual(['agy']);
    expect(parseSetupHosts(['--claude'])).toEqual(['claude']);
    expect(parseSetupHosts(['--grok'])).toEqual(['grok']);
    expect(parseSetupHosts(['--dry-run'])).toEqual(['all']);
    expect(parseSetupHosts(['--dry-run', '--host', 'claude', '--workspace'])).toEqual(['claude']);
  });

  test('parseSetupHosts rejects invalid --host', () => {
    expect(parseSetupHosts(['--host', 'foo'])).toEqual([]);
  });

  test('planned slash spawns are full copy-paste argv arrays shared with install', () => {
    const root = '/tmp/oma-package';
    expect(plannedClaudeSlashSpawns(root)).toEqual([
      ['claude', 'plugin', 'marketplace', 'add', root],
      ['claude', 'plugin', 'install', 'oh-my-agy@oh-my-agy'],
    ]);
    expect(plannedGrokSlashSpawns(root)).toEqual([
      ['grok', 'plugin', 'install', root, '--trust'],
    ]);
  });

  test('linkProjectSkills uses absolute symlink targets under /tmp', () => {
    const packageRoot = path.resolve(__dirname, '../..');
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-skills-link-'));
    try {
      const result = linkProjectSkills(packageRoot, dest);
      expect(result.ok).toBe(true);
      expect(result.linked).toEqual(expect.arrayContaining(['autopilot', 'ralph']));
      const skillLink = path.join(dest, 'autopilot');
      expect(fs.existsSync(path.join(skillLink, 'SKILL.md'))).toBe(true);
      const target = fs.readlinkSync(skillLink);
      expect(path.isAbsolute(target)).toBe(true);
      expect(target).toBe(path.resolve(packageRoot, 'skills', 'autopilot'));
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  test('linkProjectSkills does not destroy real skill directories', () => {
    const packageRoot = path.resolve(__dirname, '../..');
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-skills-safe-'));
    try {
      const realDir = path.join(dest, 'autopilot');
      fs.mkdirSync(realDir);
      fs.writeFileSync(path.join(realDir, 'USER.md'), 'keep-me', 'utf8');
      const result = linkProjectSkills(packageRoot, dest);
      expect(result.skipped.some((s) => s.startsWith('autopilot:'))).toBe(true);
      expect(fs.existsSync(path.join(realDir, 'USER.md'))).toBe(true);
      expect(fs.readFileSync(path.join(realDir, 'USER.md'), 'utf8')).toBe('keep-me');
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  test('linkProjectSkills does not replace foreign skills symlink', () => {
    const packageRoot = path.resolve(__dirname, '../..');
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-skills-foreign-'));
    const foreignSkills = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-foreign-skills-'));
    try {
      const foreign = path.join(foreignSkills, 'autopilot');
      fs.mkdirSync(foreign);
      fs.writeFileSync(path.join(foreign, 'SKILL.md'), 'foreign', 'utf8');
      fs.symlinkSync(foreign, path.join(dest, 'autopilot'), 'dir');
      const result = linkProjectSkills(packageRoot, dest);
      expect(result.skipped.some((s) => s.startsWith('autopilot:'))).toBe(true);
      expect(fs.readFileSync(path.join(dest, 'autopilot', 'SKILL.md'), 'utf8')).toBe('foreign');
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.rmSync(foreignSkills, { recursive: true, force: true });
    }
  });

  test('installSlashHosts fails closed without claude plugin manifest', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-no-manifest-'));
    try {
      const result = installSlashHosts(tmp, ['claude'], mockAdapter({}));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('E_CORRUPT_STATE');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('installSlashHosts with mock adapter — CLI missing → needs_manual (no real spawn)', () => {
    const packageRoot = path.resolve(__dirname, '../..');
    const adapter = mockAdapter({ which: { claude: null, grok: null } });
    const result = installSlashHosts(packageRoot, ['claude', 'grok'], adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps).toHaveLength(2);
    expect(result.value.steps.every((s) => s.status === 'needs_manual')).toBe(true);
    expect(slashReportHasHardFailure(result.value)).toBe(false);
  });

  test('installSlashHosts with mock adapter — success path', () => {
    const packageRoot = path.resolve(__dirname, '../..');
    const adapter = mockAdapter({
      which: { claude: '/bin/claude', grok: '/bin/grok' },
      run: () => fakeResult({ status: 0, stdout: 'installed' }),
    });
    const result = installSlashHosts(packageRoot, ['claude', 'grok'], adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(result.value.steps.every((s) => (s.commandReceipts?.length ?? 0) > 0)).toBe(true);
    expect(result.value.steps.flatMap((s) => s.ownedPaths ?? [])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'host_skill_symlink' }),
      ]),
    );
    expect(slashReportHasHardFailure(result.value)).toBe(false);
  });

  test('primary Antigravity failure cannot be masked by auxiliary host success', () => {
    const report = {
      schemaVersion: 1 as const,
      packageRoot: '/tmp/oma-stage',
      steps: [
        { host: 'claude' as const, status: 'ok' as const, message: 'installed' },
        { host: 'grok' as const, status: 'ok' as const, message: 'installed' },
      ],
    };
    expect(evaluateHostInstallAuthority({ status: 'failed' }, report)).toEqual(
      expect.objectContaining({ status: 'failed', exitCode: 1 }),
    );
    expect(evaluateHostInstallAuthority({ status: 'warning' }, report)).toEqual(
      expect.objectContaining({ status: 'completed_with_warning', exitCode: 2 }),
    );
    expect(evaluateHostInstallAuthority({ status: 'ok' }, report)).toEqual(
      expect.objectContaining({ status: 'installed', exitCode: 0 }),
    );
  });

  test('installSlashHosts with mock adapter — already installed → ok', () => {
    const packageRoot = path.resolve(__dirname, '../..');
    const adapter = mockAdapter({
      which: { claude: '/bin/claude', grok: '/bin/grok' },
      run: () => fakeResult({
        status: 1,
        stderr: "Error: repo 'oh-my-agy' already installed\n",
      }),
    });
    const result = installSlashHosts(packageRoot, ['claude', 'grok'], adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps.every((s) => s.status === 'ok')).toBe(true);
  });

  test('installSlashHosts with mock adapter — timeout → failed hard', () => {
    const packageRoot = path.resolve(__dirname, '../..');
    const adapter = mockAdapter({
      which: { claude: '/bin/claude', grok: '/bin/grok' },
      run: () => fakeResult({ status: null, timedOut: true, error: 'ETIMEDOUT' }),
    });
    const result = installSlashHosts(packageRoot, ['claude', 'grok'], adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps.every((s) => s.status === 'failed')).toBe(true);
    expect(slashReportHasHardFailure(result.value)).toBe(true);
  });
});
