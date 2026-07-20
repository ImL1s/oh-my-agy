import * as fs from 'fs';
import * as path from 'path';
import { runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import {
  CanonicalTeamManifestV1,
  CanonicalTeamTaskV1,
  TEAM_MANIFEST_SCHEMA,
  TeamManifestV1,
  TeamTaskMode,
  TeamTaskSpecV1,
  TeamVerificationCommandV1,
  TeamWriteScopeEntryV1,
  TeamWriteScopeV1,
} from './types';

export function validateTeamManifest(
  input: unknown,
  repoRoot: string,
): Result<CanonicalTeamManifestV1> {
  const canonicalRoot = safeRealpath(repoRoot);
  if (canonicalRoot === null) {
    return err(runtimeError('E_MANIFEST_INVALID', 'Repository root does not exist', { repoRoot }));
  }
  if (!isRecord(input) || input.schema !== TEAM_MANIFEST_SCHEMA) {
    return invalid('Manifest schema must be oma.team-manifest/v1');
  }
  if (!isIdentifier(input.teamId) || !Number.isInteger(input.revision) || Number(input.revision) < 0) {
    return invalid('Manifest teamId or revision is invalid');
  }
  if (!Array.isArray(input.tasks)) return invalid('Manifest tasks must be an array');

  const tasks: CanonicalTeamTaskV1[] = [];
  const ids = new Set<string>();
  for (const rawTask of input.tasks) {
    const parsed = parseTask(rawTask, canonicalRoot);
    if (!parsed.ok) return parsed;
    if (ids.has(parsed.value.id)) return invalid('Manifest task IDs must be unique', { taskId: parsed.value.id });
    ids.add(parsed.value.id);
    tasks.push(parsed.value);
  }

  for (const task of tasks) {
    if (new Set(task.dependencies).size !== task.dependencies.length || task.dependencies.includes(task.id)) {
      return invalid('Task dependencies must be unique and cannot reference the task itself', { taskId: task.id });
    }
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) return invalid('Task dependency does not exist', { taskId: task.id, dependency });
    }
  }
  if (containsCycle(tasks)) return invalid('Manifest dependency graph must be acyclic');

  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex++) {
      const left = tasks[leftIndex];
      const right = tasks[rightIndex];
      if (!scopesOverlap(left.write_scope, right.write_scope)) continue;
      if (!dependsTransitively(left.id, right.id, tasks) && !dependsTransitively(right.id, left.id, tasks)) {
        return err(runtimeError('E_TASK_SCOPE_OVERLAP', 'Overlapping write scopes require dependency ordering', {
          leftTaskId: left.id,
          rightTaskId: right.id,
        }));
      }
    }
  }

  return ok({
    schema: TEAM_MANIFEST_SCHEMA,
    teamId: input.teamId,
    revision: input.revision,
    repoRoot: canonicalRoot,
    tasks,
  });
}

function parseTask(input: unknown, repoRoot: string): Result<CanonicalTeamTaskV1> {
  if (!isRecord(input) || !isIdentifier(input.id) || !Array.isArray(input.dependencies)) {
    return invalid('Task identity or dependencies are invalid');
  }
  if (!input.dependencies.every(isIdentifier)) return invalid('Task dependency IDs are invalid', { taskId: input.id });
  if (!isTaskMode(input.mode)) return invalid('Task mode is invalid', { taskId: input.id });
  const scope = parseScope(input.write_scope, repoRoot);
  if (!scope.ok) return scope;
  if (input.mode === 'read_only' && scope.value !== 'none') {
    return invalid('Read-only tasks must use write_scope none', { taskId: input.id });
  }
  if (input.mode !== 'read_only' && scope.value === 'none') {
    return invalid('Writable task modes require an explicit write scope', { taskId: input.id });
  }
  const verification = parseVerification(input.verification, repoRoot);
  if (!verification.ok) return verification;
  return ok({
    id: input.id,
    dependencies: [...input.dependencies],
    write_scope: scope.value,
    mode: input.mode,
    verification: verification.value,
  });
}

function parseScope(input: unknown, repoRoot: string): Result<TeamWriteScopeV1> {
  if (input === 'none') return ok('none');
  if (!Array.isArray(input) || input.length === 0) return invalid('Write scope must be none or a non-empty array');
  const entries: TeamWriteScopeEntryV1[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!isRecord(raw) || (raw.kind !== 'file' && raw.kind !== 'dir')) {
      return invalid('Write scope entry kind is invalid');
    }
    const canonical = canonicalRelativePath(raw.path, repoRoot);
    if (!canonical.ok) return canonical;
    const key = `${raw.kind}:${canonical.value}`;
    if (seen.has(key)) return invalid('Write scope entries must be unique', { path: canonical.value });
    seen.add(key);
    entries.push({ kind: raw.kind, path: canonical.value });
  }
  return ok(entries.sort((left, right) => left.path.localeCompare(right.path)));
}

function parseVerification(input: unknown, repoRoot: string): Result<TeamTaskSpecV1['verification']> {
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.commands) || !Array.isArray(input.requiredArtifacts)) {
    return invalid('Task verification contract is invalid');
  }
  const commands: TeamVerificationCommandV1[] = [];
  for (const raw of input.commands) {
    if (
      !isRecord(raw)
      || !isIdentifier(raw.command)
      || !Array.isArray(raw.argv)
      || !raw.argv.every((value) => typeof value === 'string' && !value.includes('\0'))
      || typeof raw.deadlineMs !== 'number'
      || !Number.isFinite(raw.deadlineMs)
      || raw.deadlineMs <= 0
      || !Number.isInteger(raw.expectedExit)
    ) {
      return invalid('Verification command is invalid');
    }
    const cwd = raw.cwd === '.' ? ok('.') : canonicalRelativePath(raw.cwd, repoRoot);
    if (!cwd.ok) return cwd;
    commands.push({
      command: raw.command,
      argv: [...raw.argv],
      cwd: cwd.value,
      deadlineMs: raw.deadlineMs,
      expectedExit: raw.expectedExit,
    });
  }
  const artifacts: string[] = [];
  for (const artifact of input.requiredArtifacts) {
    const canonical = canonicalRelativePath(artifact, repoRoot);
    if (!canonical.ok) return canonical;
    artifacts.push(canonical.value);
  }
  return ok({ version: 1, commands, requiredArtifacts: artifacts });
}

export function canonicalRelativePath(value: unknown, repoRoot: string): Result<string> {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || value.includes('\\')) {
    return invalid('Manifest path must be a non-empty relative POSIX path');
  }
  if (path.posix.isAbsolute(value) || path.isAbsolute(value)) return invalid('Absolute manifest paths are forbidden', { path: value });
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return invalid('Manifest path traversal or empty segments are forbidden', { path: value });
  }
  const normalized = path.posix.normalize(value);
  const target = path.resolve(repoRoot, ...normalized.split('/'));
  if (!isContained(repoRoot, target)) return invalid('Manifest path escapes the repository', { path: value });
  const resolved = resolveThroughExistingAncestor(target);
  if (resolved === null || !isContained(repoRoot, resolved)) {
    return invalid('Manifest path resolves outside the repository', { path: value });
  }
  return ok(normalized);
}

export function scopeContainsPath(scope: TeamWriteScopeV1, candidate: string): boolean {
  if (scope === 'none') return false;
  const normalized = path.posix.normalize(candidate);
  return scope.some((entry) => entry.kind === 'file'
    ? entry.path === normalized
    : entry.path === normalized || normalized.startsWith(`${entry.path}/`));
}

function scopesOverlap(left: TeamWriteScopeV1, right: TeamWriteScopeV1): boolean {
  if (left === 'none' || right === 'none') return false;
  return left.some((a) => right.some((b) => entriesOverlap(a, b)));
}

function entriesOverlap(left: TeamWriteScopeEntryV1, right: TeamWriteScopeEntryV1): boolean {
  if (left.path === right.path) return true;
  if (left.kind === 'dir' && right.path.startsWith(`${left.path}/`)) return true;
  if (right.kind === 'dir' && left.path.startsWith(`${right.path}/`)) return true;
  return false;
}

function containsCycle(tasks: readonly CanonicalTeamTaskV1[]): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => visit(task.id));
}

function dependsTransitively(taskId: string, dependencyId: string, tasks: readonly CanonicalTeamTaskV1[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const pending = [...(byId.get(taskId)?.dependencies ?? [])];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === dependencyId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(byId.get(current)?.dependencies ?? []));
  }
  return false;
}

function resolveThroughExistingAncestor(target: string): string | null {
  let current = target;
  const suffix: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.resolve(fs.realpathSync(current), ...suffix);
  } catch (_) {
    return null;
  }
}

function safeRealpath(target: string): string | null {
  try { return fs.realpathSync(target); } catch (_) { return null; }
}

function isContained(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function isTaskMode(value: unknown): value is TeamTaskMode {
  return value === 'interactive' || value === 'headless' || value === 'read_only';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !value.includes('\0');
}

function invalid<T>(message: string, details?: Readonly<Record<string, unknown>>): Result<T> {
  return err(runtimeError('E_MANIFEST_INVALID', message, details));
}

