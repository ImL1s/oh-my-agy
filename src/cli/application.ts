import { RuntimeError } from '../runtime/errors';
import { ProcessOutcome } from '../runtime/process';
import { Result } from '../runtime/types';
import { ManagedMode } from '../modes/directives';
import { ExtendedCliCommand, parseCliArguments } from './parser';

export interface CliServices {
  readonly version?: string;
  launchMode(mode: ManagedMode, task: string): Promise<Result<ProcessOutcome, RuntimeError>>;
  passThrough(argv: readonly string[]): Promise<Result<ProcessOutcome, RuntimeError>>;
  autopilotCommand(argv: readonly string[]): Promise<number>;
  teamCommand(argv: readonly string[]): Promise<number>;
  setupCommand(argv: readonly string[]): Promise<number>;
  doctorCommand(argv: readonly string[]): Promise<number>;
  skillCommand(argv: readonly string[]): Promise<number>;
  extendedCommand(command: ExtendedCliCommand, argv: readonly string[]): Promise<number>;
}

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export const CLI_HELP = `oh-my-agy (oma) — safe Antigravity orchestration

Usage:
  oma <agy args...>
  oma ralph -- <task>
  oma ultrawork -- <task>
  oma search -- <read-only query>
  oma skill list
  oma skill show <name>
  oma workflow install [--source <definition.json>]
  oma workflow list|native-status
  oma workflow run <name> --input <input.json> [--version <semver>] [--generation <n>]
  oma workflow status|replay --run <run-id>
  oma mcp-server
  oma wiki index|list|search <query> [--limit <1..50>]
  oma hud [--json] [--watch] [--session <id> --workspace-key <key>]
  oma native-status | lsp-status | sidecar-status
  oma notify status|test [--severity <level>] [--title <text>] [--message <text>]
  oma resume --session <id> --conversation <id> --expected-revision <n>
  oma recovery --source <transcript.jsonl> [--recovery-root <dir>] [--include-prompt]
  oma update [--release] [--bin-dir <dir>]
  oma uninstall --receipt <receipt.json> [--project-state <.agy>] [--purge]
  oma parity verify|verify-handoff -- <read-only run-manifest args...>
  oma parity verify-composition --run-id <id> --aggregate <aggregate-handoff.json>
  oma production verify [--run-id <id>]
  oma production probe <plugin-discovery|managed-lifecycle|exact-resume|worker-runtime|mcp-lsp|workflow> [--run-id <id>]
  oma production capture <review|ultraqa> [--run-id <id>] -- <codex|claude|grok|agy|cursor-agent> <args...>
  oma autopilot start -- <goal>
  oma autopilot status --session <id>
  oma autopilot advance|checkpoint --session <id> --expected-revision <n> --evidence <file>
  oma autopilot handoff --session <id> --expected-revision <n> --key <deepInterview|…> --path <file>
  oma autopilot consensus --session <id> --expected-revision <n> --role architect|critic --verdict approve|revise --note <text>
  oma autopilot return-ralplan --session <id> --expected-revision <n> --reason <text>
  oma autopilot review --session <id> --expected-revision <n> --evidence <file>
  oma autopilot qa --session <id> --expected-revision <n> --evidence <file>
  oma autopilot resume --session <id> --conversation <id> --expected-revision <n>
  oma autopilot drive --session <id> --conversation <id> --expected-revision <n>
  oma autopilot cancel --session <id> --expected-revision <n> --reason <text>
  oma autopilot reset-breaker --session <id> --expected-revision <n>
  oma autopilot doctor --session <id>
  oma team start --manifest <file> [--worker-mode interactive|headless]
  oma team status --team <id>
  oma team stop --team <id>
  oma team supervise --team <id>
  oma team reclaim --team <id> --task <id> --expected-revision <n> --pane dead|alive|unknown --process dead|alive|unknown
  oma team deliver --team <id> --task <id> --expected-revision <n> --claim-token <tok> --generation <n> --worktree <path>
  oma team tick --team <id> [--worker-mode headless|interactive] [--max-parallel <n>]
  oma team resolve-fork --team <id> --fork <id> --winner-generation <n> --expected-revision <n> --evidence <file>
  oma setup [--global|--workspace] [--host all|agy|claude|grok]
  oma doctor [--json] [--no-strict-plugin]

Primary UX (Claude Code / Grok session):
  /oh-my-agy:autopilot <goal>
  (after: oma setup — installs slash skills; restart host session)
`;

export async function runCli(
  argv: readonly string[],
  services: CliServices,
  io: CliIo = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
): Promise<number> {
  const command = parseCliArguments(argv);
  switch (command.kind) {
    case 'help':
      io.stdout(CLI_HELP);
      return 0;
    case 'version':
      io.stdout(`${services.version ?? 'unknown'}\n`);
      return 0;
    case 'invalid':
      io.stderr(`${command.code}: ${command.message}\n`);
      return 2;
    case 'mode':
      return outcomeCode(await services.launchMode(command.mode, command.task), io);
    case 'passthrough':
      return outcomeCode(await services.passThrough(command.args), io);
    case 'autopilot':
      return services.autopilotCommand(command.args);
    case 'team':
      return services.teamCommand(command.args);
    case 'setup':
      return services.setupCommand(command.args);
    case 'doctor':
      return services.doctorCommand(command.args);
    case 'skill':
      return services.skillCommand(command.args);
    case 'extended':
      return services.extendedCommand(command.command, command.args);
  }
}

function outcomeCode(
  result: Result<ProcessOutcome, RuntimeError>,
  io: CliIo,
): number {
  if (!result.ok) {
    io.stderr(`${result.error.code}: ${result.error.message}\n`);
    // 與 legacy gate / invalid 對齊：validator 類錯誤用 2
    return result.error.code === 'E_VALIDATOR_REJECTED' || result.error.code === 'E_DIRECTIVE_INVALID'
      ? 2
      : 1;
  }
  return result.value.code;
}
