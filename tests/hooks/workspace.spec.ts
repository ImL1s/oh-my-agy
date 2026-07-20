import * as fs from 'fs';
import * as path from 'path';
import { resolveHookWorkspace, isSafeWorkspaceKey } from '../../src/hooks/workspace';
import { resolveWorkspaceIdentity } from '../../src/runtime/state-root';
import { createStateFixture } from '../helpers/state-fixture';

describe('resolveHookWorkspace', () => {
  test('rejects path-traversal workspaceKeys', () => {
    expect(isSafeWorkspaceKey('../../../tmp/evil')).toBe(false);
    expect(isSafeWorkspaceKey('/abs')).toBe(false);
    const result = resolveHookWorkspace({ workspaceKeys: ['../../../tmp'] }, {});
    expect(result.ok).toBe(false);
  });

  test('managed env prefers OMA_WORKSPACE_PATH over wrong host paths mismatch', () => {
    const fixture = createStateFixture('oma-ws-');
    try {
      const identity = resolveWorkspaceIdentity(fixture.root);
      expect(identity.ok).toBe(true);
      if (!identity.ok) return;
      const other = createStateFixture('oma-ws-other-');
      try {
        const env = {
          OMA_SESSION_ID: 's',
          OMA_LAUNCH_NONCE: 'n',
          OMA_INVOCATION_GENERATION: '1',
          OMA_WORKSPACE_PATH: fixture.root,
        };
        const conflict = resolveHookWorkspace({
          workspacePaths: [other.root],
        }, env, path.join(fixture.root, 'fake-cwd'));
        expect(conflict.ok).toBe(false);

        const ok = resolveHookWorkspace({
          workspacePaths: [fixture.root],
        }, env, path.join(fixture.root, 'fake-cwd'));
        expect(ok.ok).toBe(true);
        if (!ok.ok) return;
        expect(ok.value.source).toBe('managed_override');
        expect(ok.value.workspaceKey).toBe(identity.value.workspaceKey);
      } finally {
        other.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('wrong cwd still resolves via workspacePaths without managed env', () => {
    const fixture = createStateFixture('oma-ws-paths-');
    const fakeCwd = path.join(fixture.root, 'hooks-dir');
    fs.mkdirSync(fakeCwd, { recursive: true });
    try {
      const identity = resolveWorkspaceIdentity(fixture.root);
      expect(identity.ok).toBe(true);
      if (!identity.ok) return;
      const result = resolveHookWorkspace({
        workspacePaths: [fixture.root],
      }, {}, fakeCwd);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.source).toBe('workspace_paths');
      expect(result.value.workspaceKey).toBe(identity.value.workspaceKey);
    } finally {
      fixture.cleanup();
    }
  });
});
