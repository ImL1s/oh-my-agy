/**
 * 設計概念映射：OMC/OMX 的 skill 發現面；OMA 以 `oma skill list|show` 供 session 內 agent 使用。
 */
import { listWorkflowSkillNames, loadSkillMarkdown, OmaWorkflowSkill } from '../modes/skill-loader';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';

/**
 * 呈現格式。未指定時預設 `text`，與 `oma doctor` 的既有慣例一致
 * （預設人類可讀，`--json` 才輸出機器格式）。
 * 設計概念映射：OMX `omx skill` 的人類可讀清單與 OMC `/oh-my-claudecode:skill` 的表格輸出。
 */
export type SkillRenderFormat = 'text' | 'json';

/** 未指定旗標時的預設呈現格式。 */
export const DEFAULT_SKILL_RENDER_FORMAT: SkillRenderFormat = 'text';

export type ParsedSkillCommand =
  | { readonly kind: 'list'; readonly format?: SkillRenderFormat }
  | { readonly kind: 'show'; readonly name: string; readonly format?: SkillRenderFormat }
  | { readonly kind: 'help'; readonly format?: SkillRenderFormat };

/** 由旗標解析明確指定的呈現格式；未指定時回傳 undefined，由呼叫端套用預設值。 */
function takeFormatFlags(
  argv: readonly string[],
): Result<{ rest: string[]; format?: SkillRenderFormat }, RuntimeError> {
  const rest: string[] = [];
  let format: SkillRenderFormat | undefined;
  for (const token of argv) {
    if (token === '--json' || token === '--text') {
      const next: SkillRenderFormat = token === '--json' ? 'json' : 'text';
      if (format !== undefined && format !== next) {
        return err(runtimeError(
          'E_VALIDATOR_REJECTED',
          'oma skill accepts only one of --json or --text',
        ));
      }
      format = next;
      continue;
    }
    rest.push(token);
  }
  return ok({ rest, format });
}

export function parseSkillCommand(argv: readonly string[]): Result<ParsedSkillCommand, RuntimeError> {
  const flags = takeFormatFlags(argv);
  if (!flags.ok) return flags;
  const { rest, format } = flags.value;
  const withFormat = <T extends { kind: string }>(value: T): T & { format?: SkillRenderFormat } =>
    (format === undefined ? value : { ...value, format });

  if (rest.length === 0 || rest[0] === 'help' || rest[0] === '--help' || rest[0] === '-h') {
    return ok(withFormat({ kind: 'help' as const }));
  }
  if (rest[0] === 'list' && rest.length === 1) return ok(withFormat({ kind: 'list' as const }));
  if (rest[0] === 'show' && rest.length === 2 && rest[1].trim() !== '') {
    return ok(withFormat({ kind: 'show' as const, name: rest[1].trim() }));
  }
  return err(runtimeError(
    'E_VALIDATOR_REJECTED',
    'Usage: oma skill list [--json|--text] | oma skill show <name> [--json|--text] | oma skill help',
  ));
}

export function runSkillCommand(
  command: ParsedSkillCommand,
  packageRoot: string,
): Result<unknown, RuntimeError> {
  if (command.kind === 'help') {
    return ok({
      usage: [
        'oma skill list [--json|--text]',
        'oma skill show <name> [--json|--text]',
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

export interface SkillListViewV1 {
  readonly packageRoot: string;
  readonly skills: ReadonlyArray<{ readonly name: string; readonly path: string }>;
}

export interface SkillShowViewV1 {
  readonly name: string;
  readonly path: string;
  readonly markdown: string;
}

export interface SkillHelpViewV1 {
  readonly usage: readonly string[];
  readonly note: string;
}

/**
 * 人類可讀輸出。與 `oma doctor` 的排版風格一致（對齊欄位 + 結尾提示下一步）。
 * 設計概念映射：OMX `omx skill` / OMC `/oh-my-claudecode:skill` 的清單呈現。
 */
export function renderSkillCommandText(command: ParsedSkillCommand, value: unknown): string {
  if (command.kind === 'help') {
    const help = value as SkillHelpViewV1;
    const lines = [
      'oma skill — session skill discovery',
      '',
      'Usage:',
      ...help.usage.map((entry) => `  ${entry}`),
      '',
      help.note,
      '',
      'Output format follows stdout: human-readable on a terminal, JSON when piped.',
      'Override with --json or --text.',
    ];
    return `${lines.join('\n')}\n`;
  }
  if (command.kind === 'list') {
    const listed = value as SkillListViewV1;
    if (listed.skills.length === 0) {
      return `oma skill list — no skills found under ${listed.packageRoot}/skills\n`;
    }
    const width = listed.skills.reduce((longest, entry) => Math.max(longest, entry.name.length), 0);
    const lines = [
      `oma skill list (${listed.skills.length} skills)`,
      `packageRoot: ${listed.packageRoot}`,
      '',
      ...listed.skills.map((entry) => `  ${entry.name.padEnd(width)}  ${entry.path}`),
      '',
      'Show one: oma skill show <name>',
    ];
    return `${lines.join('\n')}\n`;
  }
  const shown = value as SkillShowViewV1;
  const body = shown.markdown.endsWith('\n') ? shown.markdown : `${shown.markdown}\n`;
  return `# ${shown.name} — ${shown.path}\n\n${body}`;
}

/** 人類可讀錯誤輸出；`E_NOT_FOUND` 額外列出可用 skill，避免使用者要自己去翻目錄。 */
export function renderSkillErrorText(error: RuntimeError): string {
  const available = (error.details as { available?: unknown } | undefined)?.available;
  const lines = [`${error.code}: ${error.message}`];
  if (Array.isArray(available) && available.length > 0) {
    lines.push('', 'Available skills:', ...available.map((name) => `  ${String(name)}`));
    lines.push('', 'Try: oma skill show <name>');
  }
  return `${lines.join('\n')}\n`;
}
