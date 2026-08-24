import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionLocator } from '../../src/continuation/state';
import {
  appendOperatorDisabledLifecycle,
  HOOK_OPERATOR_DISABLED_SOURCE_V1,
  hookSkipped,
  hooksDisabled,
  hookSuppressed,
  operatorDisabledJournalPath,
  readHookLifecycleEvents,
} from '../../src/hooks/common';
import { writeHookDebug } from '../../src/hooks/debug-log';
import { handlePostInvocation } from '../../src/hooks/post-invocation';
import { handlePreInvocation } from '../../src/hooks/pre-invocation';
import { handleSessionStart } from '../../src/hooks/session-start';
import { handleStop } from '../../src/hooks/stop';
import { resolveHookWorkspace } from '../../src/hooks/workspace';
import { currentProcessIdentity } from '../../src/runtime/process';
import { resolveStateRoot, resolveWorkspaceIdentity } from '../../src/runtime/state-root';
import { runHookFixture } from '../helpers/hook-fixture';
import { runProcessFixture } from '../helpers/process-fixture';
import { createStateFixture } from '../helpers/state-fixture';

jest.mock('../../src/runtime/state-root', () => {
  const actual = jest.requireActual('../../src/runtime/state-root') as typeof import('../../src/runtime/state-root');
  return { ...actual, resolveStateRoot: jest.fn(actual.resolveStateRoot) };
});

jest.mock('../../src/hooks/workspace', () => {
  const actual = jest.requireActual('../../src/hooks/workspace') as typeof import('../../src/hooks/workspace');
  return { ...actual, resolveHookWorkspace: jest.fn(actual.resolveHookWorkspace) };
});

jest.mock('../../src/hooks/debug-log', () => {
  const actual = jest.requireActual('../../src/hooks/debug-log') as typeof import('../../src/hooks/debug-log');
  return { ...actual, writeHookDebug: jest.fn(actual.writeHookDebug) };
});

const mockedResolveStateRoot = resolveStateRoot as jest.MockedFunction<typeof resolveStateRoot>;
const mockedResolveHookWorkspace = resolveHookWorkspace as jest.MockedFunction<typeof resolveHookWorkspace>;
const mockedWriteHookDebug = writeHookDebug as jest.MockedFunction<typeof writeHookDebug>;

function listRelative(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      out.push(path.relative(root, full));
      if (fs.lstatSync(full).isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

function spawnEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  if (!('DISABLE_OMA' in overrides)) delete env.DISABLE_OMA;
  if (!('OMA_SKIP_HOOKS' in overrides)) delete env.OMA_SKIP_HOOKS;
  if (!('OMA_STATE_ROOT' in overrides)) delete env.OMA_STATE_ROOT;
  if (!('OMA_PACKAGE_ROOT' in overrides)) delete env.OMA_PACKAGE_ROOT;
  return env;
}

async function runHookEntrypoint(
  name: 'pre-invocation' | 'stop',
  event: unknown,
  env: NodeJS.ProcessEnv,
) {
  const dist = path.join(__dirname, '../../dist/src/hooks', `${name}.js`);
  const src = path.join(__dirname, '../../src/hooks', `${name}.ts`);
  if (fs.existsSync(dist)) return runHookFixture(dist, event, env);
  const result = await runProcessFixture(
    process.execPath,
    ['-r', require.resolve('ts-node/register'), src],
    { env, input: JSON.stringify(event) },
  );
  return {
    ...result,
    json: result.stdout.trim() === '' ? undefined : JSON.parse(result.stdout),
  };
}

describe('DISABLE_OMA / OMA_SKIP_HOOKS kill switch', () => {
  afterEach(() => {
    mockedResolveStateRoot.mockClear();
    mockedResolveHookWorkspace.mockClear();
    mockedWriteHookDebug.mockClear();
  });

  test.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    [' True ', true],
    [' 1 ', true],
    ['0', false],
    ['', false],
    ['false', false],
    ['FALSE', false],
    ['no', false],
    ['yes', false],
    ['on', false],
    ['2', false],
  ])('hooksDisabled(DISABLE_OMA=%j) === %j', (value, expected) => {
    expect(hooksDisabled({ DISABLE_OMA: value })).toBe(expected);
  });

  test('hooksDisabled is false when unset', () => {
    expect(hooksDisabled({})).toBe(false);
  });

  test('hookSkipped parses comma lists, whitespace, and case', () => {
    const padded = { OMA_SKIP_HOOKS: ' stop , pre-invocation ' };
    expect(hookSkipped('stop', padded)).toBe(true);
    expect(hookSkipped('pre-invocation', padded)).toBe(true);
    expect(hookSkipped('session-start', padded)).toBe(false);
    expect(hookSkipped('post-invocation', padded)).toBe(false);

    const mixed = { OMA_SKIP_HOOKS: 'Stop,PRE-INVOCATION' };
    expect(hookSkipped('stop', mixed)).toBe(true);
    expect(hookSkipped('pre-invocation', mixed)).toBe(true);

    expect(hookSkipped('stop', { OMA_SKIP_HOOKS: 'stop' })).toBe(true);
    expect(hookSkipped('pre-invocation', { OMA_SKIP_HOOKS: 'stop' })).toBe(false);
    expect(hookSkipped('stop', { OMA_SKIP_HOOKS: '   ' })).toBe(false);
    expect(hookSkipped('stop', {})).toBe(false);
    expect(hookSkipped('session-start', { OMA_SKIP_HOOKS: 'session-start,post-invocation' })).toBe(true);
    expect(hookSkipped('post-invocation', { OMA_SKIP_HOOKS: 'session-start,post-invocation' })).toBe(true);
  });

  test('hookSuppressed is DISABLE_OMA OR skip list', () => {
    expect(hookSuppressed('stop', { DISABLE_OMA: '1' })).toBe(true);
    expect(hookSuppressed('pre-invocation', { DISABLE_OMA: '1' })).toBe(true);
    expect(hookSuppressed('stop', { OMA_SKIP_HOOKS: 'stop' })).toBe(true);
    expect(hookSuppressed('pre-invocation', { OMA_SKIP_HOOKS: 'stop' })).toBe(false);
    expect(hookSuppressed('stop', {})).toBe(false);
  });

  test.each(['1', 'true', 'TRUE', ' True '])(
    'DISABLE_OMA=%j: PreInvocation allows with empty injectSteps and does not resolve',
    async (value) => {
      const result = await handlePreInvocation(
        { conversationId: 'conv', workspacePaths: ['/tmp/does-not-matter'] },
        { DISABLE_OMA: value, OMA_SESSION_ID: 's', OMA_LAUNCH_NONCE: 'n', OMA_INVOCATION_GENERATION: '1' },
      );
      expect(result).toEqual({ injectSteps: [], decision: 'allow', ok: true });
      expect(mockedResolveStateRoot).not.toHaveBeenCalled();
      expect(mockedResolveHookWorkspace).not.toHaveBeenCalled();
      expect(mockedWriteHookDebug).not.toHaveBeenCalled();
    },
  );

  test.each(['0', '', 'false'])(
    'DISABLE_OMA=%j does not take the kill-switch path (unmanaged fail-open)',
    async (value) => {
      const result = await handlePreInvocation({ conversationId: 'conv' }, { DISABLE_OMA: value });
      expect(result).toEqual({ injectSteps: [], decision: 'allow', ok: false });
    },
  );

  test('DISABLE_OMA=1 Stop allows without resolving workspace or state root', async () => {
    const decision = JSON.parse(await handleStop(
      { conversationId: 'conv', executionNum: 0, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' },
      { DISABLE_OMA: '1', OMA_SESSION_ID: 's', OMA_LAUNCH_NONCE: 'n', OMA_INVOCATION_GENERATION: '1' },
    ));
    expect(decision).toEqual({ decision: 'allow' });
    expect(mockedResolveStateRoot).not.toHaveBeenCalled();
    expect(mockedResolveHookWorkspace).not.toHaveBeenCalled();
    expect(mockedWriteHookDebug).not.toHaveBeenCalled();
  });

  test('kill switch does not create a missing OMA_STATE_ROOT even with managed binding env', async () => {
    const missing = path.join(os.tmpdir(), `oma-kill-switch-missing-${process.pid}-${Date.now()}`);
    expect(fs.existsSync(missing)).toBe(false);
    const env = {
      DISABLE_OMA: '1',
      OMA_STATE_ROOT: missing,
      OMA_SESSION_ID: 's',
      OMA_LAUNCH_NONCE: 'n',
      OMA_INVOCATION_GENERATION: '1',
    };
    const pre = await handlePreInvocation({ conversationId: 'conv' }, env);
    const stop = JSON.parse(await handleStop({ conversationId: 'conv', executionNum: 0 }, env));
    expect(pre).toEqual({ injectSteps: [], decision: 'allow', ok: true });
    expect(stop).toEqual({ decision: 'allow' });
    expect(fs.existsSync(missing)).toBe(false);
    expect(mockedResolveStateRoot).not.toHaveBeenCalled();
    expect(mockedResolveHookWorkspace).not.toHaveBeenCalled();
  });

  test('kill switch does not touch a temp state root that was not provided', async () => {
    const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-kill-switch-orphan-'));
    try {
      const before = listRelative(orphan);
      const mtime = fs.statSync(orphan).mtimeMs;
      await handlePreInvocation({ conversationId: 'conv' }, { DISABLE_OMA: '1' });
      await handleStop({ conversationId: 'conv' }, { DISABLE_OMA: '1' });
      expect(listRelative(orphan)).toEqual(before);
      expect(fs.statSync(orphan).mtimeMs).toBe(mtime);
      expect(mockedResolveStateRoot).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(orphan, { recursive: true, force: true });
    }
  });

  test('existing OMA_STATE_ROOT gets source=operator_disabled, not antigravity_hook', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-kill-switch-journal-'));
    fs.chmodSync(root, 0o700);
    try {
      const env = {
        DISABLE_OMA: '1',
        OMA_STATE_ROOT: root,
        OMA_SESSION_ID: 'sess-disabled',
        OMA_LAUNCH_NONCE: 'nonce',
        OMA_INVOCATION_GENERATION: '3',
      };
      await handlePreInvocation({ conversationId: 'conv' }, env);
      await handleStop({ conversationId: 'conv' }, env);
      const journal = operatorDisabledJournalPath(root);
      const events = readHookLifecycleEvents(journal);
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.source)).toEqual([
        HOOK_OPERATOR_DISABLED_SOURCE_V1,
        HOOK_OPERATOR_DISABLED_SOURCE_V1,
      ]);
      expect(events.every((event) => event.source !== 'antigravity_hook')).toBe(true);
      expect(fs.existsSync(path.join(root, 'lifecycle', 'hooks.jsonl'))).toBe(false);
      expect(mockedResolveStateRoot).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('appendOperatorDisabledLifecycle skips when the root would have to be created', () => {
    const missing = path.join(os.tmpdir(), `oma-kill-switch-append-missing-${process.pid}-${Date.now()}`);
    expect(appendOperatorDisabledLifecycle('stop', { OMA_STATE_ROOT: missing })).toBeUndefined();
    expect(fs.existsSync(missing)).toBe(false);
  });

  test('OMA_SKIP_HOOKS=stop skips only Stop; PreInvocation still managed', async () => {
    const fixture = createStateFixture('oma-kill-switch-skip-stop-');
    fs.chmodSync(fixture.root, 0o700);
    const previousCwd = process.cwd();
    try {
      const fakeHooksCwd = path.join(fixture.root, 'fake-hooks-cwd');
      fs.mkdirSync(fakeHooksCwd, { recursive: true });
      process.chdir(fakeHooksCwd);

      const workspace = resolveWorkspaceIdentity(fixture.root);
      expect(workspace.ok).toBe(true);
      if (!workspace.ok) return;

      const locator = new SessionLocator(fixture.root, workspace.value.workspaceKey, {
        processLiveness: () => 'alive',
        childSpawnWaitMs: 50,
        childSpawnPollMs: 5,
      });
      const created = await locator.createManagedLaunch({
        sessionId: 's-skip-stop',
        repoKey: workspace.value.repoKey,
        workspaceKey: workspace.value.workspaceKey,
        workspacePath: fixture.root,
        launchNonce: 'nonce-skip-stop',
        owner: currentProcessIdentity('owner'),
        ttlMs: 60_000,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.transaction.recordChildSpawned({
        pid: process.pid + 1,
        parentPid: process.pid,
        startMarker: 'child-fixture',
        ownerNonce: 'owner',
      }).ok).toBe(true);

      const env = {
        ...created.value.transaction.env,
        OMA_STATE_ROOT: fixture.root,
        OMA_WORKSPACE_PATH: fixture.root,
        OMA_PACKAGE_ROOT: fixture.root,
        OMA_SKIP_HOOKS: 'stop',
      };

      mockedResolveStateRoot.mockClear();
      const pre = await handlePreInvocation({
        conversationId: 'conv-skip-stop',
        workspacePaths: [fixture.root],
      }, env);
      expect(pre).toEqual(expect.objectContaining({
        ok: true,
        bindingRoute: 'exact_env',
        sessionId: 's-skip-stop',
      }));
      expect(pre.injectSteps?.length).toBeGreaterThan(0);
      expect(mockedResolveStateRoot).toHaveBeenCalled();

      mockedResolveStateRoot.mockClear();
      mockedResolveHookWorkspace.mockClear();
      const stop = JSON.parse(await handleStop({
        conversationId: 'conv-skip-stop',
        invocationGeneration: 1,
        executionNum: 0,
        workspacePaths: [fixture.root],
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
      }, env));
      expect(stop).toEqual({ decision: 'allow' });
      expect(mockedResolveStateRoot).not.toHaveBeenCalled();
      expect(mockedResolveHookWorkspace).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      fixture.cleanup();
    }
  });

  test('OMA_SKIP_HOOKS with surrounding whitespace skips both public hooks', async () => {
    const env = {
      OMA_SKIP_HOOKS: ' stop , pre-invocation ',
      OMA_SESSION_ID: 's',
      OMA_LAUNCH_NONCE: 'n',
      OMA_INVOCATION_GENERATION: '1',
    };
    const pre = await handlePreInvocation({ conversationId: 'conv' }, env);
    const stop = JSON.parse(await handleStop({ conversationId: 'conv' }, env));
    expect(pre).toEqual({ injectSteps: [], decision: 'allow', ok: true });
    expect(stop).toEqual({ decision: 'allow' });
    expect(mockedResolveStateRoot).not.toHaveBeenCalled();
  });

  test('DISABLE_OMA skips optional SessionStart/PostInvocation writes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-kill-switch-optional-'));
    try {
      const env = { DISABLE_OMA: '1', OMA_STATE_ROOT: root };
      expect(handleSessionStart({ conversationId: 'c' }, env)).toEqual({
        decision: 'allow', ok: false, claimed: false,
      });
      expect(handlePostInvocation({ conversationId: 'c' }, env)).toEqual({
        decision: 'allow', ok: false, claimed: false,
      });
      expect(fs.existsSync(path.join(root, 'lifecycle'))).toBe(false);
      expect(listRelative(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('dist/src hook entrypoints exit 0 when suppressed', async () => {
    const env = spawnEnv({ DISABLE_OMA: '1' });
    const pre = await runHookEntrypoint('pre-invocation', { conversationId: 'conv' }, env);
    const stop = await runHookEntrypoint('stop', { conversationId: 'conv' }, env);
    expect(pre.code).toBe(0);
    expect(stop.code).toBe(0);
    expect(pre.json).toEqual({ injectSteps: [], decision: 'allow', ok: true });
    expect(stop.json).toEqual({ decision: 'allow' });
  }, 30_000);
});
