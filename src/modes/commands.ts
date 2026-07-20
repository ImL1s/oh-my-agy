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
