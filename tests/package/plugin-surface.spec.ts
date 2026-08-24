import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DISCOVERY_PROOF_TOKEN_V1 } from '../../src/native/antigravity-status';
import { listCatalogSkillNames, normalizeClaudePluginSkillEntry } from '../../src/modes/skill-catalog';
import { computePackageIdentity } from '../../src/setup/installed-identity';
import { DoctorCheckV1, runDoctor } from '../../src/setup/doctor';

describe('Antigravity package surface', () => {
  const root = path.resolve(__dirname, '../..');

  test('root manifests register only authoritative PreInvocation and Stop hooks', () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
    const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks.json'), 'utf8'));
    expect(plugin.name).toBe('oh-my-agy');
    const registration = hooks['oh-my-agy-runtime'];
    expect(registration.PreInvocation[0].command).toBe(
      'node "${extensionPath}/dist/src/hooks/pre-invocation.js"',
    );
    expect(registration.Stop[0].command).toBe(
      'node "${extensionPath}/dist/src/hooks/stop.js"',
    );
    expect(registration.PostInvocation).toBeUndefined();
  });

  test('prepack cannot recurse into npm pack or test:package', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.prepack).not.toMatch(/npm\s+pack|test:package/);
    expect(pkg.files).toEqual(expect.arrayContaining([
      'dist/bin', 'dist/src', 'plugin.json', 'hooks.json', '.claude-plugin',
      'skills', 'rules', 'LICENSE',
    ]));
    expect(pkg.license).toBe('MIT');
    expect(pkg.engines?.node).toMatch(/>=\s*20/);
  });

  test('package.json and plugin.json versions stay in sync', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const plugin = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.name).toBe('oh-my-agy');
  });

  test('Claude slash plugin surface ships with namespaced skills', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const claude = JSON.parse(
      fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as {
      name?: string;
      version?: string;
      skills?: string[];
      author?: { name?: string };
      homepage?: string;
    };
    const marketplace = JSON.parse(
      fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as {
      $schema?: string;
      version?: string;
      plugins?: Array<{
        name?: string;
        version?: string;
        category?: string;
        tags?: string[];
        author?: { name?: string };
        homepage?: string;
        description?: string;
      }>;
    };
    expect(claude.name).toBe('oh-my-agy');
    expect(claude.version).toBe(pkg.version);
    expect(Array.isArray(claude.skills)).toBe(true);
    const declared = [...new Set((claude.skills ?? []).map(normalizeClaudePluginSkillEntry))].sort();
    expect(declared).toEqual([...listCatalogSkillNames()].sort());
    expect(claude.skills).toEqual(expect.arrayContaining(['./skills/autopilot/']));
    expect(claude.skills).toEqual(expect.arrayContaining(['./skills/discovery-proof/']));
    expect(claude.skills).toEqual(expect.arrayContaining(['./skills/workflow/']));
    const discoveryProof = fs.readFileSync(
      path.join(root, 'skills', 'discovery-proof', 'SKILL.md'),
      'utf8',
    );
    expect(discoveryProof.split(DISCOVERY_PROOF_TOKEN_V1)).toHaveLength(2);
    expect(marketplace).toBeTruthy();
    // SchemaStore 為現行官方 schema；$id 與 anthropics/claude-code catalog 相同。
    // OMC 仍指向已 404 的 anthropic.com URL，OMA 不跟。
    expect(marketplace.$schema).toBe('https://json.schemastore.org/claude-code-marketplace.json');
    expect(marketplace.version).toBe(pkg.version);
    const entry = marketplace.plugins?.find((plugin) => plugin.name === 'oh-my-agy');
    expect(entry?.version).toBe(pkg.version);
    expect(entry?.category).toBe('productivity');
    expect(entry?.author).toEqual(claude.author);
    expect(entry?.homepage).toBe(claude.homepage);
    expect(entry?.tags).toEqual([
      'antigravity',
      'agy',
      'oma',
      'orchestration',
      'slash-skills',
      'autopilot',
    ]);
    const catalog = JSON.stringify(marketplace);
    expect(catalog).not.toMatch(/npmjs\.org|GitHub Packages|published to npm/i);
    expect(entry?.description).not.toMatch(/npmjs|GitHub Packages/i);
  });

  test('package, plugin, claude plugin, and marketplace versions stay in lockstep', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    const plugin = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')) as {
      version: string;
    };
    const claude = JSON.parse(
      fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { version: string };
    const marketplace = JSON.parse(
      fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { version: string; plugins: Array<{ name: string; version: string }> };
    const entry = marketplace.plugins.find((item) => item.name === 'oh-my-agy');
    expect(plugin.version).toBe(pkg.version);
    expect(claude.version).toBe(pkg.version);
    expect(marketplace.version).toBe(pkg.version);
    expect(entry?.version).toBe(pkg.version);
  });

  test('doctor version_sync passes on the shipped four-way manifests', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-doctor-shipped-'));
    try {
      const report = await runDoctor({
        packageRoot: root,
        adapter: {
          async run(argv) {
            return { argv, code: 0, stdout: '{"imports":[]}', stderr: '' };
          },
        },
        homeDir: home,
        stateRoot: path.join(home, 'state'),
        antigravityConfigRoot: path.join(home, 'gemini-config'),
        mode: 'development',
        agyCommand: 'echo',
      });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.checks.find((check) => check.id === 'version_sync')).toEqual(
        expect.objectContaining({ status: 'pass' }),
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('doctor version_sync fails when either marketplace version is mutated', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-marketplace-version-'));
    try {
      const fixture = path.join(scratch, 'root');
      writeVersionSyncFixture(fixture, '0.5.2');
      const matching = await doctorVersionSync(fixture, '0.5.2');
      expect(matching?.status).toBe('pass');

      const marketplacePath = path.join(fixture, '.claude-plugin', 'marketplace.json');
      const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8')) as {
        version: string;
        plugins: Array<{ version: string }>;
      };
      marketplace.version = '0.0.1';
      fs.writeFileSync(marketplacePath, JSON.stringify(marketplace));
      const topLevel = await doctorVersionSync(fixture, '0.5.2');
      expect(topLevel).toEqual(expect.objectContaining({
        status: 'fail',
        message: expect.stringMatching(/marketplace\.json version 0\.0\.1 != package\.json 0\.5\.2/),
      }));

      marketplace.version = '0.5.2';
      marketplace.plugins[0].version = '0.0.2';
      fs.writeFileSync(marketplacePath, JSON.stringify(marketplace));
      const entry = await doctorVersionSync(fixture, '0.5.2');
      expect(entry).toEqual(expect.objectContaining({
        status: 'fail',
        message: expect.stringMatching(
          /marketplace\.json plugin oh-my-agy version 0\.0\.2 != package\.json 0\.5\.2/,
        ),
      }));
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('shipping identity is deterministic and includes install/update/uninstall runtime', () => {
    const first = computePackageIdentity(root);
    const second = computePackageIdentity(root);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.digest).toBe(first.value.digest);
    expect(first.value.inventory.find((entry) => entry.path === first.value.entrypoints.cli))
      .toEqual(expect.objectContaining({ executable: true }));
    expect(first.value.inventory.map((entry) => entry.path)).toEqual(
      [...first.value.inventory.map((entry) => entry.path)].sort((left, right) =>
        Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))),
    );
    for (const relative of [
      'dist/src/setup/installed-identity.js',
      'dist/src/setup/receipt.js',
      'dist/src/setup/transaction.js',
      'dist/src/setup/update.js',
      'dist/src/setup/uninstall.js',
    ]) {
      expect(first.value.inventory.map((entry) => entry.path)).toContain(relative);
    }
  });
});

// 設計概念映射：OMC sync-version.sh 用真實檔案同步；OMA 以 doctor version_sync 對 fixture 做反向紅燈。
function writeVersionSyncFixture(root: string, version: string): void {
  fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@iml1s/oh-my-agy', version,
  }));
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({
    name: 'oh-my-agy', version,
  }));
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'oh-my-agy', version, skills: ['./skills/autopilot/'],
  }));
  fs.writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'oh-my-agy',
    version,
    owner: { name: 'ImL1s' },
    plugins: [{ name: 'oh-my-agy', source: './', version }],
  }));
  fs.writeFileSync(path.join(root, 'dist', 'bin', 'oma.js'), '#!/usr/bin/env node\n');
}

async function doctorVersionSync(
  packageRoot: string,
  packageVersion: string,
): Promise<DoctorCheckV1 | undefined> {
  const report = await runDoctor({
    packageRoot,
    packageVersion,
    adapter: {
      async run(argv) {
        return { argv, code: 0, stdout: '{"imports":[]}', stderr: '' };
      },
    },
    homeDir: path.join(packageRoot, 'home'),
    stateRoot: path.join(packageRoot, 'state'),
    antigravityConfigRoot: path.join(packageRoot, 'gemini-config'),
    mode: 'development',
    agyCommand: 'echo',
  });
  if (!report.ok) return undefined;
  return report.value.checks.find((check) => check.id === 'version_sync');
}
