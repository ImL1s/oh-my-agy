import * as fs from 'fs';
import * as path from 'path';

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
      'dist', 'plugin.json', 'hooks.json', 'skills', 'rules',
    ]));
  });
});

