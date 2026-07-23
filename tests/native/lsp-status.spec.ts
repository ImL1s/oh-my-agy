import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inspectHostLspStatus } from '../../src/native/lsp-status';

describe('host-owned LSP registration status', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-lsp-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('validates registration and reports configured_unobserved rather than healthy', () => {
    fs.writeFileSync(path.join(root, '.lsp.json'), JSON.stringify({
      servers: {
        typescript: {
          command: 'typescript-language-server', args: ['--stdio'], transport: 'stdio',
          extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact' },
        },
      },
    }));
    const status = inspectHostLspStatus({ plugin_root: root, command_available: () => true });
    expect(status).toEqual(expect.objectContaining({
      status: 'configured_unobserved', host_observation: 'unobserved', evidence_tier: 'T0',
      semantic_proxy_operations: 0, detail_code: 'LSP_CONFIGURED_HOST_UNOBSERVED',
    }));
    expect(status.servers[0]).toEqual(expect.objectContaining({
      status: 'configured_unobserved', command_available: true, evidence_tier: 'T0',
    }));
  });

  test('does not execute registered servers and exposes unavailable commands honestly', () => {
    fs.writeFileSync(path.join(root, '.lsp.json'), JSON.stringify({
      demo: { command: 'definitely-missing', extensionToLanguage: { '.demo': 'demo' } },
    }));
    const commands: string[] = [];
    const status = inspectHostLspStatus({
      plugin_root: root,
      command_available: (command) => { commands.push(command); return false; },
    });
    expect(commands).toEqual(['definitely-missing']);
    expect(status.detail_code).toBe('LSP_CONFIGURED_COMMAND_UNAVAILABLE');
    expect(status.servers[0].status).toBe('command_unavailable');
  });

  test('rejects symlinks, traversal, and malformed registration', () => {
    const external = path.join(os.tmpdir(), `oma-lsp-external-${process.pid}.json`);
    fs.writeFileSync(external, '{}');
    try {
      fs.symlinkSync(external, path.join(root, '.lsp.json'));
      expect(inspectHostLspStatus({ plugin_root: root }).status).toBe('invalid');
      expect(inspectHostLspStatus({ plugin_root: root, registration_relative_path: '../outside' }).status).toBe('invalid');
      fs.rmSync(path.join(root, '.lsp.json'));
      fs.writeFileSync(path.join(root, '.lsp.json'), '{broken');
      expect(inspectHostLspStatus({ plugin_root: root }).detail_code).toBe('LSP_REGISTRATION_SCHEMA_INVALID');
    } finally { fs.rmSync(external, { force: true }); }
  });
});
