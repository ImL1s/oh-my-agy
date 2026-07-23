import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyShellWrite, readHookLifecycleEvents } from '../../src/hooks/common';
import { handlePostInvocation } from '../../src/hooks/post-invocation';
import { handlePreInvocation } from '../../src/hooks/pre-invocation';
import { handleSessionStart } from '../../src/hooks/session-start';
import { handleStop } from '../../src/hooks/stop';

describe('hook lifecycle baseline and optional routes', () => {
  test('shell AST classifier allows diagnostic stderr /dev/null but catches writes', () => {
    expect(classifyShellWrite('git status 2>/dev/null').writes).toBe(false);
    expect(classifyShellWrite("cat <<'EOF' | grep x\nhello\nEOF").writes).toBe(false);
    expect(classifyShellWrite('echo x > output.txt').writes).toBe(true);
    expect(classifyShellWrite('echo $(touch owned.txt)').writes).toBe(true);
    expect(classifyShellWrite('printf x | tee /dev/null').writes).toBe(false);
    expect(classifyShellWrite('printf x | tee output.txt').writes).toBe(true);
  });

  test('unregistered SessionStart/PostInvocation remain fail-open and append-only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-optional-hooks-'));
    try {
      const env = { OMA_STATE_ROOT: root };
      expect(handleSessionStart({ conversationId: 'c' }, env)).toEqual({ decision: 'allow', ok: false, claimed: false });
      expect(handlePostInvocation({ conversationId: 'c' }, env)).toEqual({ decision: 'allow', ok: false, claimed: false });
      const events = readHookLifecycleEvents(path.join(root, 'lifecycle', 'optional-hooks.jsonl'));
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.event_type)).toEqual(['session_started', 'turn_completed']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('public hook manifest claims only baseline PreInvocation and Stop', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../hooks.json'), 'utf8'));
    const routes = Object.keys(manifest['oh-my-agy-runtime']).sort();
    expect(routes).toEqual(['PreInvocation', 'Stop']);
  });

  test.each([
    ['missing', {}],
    ['session only', { OMA_SESSION_ID: 'ordinary-session' }],
    ['session and nonce only', { OMA_SESSION_ID: 'ordinary-session', OMA_LAUNCH_NONCE: 'nonce' }],
  ])('ordinary or partially managed hooks fail open without creating state (%s)', async (_label, partialEnv) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-hook-fail-open-'));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { mode: 0o700 });
    try {
      const stateRoot = path.join(root, 'state');
      const env = { OMA_STATE_ROOT: stateRoot, ...partialEnv };
      const pre = await handlePreInvocation({
        conversationId: 'ordinary-conversation', workspacePaths: [workspace], invocationNum: 1,
      }, env);
      expect(pre).toEqual({ injectSteps: [], decision: 'allow', ok: false });
      const stop = JSON.parse(await handleStop({
        conversationId: 'ordinary-conversation', invocationGeneration: 1, executionNum: 1,
        workspacePaths: [workspace], fullyIdle: true, terminationReason: 'model_stop',
      }, env));
      expect(stop).toEqual({ decision: 'allow' });
      expect(fs.existsSync(stateRoot)).toBe(false);
      expect(fs.existsSync(path.join(workspace, '.agy'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
