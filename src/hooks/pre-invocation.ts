#!/usr/bin/env node
/**
 * Antigravity PreInvocation hook。
 * 官方契約：stdin 含 conversationId / workspacePaths；stdout 可 injectSteps。
 * managed exact-env binding 仍寫 SessionLocator；fail-open 不阻斷。
 *
 * 設計概念映射：官方 cwd = hooks.json 目錄（常為 plugin root），
 * 不可用 process.cwd() 當 workspace；改用 workspacePaths / OMA_WORKSPACE_PATH。
 */
import * as fs from 'fs';
import * as path from 'path';
import { ManagedBindingEnv, PreInvocationEventV1, SessionLocator } from '../continuation/state';
import { writeSessionProjection } from '../continuation/session-aggregate';
import { resolveStateRoot } from '../runtime/state-root';
import { appendHookLifecycleEvent, appendOperatorDisabledLifecycle, hookSuppressed } from './common';
import { writeHookDebug } from './debug-log';
import { resolveHookWorkspace } from './workspace';

export interface PreInvocationHookInput {
  conversationId?: string;
  workspaceKeys?: readonly string[];
  /** 官方 common field */
  workspacePaths?: readonly string[];
  invocationNum?: number;
  modelName?: string;
}

export interface PreInvocationHookResult {
  /** 官方建議輸出；空陣列表示不注入 */
  injectSteps?: Array<Record<string, unknown>>;
  /** 診斷用；host 可忽略 */
  decision?: 'allow';
  ok?: boolean;
  bindingRoute?: 'exact_env' | 'first_preinvocation';
  sessionId?: string;
}

export async function handlePreInvocation(
  input: Readonly<PreInvocationHookInput>,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<PreInvocationHookResult> {
  // Operator kill switch 必須是**第一件事**：不得 resolveStateRoot / workspace。
  // lifecycle 只在 OMA_STATE_ROOT 已存在時寫 `operator_disabled`；否則跳過。
  if (hookSuppressed('pre-invocation', env)) {
    appendOperatorDisabledLifecycle('pre-invocation', env);
    return operatorDisabled();
  }
  writeHookDebug('preinvocation.start', input);
  const bindingEnv = readBindingEnv(env);
  if (bindingEnv === undefined) {
    writeHookDebug('preinvocation.fail_open_unmanaged', { ok: false });
    return failOpen();
  }
  const conversationId = input.conversationId?.trim() ?? '';
  if (conversationId === '') {
    const result = failOpen();
    writeHookDebug('preinvocation.fail_open_empty_conversation', result);
    return result;
  }

  const stateRoot = resolveStateRoot({ env: env as NodeJS.ProcessEnv, create: true });
  if (!stateRoot.ok) {
    writeHookDebug('preinvocation.fail_open_state_root', stateRoot.error);
    return failOpen();
  }

  const workspace = resolveHookWorkspace(input, env);
  if (!workspace.ok) {
    writeHookDebug('preinvocation.fail_open_workspace', workspace.error);
    return failOpen();
  }
  writeHookDebug('preinvocation.workspace', {
    source: workspace.value.source,
    workspaceKey: workspace.value.workspaceKey,
    workspaceKeys: workspace.value.workspaceKeys,
    path: workspace.value.identity.workspacePath,
  });

  const locator = new SessionLocator(stateRoot.value.path, workspace.value.workspaceKey);
  const event: PreInvocationEventV1 = {
    conversationId,
    workspaceKeys: workspace.value.workspaceKeys,
  };
  const bound = await locator.bindPreInvocation(event, bindingEnv);
  if (bound.kind === 'AllowDiagnostic') {
    writeHookDebug('preinvocation.allow_diagnostic', bound.error);
    return failOpen();
  }
  // managed exact_env 綁定成功時注入 session skill 提醒（OMC SessionStart / skill-injector 對應）
  const injectSteps = buildManagedSkillInjectSteps(env, bound.session.sessionId);
  const result: PreInvocationHookResult = {
    injectSteps,
    decision: 'allow',
    ok: true,
    bindingRoute: bound.bindingRoute,
    sessionId: bound.session.sessionId,
  };
  const aggregate = locator.readBoundAggregate(bound.session.sessionId);
  if (aggregate.ok) {
    try {
      writeSessionProjection(workspace.value.identity.workspacePath, aggregate.value);
      const journal = path.join(stateRoot.value.path, 'lifecycle', 'hooks.jsonl');
      appendHookLifecycleEvent(journal, {
        eventType: 'session_started',
        runId: bound.session.sessionId,
        generation: bound.session.invocationGeneration,
        parentId: null,
        nativeIdentity: conversationId,
        payload: { binding_route: bound.bindingRoute },
      });
      appendHookLifecycleEvent(journal, {
        eventType: 'turn_started',
        runId: bound.session.sessionId,
        generation: bound.session.invocationGeneration,
        parentId: null,
        nativeIdentity: conversationId,
        payload: { invocation_num: input.invocationNum ?? null },
      });
    } catch (error) {
      writeHookDebug('preinvocation.projection_or_journal_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  writeHookDebug('preinvocation.bound', result);
  return result;
}

/**
 * 設計概念映射：OMC session-start / skill-injector — 在 managed 工作階段提醒 agent 讀取 plugin skills。
 * host 若不認識 injectSteps 結構會忽略；fail-open。
 */
function buildManagedSkillInjectSteps(
  env: Readonly<NodeJS.ProcessEnv>,
  sessionId: string,
): Array<Record<string, unknown>> {
  const packageRoot = env.OMA_PACKAGE_ROOT?.trim();
  const mode = env.OMA_MANAGED_MODE?.trim() || 'managed';
  const skillHint = packageRoot
    ? `Read OMA skill under ${packageRoot}/skills/ (ralph|ultrawork|search|autopilot|team|cancel|verify) and follow it until verified complete.`
    : 'Follow OMA managed skill protocols (ralph/ultrawork/search/autopilot/team). Prefer `oma` CLI for team/autopilot state; never claim complete without verification evidence.';
  return [
    {
      type: 'text',
      text: [
        '[OMA SESSION SKILL]',
        `sessionId=${sessionId}`,
        `mode_hint=${mode}`,
        skillHint,
        'CLI alone is not completion. Execute the skill checklist with fresh evidence.',
      ].join('\n'),
    },
  ];
}

function failOpen(): PreInvocationHookResult {
  return { injectSteps: [], decision: 'allow', ok: false };
}

/**
 * kill switch 命中。與 `failOpen` 的差別在 `ok`：fail-open 代表 OMA 想接管卻辦不到
 * （`ok: false`），operator disabled 代表使用者明確要求不要接管（`ok: true`），
 * 兩者在證據上必須可區分。
 */
function operatorDisabled(): PreInvocationHookResult {
  return { injectSteps: [], decision: 'allow', ok: true };
}

function readBindingEnv(env: Readonly<NodeJS.ProcessEnv>): ManagedBindingEnv | undefined {
  const sessionId = env.OMA_SESSION_ID?.trim();
  const launchNonce = env.OMA_LAUNCH_NONCE?.trim();
  const generation = env.OMA_INVOCATION_GENERATION?.trim();
  if (!sessionId || !launchNonce || !generation) return undefined;
  return {
    OMA_SESSION_ID: sessionId,
    OMA_LAUNCH_NONCE: launchNonce,
    OMA_INVOCATION_GENERATION: generation,
  };
}

async function main(): Promise<void> {
  let input: PreInvocationHookInput = {};
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (raw !== '') input = JSON.parse(raw) as PreInvocationHookInput;
  } catch (error) {
    writeHookDebug('preinvocation.stdin_parse_error', {
      message: error instanceof Error ? error.message : String(error),
    });
    input = {};
  }
  const result = await handlePreInvocation(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

if (require.main === module) {
  void main();
}
