import { RuntimeError, runtimeError } from '../runtime/errors';
import { resolveWorkspaceIdentity, WorkspaceIdentityV1 } from '../runtime/state-root';
import { Result, err, ok } from '../runtime/types';

export interface HookWorkspaceInput {
  workspaceKeys?: readonly string[];
  workspacePaths?: readonly string[];
}

export interface ResolvedHookWorkspace {
  /** SessionLocator 使用的權威 workspaceKey（與 managed launch 一致） */
  workspaceKey: string;
  /** 傳給 PreInvocation/Stop event 的 keys */
  workspaceKeys: string[];
  identity: WorkspaceIdentityV1;
  source: 'workspace_keys' | 'workspace_paths' | 'oma_workspace_path' | 'cwd' | 'managed_override';
}

/**
 * 設計概念映射：官方 hooks 的 cwd 是 hooks.json 所在目錄（plugin root），
 * 不是 agent workspace。必須優先用 stdin workspacePaths 或 OMA_WORKSPACE_PATH。
 *
 * managed binding env 齊全時：OMA_WORKSPACE_PATH 為權威；host paths 僅交叉檢查。
 */
export function resolveHookWorkspace(
  input: Readonly<HookWorkspaceInput>,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  cwd: string = process.cwd(),
): Result<ResolvedHookWorkspace, RuntimeError> {
  const managed = isManagedBindingEnv(env);
  const managedPath = env.OMA_WORKSPACE_PATH?.trim();

  if (managed && managedPath) {
    const managedIdentity = resolveWorkspaceIdentity(managedPath);
    if (!managedIdentity.ok) {
      return err(runtimeError('E_WORKSPACE_MISMATCH', 'OMA_WORKSPACE_PATH could not be resolved', {
        managedPath,
      }));
    }
    // host workspacePaths 若存在，必須含 managed key；否則 fail-open
    if (input.workspacePaths && input.workspacePaths.length > 0) {
      const host = fromPaths(input.workspacePaths, 'workspace_paths');
      if (!host.ok) return host;
      if (!host.value.workspaceKeys.includes(managedIdentity.value.workspaceKey)) {
        return err(runtimeError('E_WORKSPACE_MISMATCH', 'Host workspacePaths conflict with OMA_WORKSPACE_PATH', {
          managedKey: managedIdentity.value.workspaceKey,
          hostKeys: host.value.workspaceKeys,
        }));
      }
    }
    if (input.workspaceKeys && input.workspaceKeys.length > 0) {
      const keys = uniqueSafeKeys(input.workspaceKeys);
      if (!keys.ok) return keys;
      if (!keys.value.includes(managedIdentity.value.workspaceKey)) {
        return err(runtimeError('E_WORKSPACE_MISMATCH', 'Host workspaceKeys conflict with OMA_WORKSPACE_PATH', {
          managedKey: managedIdentity.value.workspaceKey,
          hostKeys: keys.value,
        }));
      }
    }
    return ok({
      workspaceKey: managedIdentity.value.workspaceKey,
      workspaceKeys: [managedIdentity.value.workspaceKey],
      identity: managedIdentity.value,
      source: 'managed_override',
    });
  }

  if (input.workspaceKeys && input.workspaceKeys.length > 0) {
    const keys = uniqueSafeKeys(input.workspaceKeys);
    if (!keys.ok) return keys;
    const pathCandidates = [
      ...(input.workspacePaths ?? []),
      managedPath,
      cwd,
    ].filter((value): value is string => typeof value === 'string' && value.trim() !== '');
    let identity: WorkspaceIdentityV1 | undefined;
    for (const candidate of pathCandidates) {
      const resolved = resolveWorkspaceIdentity(candidate);
      if (resolved.ok) {
        identity = resolved.value;
        break;
      }
    }
    if (identity === undefined) {
      return err(runtimeError('E_WORKSPACE_MISMATCH', 'Could not resolve workspace identity for keys'));
    }
    // keys 必須含 identity key；禁止任意 keys[0] 逃逸
    if (!keys.value.includes(identity.workspaceKey)) {
      return err(runtimeError('E_WORKSPACE_MISMATCH', 'workspaceKeys do not include resolved identity key', {
        identityKey: identity.workspaceKey,
        keys: keys.value,
      }));
    }
    return ok({
      workspaceKey: identity.workspaceKey,
      workspaceKeys: keys.value,
      identity,
      source: 'workspace_keys',
    });
  }

  if (input.workspacePaths && input.workspacePaths.length > 0) {
    return fromPaths(input.workspacePaths, 'workspace_paths');
  }

  if (managedPath) {
    return fromPaths([managedPath], 'oma_workspace_path');
  }

  return fromPaths([cwd], 'cwd');
}

function isManagedBindingEnv(env: Readonly<NodeJS.ProcessEnv>): boolean {
  return Boolean(
    env.OMA_SESSION_ID?.trim()
    && env.OMA_LAUNCH_NONCE?.trim()
    && env.OMA_INVOCATION_GENERATION?.trim(),
  );
}

function fromPaths(
  paths: readonly string[],
  source: ResolvedHookWorkspace['source'],
): Result<ResolvedHookWorkspace, RuntimeError> {
  const identities: WorkspaceIdentityV1[] = [];
  const keys: string[] = [];
  for (const workspacePath of paths) {
    if (typeof workspacePath !== 'string' || workspacePath.trim() === '') continue;
    const identity = resolveWorkspaceIdentity(workspacePath);
    if (!identity.ok) continue;
    if (!keys.includes(identity.value.workspaceKey)) {
      keys.push(identity.value.workspaceKey);
      identities.push(identity.value);
    }
  }
  if (identities.length === 0 || keys.length === 0) {
    return err(runtimeError('E_WORKSPACE_MISMATCH', 'No resolvable workspace path for hook binding', {
      paths,
      source,
    }));
  }
  return ok({
    workspaceKey: identities[0].workspaceKey,
    workspaceKeys: keys,
    identity: identities[0],
    source,
  });
}

function uniqueSafeKeys(values: readonly string[]): Result<string[], RuntimeError> {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === '') continue;
    if (!isSafeWorkspaceKey(trimmed)) {
      return err(runtimeError('E_WORKSPACE_MISMATCH', 'workspaceKey is not a safe path segment', {
        workspaceKey: trimmed,
      }));
    }
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  if (out.length === 0) {
    return err(runtimeError('E_WORKSPACE_MISMATCH', 'workspaceKeys is empty after normalization'));
  }
  return ok(out);
}

/** 拒絕 path traversal / 絕對路徑 segment；測試可用非 hex 短 key。 */
export function isSafeWorkspaceKey(key: string): boolean {
  if (key === '' || key.includes('\0')) return false;
  if (key.includes('..') || key.includes('/') || key.includes('\\')) return false;
  if (key.startsWith('~')) return false;
  return true;
}
