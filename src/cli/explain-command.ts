/**
 * `oma explain <E_CODE> [--json]` — 查 CLI 可見錯誤目錄。
 * 設計概念映射：OMG `next_action` 文件化、OMX doctor 可讀代碼；OMA 另給
 * 獨立 explain 子命令，未收錄代碼 fail-closed 於 explain（exit ≠ 0），
 * 但一般 CLI 印錯仍 fail-open。
 */
import { canonicalBytesV1 } from '../contracts/state-schemas';
import {
  CLI_ERROR_CODES_DOC_RELATIVE_PATH,
  formatCliError,
  isCliErrorCode,
  lookupCliErrorCatalog,
} from '../runtime/error-catalog';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';

export const EXPLAIN_USAGE = 'Usage: oma explain <E_CODE> [--json]';
export const EXPLAIN_NOT_IN_CATALOG_CODE = 'E_NOT_IN_CATALOG';
export const EXPLAIN_RESULT_SCHEMA = 'oma.explain-result/v1';

export interface ExplainCommandContext {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface ParsedExplainCommand {
  readonly code: string;
  readonly asJson: boolean;
}

export function parseExplainArgv(
  argv: readonly string[],
): Result<ParsedExplainCommand, RuntimeError> {
  let asJson = false;
  const positionals: string[] = [];
  for (const token of argv) {
    if (token === '--json') {
      if (asJson) {
        return err(runtimeError('E_VALIDATOR_REJECTED', 'oma explain: duplicate option --json'));
      }
      asJson = true;
      continue;
    }
    if (token.startsWith('-')) {
      return err(runtimeError(
        'E_VALIDATOR_REJECTED',
        `oma explain: unexpected option ${token}`,
      ));
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    return err(runtimeError('E_VALIDATOR_REJECTED', EXPLAIN_USAGE));
  }
  const code = positionals[0];
  if (!isCliErrorCode(code)) {
    return err(runtimeError(
      'E_VALIDATOR_REJECTED',
      `oma explain requires an E_* code, got ${JSON.stringify(code)}`,
    ));
  }
  return ok({ code, asJson });
}

function wantsJson(argv: readonly string[]): boolean {
  return argv.filter((token) => token === '--json').length === 1;
}

function writeExplainFailure(
  argv: readonly string[],
  error: RuntimeError,
  context: Readonly<ExplainCommandContext>,
): number {
  if (wantsJson(argv)) {
    context.stdout(`${canonicalBytesV1({
      code: error.code,
      exitCode: 2,
      message: error.message,
      ok: false,
      schema: EXPLAIN_RESULT_SCHEMA,
    }).toString('utf8')}\n`);
  } else {
    context.stderr(formatCliError(error.code, error.message));
  }
  return 2;
}

function renderUncatalogedMessage(code: string): string {
  return [
    `${EXPLAIN_NOT_IN_CATALOG_CODE}: ${code} is not in the CLI-visible error catalog.`,
    '  This catalog documents only codes the oma CLI prints to users, not every internal E_* contract.',
    `  See ${CLI_ERROR_CODES_DOC_RELATIVE_PATH} or try: oma explain E_PLUGIN_NOT_ACTIVE`,
  ].join('\n');
}

export function runExplainCommand(
  argv: readonly string[],
  context: Readonly<ExplainCommandContext>,
): number {
  const parsed = parseExplainArgv(argv);
  if (!parsed.ok) return writeExplainFailure(argv, parsed.error, context);

  const { code, asJson } = parsed.value;
  const cataloged = lookupCliErrorCatalog(code);
  if (cataloged === undefined) {
    if (asJson) {
      context.stdout(`${canonicalBytesV1({
        code: EXPLAIN_NOT_IN_CATALOG_CODE,
        exitCode: 1,
        message: `${code} is not in the CLI-visible error catalog.`,
        ok: false,
        query: code,
        schema: EXPLAIN_RESULT_SCHEMA,
      }).toString('utf8')}\n`);
    } else {
      context.stderr(`${renderUncatalogedMessage(code)}\n`);
    }
    return 1;
  }

  if (asJson) {
    context.stdout(`${canonicalBytesV1({
      code,
      docsAnchor: cataloged.docsAnchor,
      likelyCause: cataloged.likelyCause,
      nextAction: cataloged.nextAction,
      ok: true,
      schema: EXPLAIN_RESULT_SCHEMA,
      summary: cataloged.summary,
    }).toString('utf8')}\n`);
    return 0;
  }

  context.stdout([
    code,
    '',
    `Summary: ${cataloged.summary}`,
    `Likely cause: ${cataloged.likelyCause}`,
    `Next action: ${cataloged.nextAction}`,
    '',
    `Docs: ${CLI_ERROR_CODES_DOC_RELATIVE_PATH}#${cataloged.docsAnchor}`,
    '',
  ].join('\n'));
  return 0;
}
