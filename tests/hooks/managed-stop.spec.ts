import * as fs from 'fs';
import * as path from 'path';
import { handleStop } from '../../src/hooks/stop';
import { handlePreInvocation } from '../../src/hooks/pre-invocation';
import { SessionLocator } from '../../src/continuation/state';
import { sessionAggregatePath } from '../../src/continuation/session-aggregate';
import { resolveWorkspaceIdentity } from '../../src/runtime/state-root';
import { currentProcessIdentity } from '../../src/runtime/process';
import { createStateFixture } from '../helpers/state-fixture';

describe('managed hook authority', () => {
  test('PreInvocation fail-open always includes decision:allow', async () => {
    const result = await handlePreInvocation({}, {});
    expect(result).toEqual({ injectSteps: [], decision: 'allow', ok: false });
  });

  test('NO_TOOL_CALL is eligible and continues; wrong cwd uses workspacePaths', async () => {
    const fixture = createStateFixture('oma-managed-stop-');
    fs.chmodSync(fixture.root, 0o700);
    const previousCwd = process.cwd();
    try {
      // 模擬 host：hook cwd 是 .agents / plugin 目錄，不是 workspace
      const fakeHooksCwd = path.join(fixture.root, 'fake-hooks-cwd');
      fs.mkdirSync(fakeHooksCwd, { recursive: true });
      process.chdir(fakeHooksCwd);

      const workspacePath = fixture.root;
      const workspace = resolveWorkspaceIdentity(workspacePath);
      expect(workspace.ok).toBe(true);
      if (!workspace.ok) return;

      const locator = new SessionLocator(fixture.root, workspace.value.workspaceKey, {
        processLiveness: () => 'alive',
        childSpawnWaitMs: 50,
        childSpawnPollMs: 5,
      });
      const owner = currentProcessIdentity('owner');
      const created = await locator.createManagedLaunch({
        sessionId: 's-stop',
        repoKey: workspace.value.repoKey,
        workspaceKey: workspace.value.workspaceKey,
        workspacePath,
        launchNonce: 'nonce-stop',
        owner,
        ttlMs: 60_000,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const child = {
        pid: process.pid + 1,
        parentPid: process.pid,
        startMarker: 'child-fixture',
        ownerNonce: 'owner',
      };
      expect(created.value.transaction.recordChildSpawned(child).ok).toBe(true);

      const env = {
        ...created.value.transaction.env,
        OMA_STATE_ROOT: fixture.root,
        OMA_WORKSPACE_PATH: workspacePath,
        OMA_PACKAGE_ROOT: workspacePath,
      };

      const pre = await handlePreInvocation({
        conversationId: 'conv-stop',
        workspacePaths: [workspacePath],
      }, env);
      expect(pre).toEqual(expect.objectContaining({
        ok: true,
        bindingRoute: 'exact_env',
        sessionId: 's-stop',
      }));

      // live host 送 NO_TOOL_CALL，不是文件示例 model_stop
      const decisionJson = await handleStop({
        conversationId: 'conv-stop',
        invocationGeneration: 1,
        executionNum: 0,
        workspacePaths: [workspacePath],
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
      }, env);
      const decision = JSON.parse(decisionJson);
      expect(decision.decision).toBe('continue');
      expect(typeof decision.reason).toBe('string');
      expect(decision.reason.length).toBeGreaterThan(0);

      const aggregatePath = sessionAggregatePath(
        fixture.root,
        workspace.value.workspaceKey,
        's-stop',
      );
      const aggregate = JSON.parse(fs.readFileSync(aggregatePath, 'utf8'));
      expect(aggregate.revision).toBeGreaterThanOrEqual(1);
      expect(Object.keys(aggregate.processedStops).length).toBe(1);
      const stopEntry = Object.values(aggregate.processedStops)[0] as {
        breakerEligible: boolean;
        decisionJson: string;
      };
      expect(stopEntry.breakerEligible).toBe(true);
      expect(JSON.parse(stopEntry.decisionJson).decision).toBe('continue');

      // 同 identity 重放必須仍是 continue（嚴格冪等）
      const replay = JSON.parse(await handleStop({
        conversationId: 'conv-stop',
        invocationGeneration: 1,
        executionNum: 0,
        workspacePaths: [workspacePath],
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
      }, env));
      expect(replay.decision).toBe('continue');

      // 下一個 executionNum 仍 continue（streak 2）
      const second = JSON.parse(await handleStop({
        conversationId: 'conv-stop',
        invocationGeneration: 1,
        executionNum: 1,
        workspacePaths: [workspacePath],
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
      }, env));
      expect(second.decision).toBe('continue');
    } finally {
      process.chdir(previousCwd);
      fixture.cleanup();
    }
  });

  test('missing executionNum or wrong nonce fails open without continue', async () => {
    const fixture = createStateFixture('oma-stop-auth-');
    fs.chmodSync(fixture.root, 0o700);
    const previousCwd = process.cwd();
    try {
      process.chdir(fixture.root);
      const workspace = resolveWorkspaceIdentity(fixture.root);
      if (!workspace.ok) return;
      const locator = new SessionLocator(fixture.root, workspace.value.workspaceKey, {
        processLiveness: () => 'alive',
        childSpawnWaitMs: 50,
        childSpawnPollMs: 5,
      });
      const created = await locator.createManagedLaunch({
        sessionId: 's-auth',
        repoKey: workspace.value.repoKey,
        workspaceKey: workspace.value.workspaceKey,
        workspacePath: fixture.root,
        launchNonce: 'nonce-auth',
        owner: currentProcessIdentity('owner'),
        ttlMs: 60_000,
      });
      if (!created.ok) return;
      created.value.transaction.recordChildSpawned({
        pid: process.pid + 2,
        parentPid: process.pid,
        startMarker: 'c',
        ownerNonce: 'owner',
      });
      const env = {
        ...created.value.transaction.env,
        OMA_STATE_ROOT: fixture.root,
        OMA_WORKSPACE_PATH: fixture.root,
      };
      await handlePreInvocation({
        conversationId: 'conv-auth',
        workspacePaths: [fixture.root],
      }, env);

      const missingExec = JSON.parse(await handleStop({
        conversationId: 'conv-auth',
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
        workspacePaths: [fixture.root],
      }, env));
      expect(missingExec.decision).toBe('allow');

      const badNonce = JSON.parse(await handleStop({
        conversationId: 'conv-auth',
        executionNum: 0,
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
        workspacePaths: [fixture.root],
      }, { ...env, OMA_LAUNCH_NONCE: 'wrong-nonce' }));
      expect(badNonce.decision).toBe('allow');
    } finally {
      process.chdir(previousCwd);
      fixture.cleanup();
    }
  });
});
