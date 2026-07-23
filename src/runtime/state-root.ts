import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { sha256 } from './atomic';
import { SAFE_KEY_PATTERN, safePathKey } from '../contracts/path-key';
import { RuntimeError, runtimeError } from './errors';
import { Result, err, ok } from './types';

export interface StateRootOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  create?: boolean;
  expectedUid?: number;
}

export interface StateRootInfo {
  path: string;
  source: 'environment' | 'platform-default';
}

export interface WorkspaceIdentityV1 {
  repoKey: string | null;
  workspaceKey: string;
  canonicalPath: string;
  workspacePath: string;
  gitCommonDir: string | null;
  isGit: boolean;
}

/** Preserve already-safe W0 keys; hash every raw external identifier once. */
export function externalStatePathKey(identifier: string): string {
  return SAFE_KEY_PATTERN.test(identifier) ? identifier : safePathKey(identifier);
}

export function platformSessionAggregateRelativePath(
  workspaceIdentifier: string,
  sessionIdentifier: string,
): string {
  return path.join(
    'workspaces', externalStatePathKey(workspaceIdentifier),
    'sessions', externalStatePathKey(sessionIdentifier), 'aggregate.json',
  );
}

export function platformWorkspaceSessionsRoot(
  stateRoot: string,
  workspaceIdentifier: string,
): string {
  const relative = path.join('workspaces', externalStatePathKey(workspaceIdentifier), 'sessions');
  const resolved = ensureContainedPath(stateRoot, relative);
  if (!resolved.ok) throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
  return resolved.value;
}

export function workspaceSessionProjectionPath(
  workspacePath: string,
  aggregateIdentifier: string,
): string {
  const relative = path.join(
    '.agy', 'projections', 'sessions', `${externalStatePathKey(aggregateIdentifier)}.json`,
  );
  const resolved = ensureContainedPath(workspacePath, relative);
  if (!resolved.ok) throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
  return resolved.value;
}

export function resolveStateRoot(
  options: Readonly<StateRootOptions> = {},
): Result<StateRootInfo, RuntimeError> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const configured = env.OMA_STATE_ROOT?.trim();
  let root: string;
  let source: StateRootInfo['source'];

  if (configured !== undefined && configured !== '') {
    root = path.resolve(configured);
    source = 'environment';
  } else if (platform === 'darwin') {
    root = path.join(homeDirectory, 'Library', 'Application Support', 'oh-my-agy', 'state');
    source = 'platform-default';
  } else if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    root = path.resolve(localAppData === undefined || localAppData === ''
      ? path.join(homeDirectory, 'AppData', 'Local')
      : localAppData, 'oh-my-agy', 'state');
    source = 'platform-default';
  } else {
    const xdgStateHome = env.XDG_STATE_HOME?.trim();
    root = path.resolve(xdgStateHome === undefined || xdgStateHome === ''
      ? path.join(homeDirectory, '.local', 'state')
      : xdgStateHome, 'oh-my-agy');
    source = 'platform-default';
  }

  try {
    const existed = fs.existsSync(root);
    if (existed && fs.lstatSync(root).isSymbolicLink()) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State root must not be a symbolic link', { root }));
    }
    if (options.create !== false && !existed) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(root)) return ok({ path: root, source });

    const stat = fs.lstatSync(root);
    if (!stat.isDirectory()) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State root must be a directory', { root }));
    }
    const expectedUid = options.expectedUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
    if (expectedUid !== undefined && stat.uid !== expectedUid) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State root is owned by another user', {
        root, expectedUid, actualUid: stat.uid,
      }));
    }
    if ((stat.mode & 0o077) !== 0) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State root permissions must be owner-only', {
        root, mode: (stat.mode & 0o777).toString(8),
      }));
    }
    return ok({ path: fs.realpathSync(root), source });
  } catch (error) {
    return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State root could not be validated', {
      root, cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function resolveWorkspaceIdentity(
  workspacePath: string,
): Result<WorkspaceIdentityV1, RuntimeError> {
  try {
    const canonicalInput = fs.realpathSync(path.resolve(workspacePath));
    const topLevel = runGit(canonicalInput, ['rev-parse', '--show-toplevel']);
    if (!topLevel.ok) {
      return ok({
        repoKey: null,
        workspaceKey: sha256(canonicalInput),
        canonicalPath: canonicalInput,
        workspacePath: canonicalInput,
        gitCommonDir: null,
        isGit: false,
      });
    }
    const canonicalWorkspace = fs.realpathSync(path.resolve(canonicalInput, topLevel.value));
    const common = runGit(canonicalWorkspace, ['rev-parse', '--git-common-dir']);
    if (!common.ok) {
      return err(runtimeError('E_CORRUPT_STATE', 'Git common directory could not be resolved', {
        workspacePath: canonicalWorkspace,
      }));
    }
    const canonicalCommon = fs.realpathSync(path.resolve(canonicalWorkspace, common.value));
    return ok({
      repoKey: sha256(canonicalCommon),
      workspaceKey: sha256(canonicalWorkspace),
      canonicalPath: canonicalWorkspace,
      workspacePath: canonicalWorkspace,
      gitCommonDir: canonicalCommon,
      isGit: true,
    });
  } catch (error) {
    return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Workspace path could not be canonicalized', {
      workspacePath, cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function ensureContainedPath(
  rootPath: string,
  relativePath: string,
): Result<string, RuntimeError> {
  if (relativePath === '' || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State path must be a non-empty relative path', {
      relativePath,
    }));
  }
  const root = path.resolve(rootPath);
  const normalized = path.normalize(relativePath);
  const target = path.resolve(root, normalized);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)
    || (target !== root && !target.startsWith(`${root}${path.sep}`))) {
    return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State path escapes the state root', { relativePath }));
  }
  try {
    if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State root must not be a symbolic link', { root }));
    }
    let current = root;
    for (const segment of normalized.split(path.sep)) {
      current = path.join(current, segment);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
        return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State path contains a symbolic link', {
          relativePath, entry: current,
        }));
      }
    }
    return ok(target);
  } catch (error) {
    return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'State path could not be validated', {
      relativePath, cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function verifyStateRootIgnoredForWrite(
  stateRoot: string,
  workspacePath: string,
): Result<void, RuntimeError> {
  const identity = resolveWorkspaceIdentity(workspacePath);
  if (!identity.ok) return identity;
  if (!identity.value.isGit) return ok(undefined);
  const root = canonicalizeProspectivePath(stateRoot);
  const workspace = identity.value.workspacePath;
  if (root !== workspace && !root.startsWith(`${workspace}${path.sep}`)) return ok(undefined);
  const ignoreProbe = fs.existsSync(root) ? root : path.join(root, '.oma-write-check');
  const check = spawnSync('git', ['-C', workspace, 'check-ignore', '-q', '--no-index', '--', ignoreProbe], {
    encoding: 'utf8',
  });
  if (check.status !== 0) {
    return err(runtimeError('E_STATE_ROOT_TRACKED', 'State root inside a worktree must already be ignored', {
      stateRoot: root, workspacePath: workspace,
    }));
  }
  return ok(undefined);
}

function canonicalizeProspectivePath(inputPath: string): string {
  const absolute = path.resolve(inputPath);
  let ancestor = absolute;
  const suffix: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return absolute;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

function runGit(cwd: string, argv: readonly string[]): Result<string, RuntimeError> {
  const result = spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8' });
  if (result.status !== 0 || result.stdout.trim() === '') {
    return err(runtimeError('E_GIT_REQUIRED', 'Git identity is unavailable', {
      cwd, argv, exitCode: result.status, stderr: result.stderr.trim(),
    }));
  }
  return ok(result.stdout.trim());
}
