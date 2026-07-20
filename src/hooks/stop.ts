#!/usr/bin/env node
/**
 * Antigravity Stop hook。
 * 官方契約：stdin 含 conversationId / executionNum / terminationReason / fullyIdle / workspacePaths；
 * stdout `{ decision: "continue"|"allow", reason? }`。
 * managed path：SessionAggregateStore + ProgressOracle（不 process.exit）。
 *
 * 設計概念映射：官方 cwd = hooks.json 目錄；workspace 以 workspacePaths / OMA_WORKSPACE_PATH 為準。
 * Stop 亦驗證 sessionId + launchNonceDigest（exact-env），不可只檢查 env 非空。
 */
import * as fs from 'fs';
import { ProgressOracleV1 } from '../continuation/progress-oracle';
import {
  SessionAggregateStore,
  sessionAggregatePath,
} from '../continuation/session-aggregate';
import { StopEventIdentity } from '../continuation/event-identity';
import { StopLocatorEventV1, SessionLocator } from '../continuation/state';
import { sha256, canonicalJson } from '../runtime/atomic';
import { resolveStateRoot } from '../runtime/state-root';
import { serializeHookDecision } from './common';
import { writeHookDebug } from './debug-log';
import { resolveHookWorkspace } from './workspace';

export interface StopHookInput {
  conversationId?: string;
  invocationGeneration?: number;
  executionNum?: number;
  workspaceKeys?: readonly string[];
  workspacePaths?: readonly string[];
  fullyIdle?: boolean;
  terminationReason?: string;
  hasRetryableBlocker?: boolean;
  hasInteractionBlocker?: boolean;
  hasLiveCommand?: boolean;
  /** 忽略 stdin 注入；oracle 使用固定模板 reason */
  continueReason?: string;
  error?: string;
}

export async function handleStop(
  input: Readonly<StopHookInput>,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<string> {
  writeHookDebug('stop.start', input);
  const sessionId = env.OMA_SESSION_ID?.trim();
  const launchNonce = env.OMA_LAUNCH_NONCE?.trim();
  const generationRaw = env.OMA_INVOCATION_GENERATION?.trim();
  if (!sessionId || !launchNonce || !generationRaw) {
    const out = serializeHookDecision({ decision: 'allow' });
    writeHookDebug('stop.fail_open_missing_env', { out });
    return out;
  }

  const stateRoot = resolveStateRoot({ env: env as NodeJS.ProcessEnv, create: false });
  if (!stateRoot.ok) {
    writeHookDebug('stop.fail_open_state_root', stateRoot.error);
    return serializeHookDecision({ decision: 'allow' });
  }

  const workspace = resolveHookWorkspace(input, env);
  if (!workspace.ok) {
    writeHookDebug('stop.fail_open_workspace', workspace.error);
    return serializeHookDecision({ decision: 'allow' });
  }
  writeHookDebug('stop.workspace', {
    source: workspace.value.source,
    workspaceKey: workspace.value.workspaceKey,
    workspaceKeys: workspace.value.workspaceKeys,
    path: workspace.value.identity.workspacePath,
  });

  const generation = input.invocationGeneration
    ?? Number.parseInt(generationRaw, 10);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    writeHookDebug('stop.fail_open_generation', { generationRaw });
    return serializeHookDecision({ decision: 'allow' });
  }

  // host 省略 executionNum 時不可 silent 0（多 Stop 會撞冪等鍵）；缺值 → fail-open
  if (input.executionNum === undefined || !Number.isSafeInteger(input.executionNum) || input.executionNum < 0) {
    writeHookDebug('stop.fail_open_execution_num', { executionNum: input.executionNum ?? null });
    return serializeHookDecision({ decision: 'allow' });
  }

  const root = fs.existsSync(stateRoot.value.path)
    ? fs.realpathSync(stateRoot.value.path)
    : stateRoot.value.path;
  const locator = new SessionLocator(root, workspace.value.workspaceKey);
  const event: StopLocatorEventV1 = {
    conversationId: input.conversationId ?? '',
    invocationGeneration: generation,
    workspaceKeys: workspace.value.workspaceKeys,
  };
  const located = locator.resolveStop(event);
  if (located.kind === 'AllowDiagnostic') {
    writeHookDebug('stop.allow_diagnostic', located.error);
    return serializeHookDecision({ decision: 'allow' });
  }

  // exact-env：sessionId + launchNonce digest 必須吻合 bound session
  if (
    located.session.sessionId !== sessionId
    || located.session.launchNonceDigest !== sha256(launchNonce)
    || located.session.invocationGeneration !== generation
  ) {
    writeHookDebug('stop.fail_open_binding_mismatch', {
      sessionId,
      expectedSessionId: located.session.sessionId,
      generation,
    });
    return serializeHookDecision({ decision: 'allow' });
  }

  const store = new SessionAggregateStore(
    sessionAggregatePath(root, workspace.value.workspaceKey, located.session.sessionId),
  );
  const current = store.read();
  if (!current.ok) {
    writeHookDebug('stop.fail_open_read_aggregate', current.error);
    return serializeHookDecision({ decision: 'allow' });
  }

  const identity: StopEventIdentity = {
    conversationId: event.conversationId || located.session.conversationId || sessionId,
    invocationGeneration: generation,
    executionNum: input.executionNum,
  };
  // 缺欄位不預設 model_stop / fullyIdle=true（避免誤 continue）；host 有送則用原值
  const fullyIdle = input.fullyIdle;
  const terminationReason = input.terminationReason;
  if (fullyIdle === undefined || terminationReason === undefined || terminationReason === '') {
    writeHookDebug('stop.fail_open_eligibility_missing', {
      fullyIdle: fullyIdle ?? null,
      terminationReason: terminationReason ?? null,
    });
    return serializeHookDecision({ decision: 'allow' });
  }

  const oracle = new ProgressOracleV1();
  const fingerprint = oracle.fingerprint({
    acceptedGateRevisions: current.value.autopilot.acceptedGateRevisions,
    acceptedTaskProgressRevisions: current.value.autopilot.acceptedTaskProgressRevisions,
    acceptedEvidenceRevisionsAndDigests: current.value.autopilot.acceptedEvidence,
    verifiedArtifactDigests: current.value.autopilot.verifiedArtifacts,
  });
  const inputDigest = sha256(canonicalJson({
    identity,
    fingerprint,
    fullyIdle,
    terminationReason,
  }));

  try {
    const committed = await store.commitStop(
      identity,
      inputDigest,
      (snapshot) => oracle.reduceStop(
        snapshot,
        identity,
        fingerprint,
        {
          fullyIdle,
          terminationReason,
          hasRetryableBlocker: input.hasRetryableBlocker
            ?? snapshot.autopilot.retryableBlocker !== null,
          hasInteractionBlocker: input.hasInteractionBlocker
            ?? snapshot.autopilot.interactionBlocker !== null,
          hasLiveCommand: input.hasLiveCommand
            ?? snapshot.autopilot.liveCommand !== null,
          // 忽略 stdin continueReason（prompt 注入面）
        },
      ),
    );
    if (!committed.ok) {
      writeHookDebug('stop.commit_failed', committed.error);
      return serializeHookDecision({ decision: 'allow' });
    }
    const out = serializeHookDecision(committed.value.decision);
    writeHookDebug('stop.committed', {
      kind: committed.value.kind,
      decision: committed.value.decision,
      revision: committed.value.snapshot.revision,
    });
    return out;
  } catch (error) {
    writeHookDebug('stop.exception', {
      message: error instanceof Error ? error.message : String(error),
    });
    return serializeHookDecision({ decision: 'allow' });
  }
}

async function main(): Promise<void> {
  let input: StopHookInput = {};
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (raw !== '') input = JSON.parse(raw) as StopHookInput;
  } catch (error) {
    writeHookDebug('stop.stdin_parse_error', {
      message: error instanceof Error ? error.message : String(error),
    });
    input = {};
  }
  const decision = await handleStop(input);
  process.stdout.write(`${decision}\n`);
  process.exit(0);
}

if (require.main === module) {
  void main();
}
