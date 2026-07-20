/**
 * 設計概念映射：將 OMC/OMX session skill 契約附加在 managed directive 之後
 *（OMA_TASK 分隔符外），使 agy session 內 agent 必讀 workflow，而非只靠 CLI 開關。
 */
import { ManagedMode } from './directives';
import {
  compactSkillForInjection,
  loadSkillMarkdown,
  skillNameForManagedMode,
} from './skill-loader';

const PROTOCOL_START = '<<<OMA_SKILL_PROTOCOL';
const PROTOCOL_END = '<<<OMA_SKILL_PROTOCOL_END>>>';

export function appendSkillProtocol(
  directive: string,
  mode: ManagedMode,
  packageRoot: string | undefined,
): string {
  if (packageRoot === undefined || packageRoot.trim() === '') return directive;
  const skill = skillNameForManagedMode(mode);
  const body = loadSkillMarkdown(packageRoot, skill);
  if (body === null) return directive;
  const compact = compactSkillForInjection(body);
  const block = [
    `${PROTOCOL_START} mode=${mode} skill=${skill}>>>`,
    'You are inside an OMA managed session. Follow this skill protocol for the whole run.',
    'Do not treat the CLI wrapper alone as completion — execute the skill steps with evidence.',
    '',
    compact,
    PROTOCOL_END,
  ].join('\n');
  if (directive.includes(PROTOCOL_START)) return directive;
  return `${directive}\n\n${block}`;
}

export function extractSkillProtocol(directive: string): string | null {
  const start = directive.indexOf(PROTOCOL_START);
  if (start < 0) return null;
  const end = directive.indexOf(PROTOCOL_END, start);
  if (end < 0) return null;
  return directive.slice(start, end + PROTOCOL_END.length);
}
