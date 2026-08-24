import * as fs from 'fs';
import * as path from 'path';
import { CliServices, runCli } from '../../src/cli/application';
import { runExplainCommand } from '../../src/cli/explain-command';
import { parseCliArguments } from '../../src/cli/parser';
import { canonicalBytesV1 } from '../../src/contracts/state-schemas';
import {
  CLI_ERROR_CATALOG,
  CLI_ERROR_CODE_PATTERN,
  CLI_ERROR_CODES_DOC_RELATIVE_PATH,
  CLI_ERROR_NEXT_LINE_PREFIX,
  formatCliError,
  lookupCliErrorCatalog,
  renderCliErrorCatalogMarkdown,
} from '../../src/runtime/error-catalog';
import { runtimeError } from '../../src/runtime/errors';
import { ProcessOutcome } from '../../src/runtime/process';
import { err, ok } from '../../src/runtime/types';

const repoRoot = path.resolve(__dirname, '../..');

const GENERIC_NEXT_ACTION = /^(see (the )?docs|try again|contact support|an error occurred|fix the error)\.?$/i;

const PRINTER_FILES = [
  'src/cli/application.ts',
  'src/cli/services.ts',
  'src/cli/runtime-adapter.ts',
  'src/cli/session-commands.ts',
  'src/cli/skill-commands.ts',
  'src/cli/host-launch.ts',
  'src/cli/explain-command.ts',
  'src/team/commands.ts',
  'bin/oma.ts',
] as const;

const outcome: ProcessOutcome = {
  code: 0,
  signal: null,
  timedOut: false,
  stdout: '',
  stderr: '',
  processIdentity: null,
};

function mockServices(): jest.Mocked<CliServices> {
  return {
    launchMode: jest.fn<
      ReturnType<CliServices['launchMode']>,
      Parameters<CliServices['launchMode']>
    >(async () => ok(outcome)),
    passThrough: jest.fn<
      ReturnType<CliServices['passThrough']>,
      Parameters<CliServices['passThrough']>
    >(async () => ok(outcome)),
    autopilotCommand: jest.fn<
      ReturnType<CliServices['autopilotCommand']>,
      Parameters<CliServices['autopilotCommand']>
    >(async () => 0),
    teamCommand: jest.fn<
      ReturnType<CliServices['teamCommand']>,
      Parameters<CliServices['teamCommand']>
    >(async () => 0),
    setupCommand: jest.fn<
      ReturnType<CliServices['setupCommand']>,
      Parameters<CliServices['setupCommand']>
    >(async () => 0),
    doctorCommand: jest.fn<
      ReturnType<CliServices['doctorCommand']>,
      Parameters<CliServices['doctorCommand']>
    >(async () => 0),
    skillCommand: jest.fn<
      ReturnType<CliServices['skillCommand']>,
      Parameters<CliServices['skillCommand']>
    >(async () => 0),
    nativeCommand: jest.fn<
      ReturnType<CliServices['nativeCommand']>,
      Parameters<CliServices['nativeCommand']>
    >(async () => 0),
    extendedCommand: jest.fn<
      ReturnType<CliServices['extendedCommand']>,
      Parameters<CliServices['extendedCommand']>
    >(async () => 0),
  };
}

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: (value: string) => { stdout += value; },
    stderr: (value: string) => { stderr += value; },
    output: () => ({ stdout, stderr }),
  };
}

function codesOnStderr(stderr: string): string[] {
  return [...stderr.matchAll(/^(E_[A-Z0-9_]+):/gm)].map((match) => match[1]);
}

function hardcodedPrinterCodes(): string[] {
  const codes = new Set<string>();
  const formatCall = /formatCliError\(\s*['"](E_[A-Z0-9_]+)['"]/g;
  const stderrLiteral = /(?:stderr|io\.stderr|context\.stderr|process\.stderr\.write)\(\s*(?:[`'])(E_[A-Z0-9_]+):/g;
  for (const relative of PRINTER_FILES) {
    const source = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    for (const pattern of [formatCall, stderrLiteral]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null = pattern.exec(source);
      while (match !== null) {
        codes.add(match[1]);
        match = pattern.exec(source);
      }
    }
    if (source.includes("usage ? 'E_CLI_USAGE' : 'E_COMMAND_FAILED'")
      || source.includes('usage ? \'E_CLI_USAGE\' : \'E_COMMAND_FAILED\'')) {
      codes.add('E_CLI_USAGE');
      codes.add('E_COMMAND_FAILED');
    }
  }
  return [...codes].sort();
}

describe('CLI-visible error catalog', () => {
  test('every catalog nextAction is non-empty, specific, and unique', () => {
    const codes = Object.keys(CLI_ERROR_CATALOG);
    expect(codes.length).toBeGreaterThanOrEqual(20);
    const actions = new Set<string>();
    const summaries = new Set<string>();
    for (const code of codes) {
      expect(code).toMatch(CLI_ERROR_CODE_PATTERN);
      const item = CLI_ERROR_CATALOG[code];
      expect(item.summary.trim().length).toBeGreaterThan(12);
      expect(item.likelyCause.trim().length).toBeGreaterThan(12);
      expect(item.nextAction.trim().length).toBeGreaterThan(20);
      expect(item.nextAction).not.toMatch(/\n/);
      expect(item.nextAction).not.toMatch(GENERIC_NEXT_ACTION);
      expect(item.docsAnchor).toBe(code.toLowerCase().replace(/_/g, '-'));
      expect(actions.has(item.nextAction)).toBe(false);
      actions.add(item.nextAction);
      expect(summaries.has(item.summary)).toBe(false);
      summaries.add(item.summary);
    }
  });

  test('docs/error-codes.md stays in lockstep with the catalog map', () => {
    const expected = renderCliErrorCatalogMarkdown();
    const onDisk = fs.readFileSync(path.join(repoRoot, CLI_ERROR_CODES_DOC_RELATIVE_PATH), 'utf8');
    expect(onDisk).toBe(expected);
    expect(expected.startsWith('# CLI-visible error codes\n')).toBe(true);
    expect(expected).toContain('only the CLI-visible subset');
    expect(expected).toContain('intentionally omitted');
    for (const code of Object.keys(CLI_ERROR_CATALOG)) {
      expect(expected).toContain(`## \`${code}\``);
    }
  });

  test('catalog covers codes application.ts prints on actual error paths', async () => {
    const printed = new Set<string>();

    const invalidIo = captureIo();
    expect(await runCli(['ralph', '--'], mockServices(), invalidIo)).toBe(2);
    for (const code of codesOnStderr(invalidIo.output().stderr)) printed.add(code);

    const tokenIo = captureIo();
    expect(await runCli(['ralph', '--madmax', '--', 'ship'], mockServices(), tokenIo)).toBe(2);
    for (const code of codesOnStderr(tokenIo.output().stderr)) printed.add(code);

    const pluginServices = mockServices();
    pluginServices.launchMode.mockResolvedValue(
      err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'plugin inactive')),
    );
    const pluginIo = captureIo();
    expect(await runCli(['ralph', '--', 'task'], pluginServices, pluginIo)).toBe(1);
    for (const code of codesOnStderr(pluginIo.output().stderr)) printed.add(code);
    expect(pluginIo.output().stderr).toContain(`${CLI_ERROR_NEXT_LINE_PREFIX}`);

    const validatorServices = mockServices();
    validatorServices.passThrough.mockResolvedValue(
      err(runtimeError('E_VALIDATOR_REJECTED', 'Dangerous flags --yolo require a TTY confirmation')),
    );
    const validatorIo = captureIo();
    expect(await runCli(['--yolo', 'run'], validatorServices, validatorIo)).toBe(2);
    for (const code of codesOnStderr(validatorIo.output().stderr)) printed.add(code);

    expect([...printed].sort()).toEqual([
      'E_DIRECTIVE_INVALID',
      'E_PLUGIN_NOT_ACTIVE',
      'E_VALIDATOR_REJECTED',
    ]);
    for (const code of printed) {
      expect(lookupCliErrorCatalog(code)).toBeDefined();
    }
  });

  test('catalog covers hardcoded CLI stderr printer codes', () => {
    const printed = hardcodedPrinterCodes().filter((code) => code !== 'E_NOT_IN_CATALOG');
    expect(printed).toEqual(expect.arrayContaining([
      'E_CLI_USAGE',
      'E_COMMAND_FAILED',
      'E_PRODUCTION_EVIDENCE',
    ]));
    for (const code of printed) {
      expect(lookupCliErrorCatalog(code)).toBeDefined();
    }
  });

  test('uncataloged codes keep the one-line CODE: message format (fail-open)', async () => {
    const services = mockServices();
    services.launchMode.mockResolvedValue(
      err(runtimeError('E_TRACKER_LEASE_STALLED', 'lease stalled')),
    );
    const io = captureIo();
    expect(await runCli(['search', '--', 'q'], services, io)).toBe(1);
    expect(io.output().stderr).toBe('E_TRACKER_LEASE_STALLED: lease stalled\n');
    expect(io.output().stderr).not.toContain(CLI_ERROR_NEXT_LINE_PREFIX);
    expect(lookupCliErrorCatalog('E_TRACKER_LEASE_STALLED')).toBeUndefined();
    expect(formatCliError('E_TRACKER_LEASE_STALLED', 'lease stalled'))
      .toBe('E_TRACKER_LEASE_STALLED: lease stalled\n');
  });

  test('oma explain E_PLUGIN_NOT_ACTIVE is readable; --json is canonical; unknown and non-E_ inputs fail closed', () => {
    const readable = captureIo();
    expect(runExplainCommand(['E_PLUGIN_NOT_ACTIVE'], readable)).toBe(0);
    expect(readable.output().stdout).toContain('E_PLUGIN_NOT_ACTIVE');
    expect(readable.output().stdout).toContain('Summary:');
    expect(readable.output().stdout).toContain('Likely cause:');
    expect(readable.output().stdout).toContain('Next action:');
    expect(readable.output().stdout).toContain('oma setup');
    expect(readable.output().stderr).toBe('');

    const jsonIo = captureIo();
    expect(runExplainCommand(['E_PLUGIN_NOT_ACTIVE', '--json'], jsonIo)).toBe(0);
    expect(jsonIo.output().stderr).toBe('');
    expect(jsonIo.output().stdout.endsWith('\n')).toBe(true);
    const body = JSON.parse(jsonIo.output().stdout) as Record<string, unknown>;
    const cataloged = CLI_ERROR_CATALOG.E_PLUGIN_NOT_ACTIVE;
    expect(body).toEqual({
      code: 'E_PLUGIN_NOT_ACTIVE',
      docsAnchor: cataloged.docsAnchor,
      likelyCause: cataloged.likelyCause,
      nextAction: cataloged.nextAction,
      ok: true,
      schema: 'oma.explain-result/v1',
      summary: cataloged.summary,
    });
    expect(jsonIo.output().stdout).toBe(`${canonicalBytesV1(body).toString('utf8')}\n`);

    const missing = captureIo();
    expect(runExplainCommand(['E_NOT_IN_CATALOG'], missing)).toBe(1);
    expect(missing.output().stderr).toContain('E_NOT_IN_CATALOG:');
    expect(missing.output().stderr).toContain('not in the CLI-visible error catalog');
    expect(missing.output().stdout).toBe('');

    const invalid = captureIo();
    expect(runExplainCommand(['plugin-not-active'], invalid)).toBe(2);
    expect(invalid.output().stderr).toContain('E_VALIDATOR_REJECTED:');
    expect(invalid.output().stderr).toContain('requires an E_* code');
  });

  test('parser routes explain onto the extended command surface', () => {
    expect(parseCliArguments(['explain', 'E_PLUGIN_NOT_ACTIVE', '--json'])).toEqual({
      kind: 'extended',
      command: 'explain',
      args: ['E_PLUGIN_NOT_ACTIVE', '--json'],
    });
  });
});
