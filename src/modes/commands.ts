import { RuntimeError } from '../runtime/errors';
import { Result } from '../runtime/types';
import {
  ManagedMode,
  ModeDirectiveRenderer,
  RenderedModeDirective,
  specIdForMode,
} from './directives';

export interface ModeCommandInput {
  readonly mode: ManagedMode;
  readonly task: string;
}

export function buildModeCommand(
  input: Readonly<ModeCommandInput>,
  renderer: ModeDirectiveRenderer = new ModeDirectiveRenderer(),
): Result<RenderedModeDirective, RuntimeError> {
  return renderer.render(specIdForMode(input.mode), Buffer.from(input.task, 'utf8'));
}

export interface RepositoryWorkflowCommandInput {
  readonly workflowName: string;
  readonly inputPath: string;
}

/** Build argv only; W6 owns the public CLI parser/route that executes it. */
export function buildRepositoryWorkflowArgv(
  input: Readonly<RepositoryWorkflowCommandInput>,
): readonly string[] {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.workflowName)) {
    throw new Error('Workflow name must be canonical kebab-case');
  }
  if (input.inputPath.trim() === '' || input.inputPath.includes('\0')) {
    throw new Error('Workflow input path must be non-empty and NUL-free');
  }
  return ['workflow', 'run', input.workflowName, '--input', input.inputPath];
}
