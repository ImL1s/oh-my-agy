/**
 * 設計概念映射：OMC/OMX 的 skills + skill-bodies 面；OMA 以 plugin `skills/<name>/SKILL.md`
 * 作為 session 內 workflow 契約，並在 managed launch 注入協議正文。
 */
import * as fs from 'fs';
import * as path from 'path';
import { ManagedMode } from './directives';

export type OmaWorkflowSkill =
  | ManagedMode
  | 'autopilot'
  | 'team'
  | 'cancel'
  | 'verify'
  | 'setup'
  | 'doctor'
  | 'oma-runtime';

const MODE_TO_SKILL: Readonly<Record<ManagedMode, OmaWorkflowSkill>> = Object.freeze({
  ralph: 'ralph',
  ultrawork: 'ultrawork',
  search: 'search',
});

export function skillNameForManagedMode(mode: ManagedMode): OmaWorkflowSkill {
  return MODE_TO_SKILL[mode];
}

/**
 * 解析 package root 下 skills/<name>/SKILL.md。
 * 找不到時回傳 null（fail-open：managed 仍可只靠 directive clauses）。
 */
export function loadSkillMarkdown(
  packageRoot: string,
  skill: OmaWorkflowSkill,
): string | null {
  const skillPath = path.join(packageRoot, 'skills', skill, 'SKILL.md');
  try {
    if (!fs.existsSync(skillPath) || !fs.statSync(skillPath).isFile()) return null;
    const body = fs.readFileSync(skillPath, 'utf8');
    return body.trim() === '' ? null : body;
  } catch {
    return null;
  }
}

/** 截斷過長 skill，避免把整份大文件灌進 argv 上限。 */
export function compactSkillForInjection(markdown: string, maxChars = 12_000): string {
  const trimmed = markdown.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n…(skill truncated for managed injection; full text lives under skills/)`;
}

export function listWorkflowSkillNames(packageRoot: string): string[] {
  const root = path.join(packageRoot, 'skills');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(root, name, 'SKILL.md')))
    .sort();
}
