/**
 * `oma ask` 外部顧問 broker（advisory-only、嚴格 outbound）。
 *
 * 設計概念映射：
 * - OMG `omg_cli/ask/broker.py` + `providers.py`：human-only 固定 argv、
 *   artifact `.omg/artifacts/ask-*.md`、`--dry-run` 零執行、預設不透傳 extra
 * - OMC `scripts/run-provider-advisor.js`：各廠商固定 argv（此處去掉 elevation 旗標）
 *
 * HARD RULES：
 * - 回覆永遠是 advisory，不得寫入 `.agy/autopilot` / `.agy/reviews` 或任何 gate/verdict
 * - 不得暗示 inbound-reply-injection（parity 分類為 `host_impossible`）
 * - 只許 `spawn` / `spawnSync` + argv 陣列；禁止 shell 字串組裝與 `exec`
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { redactDiagnostic } from '../runtime/redaction';
import { Result, err, ok } from '../runtime/types';
import {
  ALLOWED_CAPTURE_TOOL_NAMES,
  AllowedCaptureTool,
  isAllowedCaptureTool,
} from './allowed-tools';

export const ASK_ARTIFACT_DIR_RELATIVE = '.agy/artifacts';
export const ASK_TRANSCRIPT_MAX_BYTES = 512 * 1024;
export const ASK_FILE_MAX_BYTES = 256 * 1024;
export const ASK_SPAWN_TIMEOUT_MS = 10 * 60_000;
export const ASK_SPAWN_MAX_BUFFER = 4_194_304;
export const ASK_TRUNCATION_MARKER_PREFIX = '… [truncated: captured ';
export const ASK_ADVISORY_BANNER =
  'ADVISORY ONLY — not a verdict, not verification evidence, and not an inbound reply.';

export interface AskSpawnResultV1 {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export type AskSpawnSyncV1 = (
  command: string,
  argv: readonly string[],
  options: {
    encoding: 'utf8';
    timeout: number;
    maxBuffer: number;
    shell: false;
    windowsHide: true;
    env: NodeJS.ProcessEnv;
    cwd: string;
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => AskSpawnResultV1;

export type AskResolveExecutableV1 = (
  name: string,
  environment: NodeJS.ProcessEnv,
) => string | null;

export interface AskBrokerInput {
  readonly tool: string;
  readonly question: string;
  readonly cwd: string;
  readonly filePath?: string;
  readonly dryRun: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly spawnSync?: AskSpawnSyncV1;
  readonly resolveExecutable?: AskResolveExecutableV1;
  readonly transcriptMaxBytes?: number;
}

export interface AskBrokerResult {
  readonly tool: AllowedCaptureTool;
  readonly argv: readonly string[];
  readonly artifactPath: string;
  readonly dryRun: boolean;
  readonly truncated: boolean;
  readonly spawned: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly advisory: true;
  readonly inboundReplyInjection: 'forbidden';
}

function validatorRejected(message: string): Result<never, RuntimeError> {
  return err(runtimeError('E_VALIDATOR_REJECTED', message));
}

export function utcAskStamp(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function defaultAskArtifactPath(cwd: string, tool: AllowedCaptureTool, date: Date): string {
  return path.join(path.resolve(cwd), ASK_ARTIFACT_DIR_RELATIVE, `ask-${utcAskStamp(date)}-${tool}.md`);
}

/**
 * 固定、非 elevation 的顧問 argv。prompt 永遠是單一元素，絕不拼成 shell 字串。
 * Codex 對齊 OMG read-only；其餘對齊 OMC 的 flag 形狀但拿掉 yolo / skip-permissions。
 */
export function buildAskArgv(tool: AllowedCaptureTool, question: string): string[] {
  switch (tool) {
    case 'codex':
      return ['codex', 'exec', '-s', 'read-only', question];
    case 'claude':
      return ['claude', '-p', question];
    case 'grok':
      return ['grok', '-p', question];
    case 'agy':
      return ['agy', '-p', question];
    case 'cursor-agent':
      return ['cursor-agent', '--print', question];
  }
}

export function runAskBroker(
  input: Readonly<AskBrokerInput>,
): Result<AskBrokerResult, RuntimeError> {
  const toolRaw = input.tool;
  if (path.basename(toolRaw) !== toolRaw || !isAllowedCaptureTool(toolRaw)) {
    return validatorRejected(
      `unknown ask tool ${JSON.stringify(toolRaw)}; expected one of: ${ALLOWED_CAPTURE_TOOL_NAMES.join(', ')}`,
    );
  }
  const tool: AllowedCaptureTool = toolRaw;
  const cwd = path.resolve(input.cwd);
  const attached = input.filePath === undefined
    ? ok('')
    : readAttachedFile(input.filePath, cwd);
  if (!attached.ok) return attached;

  const combinedQuestion = attached.value === ''
    ? input.question
    : `${input.question}\n\n## Attached file\n\n${attached.value}`;
  const redactedQuestion = redactDiagnostic(combinedQuestion, ASK_FILE_MAX_BYTES + 8_192);
  if (redactedQuestion.trim() === '') {
    return validatorRejected('oma ask requires a non-empty question');
  }

  const plannedArgv = buildAskArgv(tool, redactedQuestion);
  const resolve = input.resolveExecutable ?? resolveAskExecutable;
  const resolved = resolve(tool, input.environment);
  const command = resolved ?? plannedArgv[0]!;
  const spawnArgv = plannedArgv.slice(1);
  const displayArgv = [command, ...spawnArgv];
  const now = input.now ?? (() => new Date());
  const observedAt = now();
  const artifactPath = defaultAskArtifactPath(cwd, tool, observedAt);
  const maxBytes = input.transcriptMaxBytes ?? ASK_TRANSCRIPT_MAX_BYTES;

  if (input.dryRun) {
    const written = writeAskArtifact({
      artifactPath,
      tool,
      observedAt,
      argv: displayArgv,
      cwd,
      exitCode: 0,
      durationMs: 0,
      dryRun: true,
      truncated: false,
      prompt: redactedQuestion,
      response: '(dry-run: provider not executed)',
    });
    if (!written.ok) return written;
    return ok({
      tool,
      argv: displayArgv,
      artifactPath,
      dryRun: true,
      truncated: false,
      spawned: false,
      exitCode: 0,
      durationMs: 0,
      advisory: true,
      inboundReplyInjection: 'forbidden',
    });
  }

  if (resolved === null) {
    return err(runtimeError(
      'E_NOT_FOUND',
      `ask executable ${tool} could not be resolved safely on PATH`,
      { tool },
    ));
  }

  const started = Date.now();
  const spawn = input.spawnSync ?? defaultAskSpawnSync;
  const outcome = spawn(command, spawnArgv, {
    encoding: 'utf8',
    timeout: ASK_SPAWN_TIMEOUT_MS,
    maxBuffer: ASK_SPAWN_MAX_BUFFER,
    shell: false,
    windowsHide: true,
    env: input.environment,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const durationMs = Date.now() - started;
  const stdout = outcome.stdout ?? '';
  const stderr = outcome.stderr ?? '';
  const combined = stderr === '' ? stdout : (stdout === '' ? stderr : `${stdout}\n${stderr}`);
  const capturedBytes = Buffer.byteLength(combined, 'utf8');
  const { text: transcript, truncated } = truncateTranscript(combined, maxBytes, capturedBytes);
  const exitCode = outcome.error !== undefined
    ? 1
    : (outcome.status ?? 1);
  const written = writeAskArtifact({
    artifactPath,
    tool,
    observedAt,
    argv: displayArgv,
    cwd,
    exitCode,
    durationMs,
    dryRun: false,
    truncated,
    prompt: redactedQuestion,
    response: transcript,
  });
  if (!written.ok) return written;
  return ok({
    tool,
    argv: displayArgv,
    artifactPath,
    dryRun: false,
    truncated,
    spawned: true,
    exitCode,
    durationMs,
    advisory: true,
    inboundReplyInjection: 'forbidden',
  });
}

function writeAskArtifact(input: {
  readonly artifactPath: string;
  readonly tool: AllowedCaptureTool;
  readonly observedAt: Date;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly dryRun: boolean;
  readonly truncated: boolean;
  readonly prompt: string;
  readonly response: string;
}): Result<void, RuntimeError> {
  const directory = path.dirname(input.artifactPath);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const body = [
      `# oma ask — ${input.tool}`,
      '',
      `> **${ASK_ADVISORY_BANNER}**`,
      '>',
      '> This transcript must not be copied into `.agy/autopilot` or `.agy/reviews`,',
      '> must not close a gate, and must not be treated as an inbound reply loop',
      '> (`inbound-reply-injection` is host_impossible).',
      '',
      `- ts: ${input.observedAt.toISOString()}`,
      `- tool: ${input.tool}`,
      `- cwd: ${input.cwd}`,
      `- exit_code: ${input.exitCode}`,
      `- argv: ${JSON.stringify(input.argv)}`,
      `- duration_ms: ${input.durationMs}`,
      `- dry_run: ${input.dryRun}`,
      `- truncated: ${input.truncated}`,
      '- inbound_reply_injection: forbidden',
      '',
      '## Prompt',
      '',
      '```text',
      input.prompt,
      '```',
      '',
      '## Response',
      '',
      '```text',
      input.response,
      '```',
      '',
      '## Broker notes',
      '',
      '- Advisory only. Does not set verified/passes.',
      '- Not an executor. Product changes require OMA lanes (`ralph` / `ultrawork` / `verify`).',
      '- Outbound only: no reply injection is implemented or implied.',
      '',
    ].join('\n');
    fs.writeFileSync(input.artifactPath, body, { encoding: 'utf8', mode: 0o600 });
    return ok(undefined);
  } catch (error) {
    return err(runtimeError(
      'E_RETRYABLE_BLOCKER',
      'failed to write ask advisory artifact',
      { cause: error instanceof Error ? error.message : String(error) },
    ));
  }
}

function readAttachedFile(filePath: string, cwd: string): Result<string, RuntimeError> {
  if (filePath.includes('\0') || filePath.trim() === '') {
    return validatorRejected('--file requires one non-empty path');
  }
  const resolved = path.resolve(cwd, filePath);
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return validatorRejected('--file must be a regular file (symlinks rejected)');
    }
    if (stat.size > ASK_FILE_MAX_BYTES) {
      return validatorRejected(`--file exceeds ${ASK_FILE_MAX_BYTES} bytes`);
    }
    return ok(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    return err(runtimeError(
      'E_NOT_FOUND',
      `ask --file could not be read: ${filePath}`,
      { cause: error instanceof Error ? error.message : String(error) },
    ));
  }
}

export function truncateTranscript(
  value: string,
  maximumBytes: number,
  capturedBytes = Buffer.byteLength(value, 'utf8'),
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximumBytes) {
    return { text: value, truncated: false };
  }
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const sliced = bytes.subarray(0, end).toString('utf8');
  const marker = `\n\n${ASK_TRUNCATION_MARKER_PREFIX}${capturedBytes} bytes, max_bytes=${maximumBytes}]\n`;
  return { text: `${sliced}${marker}`, truncated: true };
}

function defaultAskSpawnSync(
  command: string,
  argv: readonly string[],
  options: Parameters<AskSpawnSyncV1>[2],
): AskSpawnResultV1 {
  const result = spawnSync(command, [...argv], options);
  return {
    status: result.status,
    signal: result.signal,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error,
  };
}

function resolveAskExecutable(name: string, environment: NodeJS.ProcessEnv): string | null {
  if (path.basename(name) !== name) return null;
  const entries = (environment.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    if (!path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, name);
    try {
      const real = fs.realpathSync(candidate);
      const stat = fs.statSync(real);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // 固定 PATH 逐項尋找；不用 shell which。
    }
  }
  return null;
}
