import * as fs from 'fs';
import * as path from 'path';
import { DISCOVERY_PROOF_TOKEN_V1 } from '../../src/native/antigravity-status';
import { computePackageIdentity } from '../../src/setup/installed-identity';

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
    ) as { name?: string; version?: string; skills?: string[] };
    const marketplace = JSON.parse(
      fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'),
    );
    expect(claude.name).toBe('oh-my-agy');
    expect(claude.version).toBe(pkg.version);
    expect(Array.isArray(claude.skills)).toBe(true);
    expect(claude.skills!.length).toBeGreaterThanOrEqual(5);
    expect(claude.skills).toEqual(expect.arrayContaining(['./skills/autopilot/']));
    expect(claude.skills).toEqual(expect.arrayContaining(['./skills/discovery-proof/']));
    expect(claude.skills).toEqual(expect.arrayContaining(['./skills/workflow/']));
    const discoveryProof = fs.readFileSync(
      path.join(root, 'skills', 'discovery-proof', 'SKILL.md'),
      'utf8',
    );
    expect(discoveryProof.split(DISCOVERY_PROOF_TOKEN_V1)).toHaveLength(2);
    expect(marketplace).toBeTruthy();
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
