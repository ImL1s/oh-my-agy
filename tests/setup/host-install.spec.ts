import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  installSlashHosts,
  linkProjectSkills,
  parseSetupHosts,
} from '../../src/setup/host-install';

describe('slash host install helpers', () => {
  test('parseSetupHosts defaults to all', () => {
    expect(parseSetupHosts([])).toEqual(['all']);
    expect(parseSetupHosts(['--host', 'claude'])).toEqual(['claude']);
    expect(parseSetupHosts(['--host', 'grok'])).toEqual(['grok']);
    expect(parseSetupHosts(['--host', 'agy'])).toEqual(['agy']);
    expect(parseSetupHosts(['--agy-only'])).toEqual(['agy']);
    expect(parseSetupHosts(['--claude'])).toEqual(['claude']);
    expect(parseSetupHosts(['--grok'])).toEqual(['grok']);
  });

  test('parseSetupHosts rejects invalid --host', () => {
    expect(parseSetupHosts(['--host', 'foo'])).toEqual([]);
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

  test('installSlashHosts fails closed without claude plugin manifest', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-no-manifest-'));
    try {
      const result = installSlashHosts(tmp, ['claude']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('E_CORRUPT_STATE');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('installSlashHosts returns steps for real package root', () => {
    const packageRoot = path.resolve(__dirname, '../..');
    const result = installSlashHosts(packageRoot, ['claude', 'grok']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schemaVersion).toBe(1);
    expect(result.value.steps).toHaveLength(2);
    expect(result.value.steps.map((s) => s.host).sort()).toEqual(['claude', 'grok']);
    for (const step of result.value.steps) {
      expect(['ok', 'needs_manual', 'failed', 'skipped']).toContain(step.status);
      expect(step.message.length).toBeGreaterThan(0);
    }
  });
});
