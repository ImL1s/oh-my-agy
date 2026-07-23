import * as fs from 'fs';
import * as path from 'path';
import {
  RepositoryWorkflowV1,
  assertWorkflowHistory,
  validateRepositoryWorkflow,
} from '../contracts/repository-workflow';

export class RepositoryWorkflowRegistryV1 {
  private readonly byName = new Map<string, RepositoryWorkflowV1[]>();

  register(rawDefinition: unknown): RepositoryWorkflowV1 {
    const definition = validateRepositoryWorkflow(rawDefinition as RepositoryWorkflowV1);
    const history = this.byName.get(definition.name) ?? [];
    const sameVersion = history.find((entry) => entry.workflow_version === definition.workflow_version);
    if (sameVersion !== undefined) {
      assertWorkflowHistory(sameVersion, definition);
      return sameVersion;
    }
    const previous = history.at(-1);
    if (previous !== undefined) assertWorkflowHistory(previous, definition);
    const next = [...history, deepClone(definition)];
    this.byName.set(definition.name, next);
    return deepClone(definition);
  }

  get(name: string, version?: string): RepositoryWorkflowV1 {
    const history = this.byName.get(name);
    if (history === undefined || history.length === 0) {
      throw new Error(`E_WORKFLOW_NOT_FOUND: ${name}`);
    }
    const selected = version === undefined
      ? history.at(-1)
      : history.find((entry) => entry.workflow_version === version);
    if (selected === undefined) throw new Error(`E_WORKFLOW_NOT_FOUND: ${name}@${version}`);
    return deepClone(selected);
  }

  list(): Array<{ name: string; versions: string[]; latest_digest: string }> {
    return [...this.byName.entries()]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([name, history]) => ({
        name,
        versions: history.map((entry) => entry.workflow_version),
        latest_digest: (history.at(-1) as RepositoryWorkflowV1).definition_digest,
      }));
  }
}

export function loadWorkflowRegistryFromDirectory(directory: string): RepositoryWorkflowRegistryV1 {
  const root = fs.realpathSync(path.resolve(directory));
  const registry = new RepositoryWorkflowRegistryV1();
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) {
      throw new Error(`E_WORKFLOW_REGISTRY: unsafe workflow file ${entry.name}`);
    }
    const resolved = fs.realpathSync(candidate);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`E_WORKFLOW_REGISTRY: workflow file escaped registry ${entry.name}`);
    }
    registry.register(JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown);
  }
  return registry;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
