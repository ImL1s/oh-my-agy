import * as fs from 'fs';
import * as path from 'path';
import { canonicalJson } from '../runtime/atomic';
import { StopHookDecision } from '../continuation/decision';
import { LifecycleEventType, LifecycleEventV1, validateLifecycleEvent } from '../contracts/lifecycle';
import { createLifecycleEvent, LifecycleJournal } from '../runtime/tracker';

/**
 * Operator kill switch。設計概念映射：OMC `scripts/run.cjs` 的 `DISABLE_OMC` /
 * `OMC_SKIP_HOOKS`，以及 OMG `hooks/bin/*.py` 的 `DISABLE_OMG` / `OMG_SKIP_HOOKS`。
 *
 * 存在理由：managed session（binding env 齊備）中 hook 一定會執行；若 Stop hook
 * hang 住或錯誤回傳 continue，使用者原本唯一的出路是去改安裝目錄的 hooks.json 或
 * 整包解除安裝。這是 hook lane 最便宜的 operator safety。
 */
export type HookNameV1 = 'pre-invocation' | 'stop' | 'session-start' | 'post-invocation';

/** kill switch 命中時寫入 lifecycle 的 source，讓「被關掉」與「fail-open」可區分。 */
export const HOOK_OPERATOR_DISABLED_SOURCE_V1 = 'operator_disabled';

function isTruthyFlag(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/** `DISABLE_OMA=1|true`（大小寫不敏感）時關閉全部 hook。 */
export function hooksDisabled(environment: Readonly<NodeJS.ProcessEnv> = process.env): boolean {
  return isTruthyFlag(environment.DISABLE_OMA);
}

/**
 * `OMA_SKIP_HOOKS` 以逗號分隔的邏輯 hook 名跳過個別 hook；
 * 容忍空白與大小寫（`" stop , Pre-Invocation "` 有效）。
 */
export function hookSkipped(
  name: HookNameV1,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  const raw = environment.OMA_SKIP_HOOKS;
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
    .includes(name);
}

/** 全域關閉或個別跳過任一成立時，該 hook 不得執行任何解析或狀態寫入。 */
export function hookSuppressed(
  name: HookNameV1,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  return hooksDisabled(environment) || hookSkipped(name, environment);
}

export function serializeHookDecision(decision: Readonly<StopHookDecision>): string {
  if (decision.decision === 'continue' && decision.reason.trim() === '') {
    return canonicalJson({ decision: 'allow' });
  }
  return canonicalJson(decision);
}

export interface HookLifecycleAppendInput {
  eventType: LifecycleEventType;
  runId: string;
  generation: number;
  parentId: string | null;
  nativeIdentity: string | null;
  payload: unknown;
  observedAt?: string;
  source?: string;
}

export function appendHookLifecycleEvent(
  journalPath: string,
  input: Readonly<HookLifecycleAppendInput>,
): LifecycleEventV1 {
  const source = input.source ?? 'antigravity_hook';
  const journal = new LifecycleJournal(journalPath, source);
  return journal.appendNext((sequence) => createLifecycleEvent({
    source,
    sourceSequence: sequence,
    eventType: input.eventType,
    repositoryId: 'OMA',
    runId: input.runId,
    generation: input.generation,
    parentId: input.parentId,
    nativeIdentity: input.nativeIdentity,
    payload: input.payload,
    observedAt: input.observedAt ?? new Date().toISOString(),
  }), (candidate, event) => candidate.event_type === event.event_type
    && candidate.run_id === event.run_id
    && candidate.generation === event.generation
    && candidate.parent_id === event.parent_id
    && candidate.native_identity === event.native_identity
    && candidate.payload_hash === event.payload_hash);
}

export function readHookLifecycleEvents(journalPath: string): LifecycleEventV1[] {
  if (!fs.existsSync(journalPath)) return [];
  const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
  return lines.map((line) => validateLifecycleEvent(JSON.parse(line)));
}

/** kill switch 專用 journal；與 `hooks.jsonl`（source `antigravity_hook`）分離以免 source 混寫。 */
export function operatorDisabledJournalPath(stateRoot: string): string {
  return path.join(stateRoot, 'lifecycle', 'operator-disabled.jsonl');
}

/**
 * 僅在 `OMA_STATE_ROOT` **已經存在**時寫入 `source: operator_disabled`。
 * 不得呼叫 `resolveStateRoot`（PreInvocation 的 create:true 會mkdir 預設路徑）；
 * 路徑不存在就跳過，寧可沒紀錄也不要為了寫紀錄去建立 state root。
 */
export function appendOperatorDisabledLifecycle(
  name: HookNameV1,
  environment: Readonly<NodeJS.ProcessEnv>,
): LifecycleEventV1 | undefined {
  const root = environment.OMA_STATE_ROOT?.trim();
  if (!root) return undefined;
  try {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  try {
    const generationRaw = environment.OMA_INVOCATION_GENERATION?.trim();
    const parsed = Number.parseInt(generationRaw ?? '', 10);
    return appendHookLifecycleEvent(operatorDisabledJournalPath(root), {
      eventType: 'turn_completed',
      runId: environment.OMA_SESSION_ID?.trim() || 'operator-disabled',
      generation: Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1,
      parentId: null,
      nativeIdentity: null,
      payload: { hook: name, suppressed: true },
      source: HOOK_OPERATOR_DISABLED_SOURCE_V1,
    });
  } catch {
    return undefined;
  }
}

export interface ShellRedirectionAst {
  fd: number | null;
  operator: '>' | '>>' | '<' | '<<';
  target: string;
}

export interface ShellCommandAst {
  words: string[];
  redirections: ShellRedirectionAst[];
  substitutions: ShellAst[];
}

export interface ShellAst {
  commands: ShellCommandAst[];
}

export interface ShellWriteClassification {
  writes: boolean;
  reasons: string[];
  ast: ShellAst;
}

/**
 * Parse enough POSIX shell structure to classify writes without executing or
 * regex-matching the raw command. Heredoc bodies are input nodes, pipelines
 * are separate commands, and command substitutions are recursively parsed.
 */
export function parseShellAst(source: string): ShellAst {
  const tokens = tokenizeShell(stripHeredocBodies(source));
  const commands: ShellCommandAst[] = [];
  let command: ShellCommandAst = { words: [], redirections: [], substitutions: [] };
  const flush = () => {
    if (command.words.length > 0 || command.redirections.length > 0 || command.substitutions.length > 0) {
      commands.push(command);
    }
    command = { words: [], redirections: [], substitutions: [] };
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (['|', '||', '&&', ';', '\n'].includes(token)) {
      flush();
      continue;
    }
    const redirect = /^(?:(\d+))?(>>?|<<|<)$/.exec(token);
    if (redirect !== null) {
      command.redirections.push({
        fd: redirect[1] === undefined ? null : Number(redirect[1]),
        operator: redirect[2] as ShellRedirectionAst['operator'],
        target: tokens[index + 1] ?? '',
      });
      index += 1;
      continue;
    }
    command.words.push(token);
    for (const body of substitutionBodies(token)) command.substitutions.push(parseShellAst(body));
  }
  flush();
  return { commands };
}

export function classifyShellWrite(source: string): ShellWriteClassification {
  const ast = parseShellAst(source);
  const reasons: string[] = [];
  classifyAst(ast, reasons);
  return { writes: reasons.length > 0, reasons: [...new Set(reasons)], ast };
}

function classifyAst(ast: ShellAst, reasons: string[]): void {
  const mutators = new Set([
    'rm', 'mv', 'cp', 'install', 'touch', 'mkdir', 'rmdir', 'ln', 'chmod', 'chown',
    'truncate', 'dd', 'patch', 'apply_patch', 'rsync', 'scp', 'curl', 'wget',
  ]);
  const gitMutators = new Set([
    'add', 'apply', 'am', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge',
    'mv', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'tag',
  ]);
  for (const command of ast.commands) {
    for (const redirect of command.redirections) {
      if ((redirect.operator === '>' || redirect.operator === '>>')
        && normalizeShellWord(redirect.target) !== '/dev/null') {
        reasons.push(`redirect:${redirect.target || '<missing>'}`);
      }
    }
    const words = command.words.map(normalizeShellWord).filter(Boolean);
    const executable = words[0]?.split('/').pop() ?? '';
    if (mutators.has(executable)) reasons.push(`command:${executable}`);
    if (executable === 'git' && words[1] && gitMutators.has(words[1])) reasons.push(`git:${words[1]}`);
    if (executable === 'sed' && words.some((word) => word === '-i' || word.startsWith('-i'))) {
      reasons.push('command:sed-in-place');
    }
    if (executable === 'tee') {
      const targets = words.slice(1).filter((word) => !word.startsWith('-'));
      if (targets.some((target) => target !== '/dev/null')) reasons.push('command:tee');
    }
    command.substitutions.forEach((substitution) => classifyAst(substitution, reasons));
  }
}

function tokenizeShell(source: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let substitutionDepth = 0;
  const flush = () => { if (current !== '') { tokens.push(current); current = ''; } };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      current += character;
      if (character === quote && source[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    if (character === '$' && source[index + 1] === '(') {
      substitutionDepth += 1;
      current += '$(';
      index += 1;
      continue;
    }
    if (character === ')' && substitutionDepth > 0) { substitutionDepth -= 1; current += character; continue; }
    if (substitutionDepth > 0) { current += character; continue; }
    if (/\s/.test(character)) {
      flush();
      if (character === '\n') tokens.push('\n');
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (['||', '&&', '>>', '<<'].includes(pair)) {
      flush();
      const fd = tokens.length > 0 && /^\d+$/.test(tokens[tokens.length - 1])
        ? tokens.pop() : undefined;
      tokens.push(`${fd ?? ''}${pair}`);
      index += 1;
      continue;
    }
    if (['|', ';', '>', '<'].includes(character)) {
      flush();
      const fd = tokens.length > 0 && /^\d+$/.test(tokens[tokens.length - 1])
        ? tokens.pop() : undefined;
      tokens.push(`${fd ?? ''}${character}`);
      continue;
    }
    current += character;
  }
  flush();
  return tokens;
}

function stripHeredocBodies(source: string): string {
  const lines = source.split('\n');
  const output: string[] = [];
  let delimiter: string | null = null;
  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    output.push(line);
    const match = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (match !== null) delimiter = match[1];
  }
  return output.join('\n');
}

function substitutionBodies(token: string): string[] {
  const bodies: string[] = [];
  for (let index = 0; index < token.length - 1; index += 1) {
    if (token[index] !== '$' || token[index + 1] !== '(') continue;
    let depth = 1;
    let cursor = index + 2;
    for (; cursor < token.length; cursor += 1) {
      if (token[cursor] === '(') depth += 1;
      if (token[cursor] === ')') depth -= 1;
      if (depth === 0) break;
    }
    if (depth === 0) bodies.push(token.slice(index + 2, cursor));
    index = cursor;
  }
  return bodies;
}

function normalizeShellWord(word: string): string {
  if ((word.startsWith("'") && word.endsWith("'"))
    || (word.startsWith('"') && word.endsWith('"'))) return word.slice(1, -1);
  return word;
}
