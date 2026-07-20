/**
 * 設計概念映射：OMC/OMX 的 skill 發現面；OMA 以 `oma skill list|show` 供 session 內 agent 使用。
 */
import { listWorkflowSkillNames, loadSkillMarkdown, OmaWorkflowSkill } from '../modes/skill-loader';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';

export type ParsedSkillCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'show'; readonly name: string }
  | { readonly kind: 'help' };

export function parseSkillCommand(argv: readonly string[]): Result<ParsedSkillCommand, RuntimeError> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    return ok({ kind: 'help' });
  }
  if (argv[0] === 'list' && argv.length === 1) return ok({ kind: 'list' });
  if (argv[0] === 'show' && argv.length === 2 && argv[1].trim() !== '') {
    return ok({ kind: 'show', name: argv[1].trim() });
  }
  return err(runtimeError(
    'E_VALIDATOR_REJECTED',
    'Usage: oma skill list | oma skill show <name> | oma skill help',
  ));
}

export function runSkillCommand(
  command: ParsedSkillCommand,
  packageRoot: string,
): Result<unknown, RuntimeError> {
  if (command.kind === 'help') {
    return ok({
      usage: [
        'oma skill list',
        'oma skill show <name>',
        'oma skill help',
      ],
      note: 'Session skills ship under package skills/. Managed launches inject protocol for the active phase.',
    });
  }
  if (command.kind === 'list') {
    const names = listWorkflowSkillNames(packageRoot);
    return ok({
      packageRoot,
      skills: names.map((name) => ({
        name,
        path: `skills/${name}/SKILL.md`,
      })),
    });
  }
  const body = loadSkillMarkdown(packageRoot, command.name as OmaWorkflowSkill);
  if (body === null) {
    return err(runtimeError('E_NOT_FOUND', `Unknown skill: ${command.name}`, {
      available: listWorkflowSkillNames(packageRoot),
    }));
  }
  return ok({
    name: command.name,
    path: `skills/${command.name}/SKILL.md`,
    markdown: body,
  });
}
