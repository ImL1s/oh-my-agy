import { RuntimeErrorCode } from '../runtime/errors';
import { ManagedMode } from '../modes/directives';

export type ParsedCliCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'mode'; readonly mode: ManagedMode; readonly task: string }
  | { readonly kind: 'autopilot'; readonly args: readonly string[] }
  | { readonly kind: 'team'; readonly args: readonly string[] }
  | { readonly kind: 'setup'; readonly args: readonly string[] }
  | { readonly kind: 'doctor'; readonly args: readonly string[] }
  | { readonly kind: 'skill'; readonly args: readonly string[] }
  | { readonly kind: 'native'; readonly command: NativeCliCommand; readonly args: readonly string[] }
  | {
    readonly kind: 'extended';
    readonly command: ExtendedCliCommand;
    readonly args: readonly string[];
  }
  | { readonly kind: 'passthrough'; readonly args: readonly string[] }
  | { readonly kind: 'invalid'; readonly code: RuntimeErrorCode; readonly message: string };

export type ExtendedCliCommand =
  | 'workflow'
  | 'mcp-server'
  | 'wiki'
  | 'hud'
  | 'session'
  | 'cancel'
  | 'native-status'
  | 'lsp-status'
  | 'sidecar-status'
  | 'notify'
  | 'resume'
  | 'recovery'
  | 'update'
  | 'uninstall'
  | 'parity'
  | 'production';

export type NativeCliCommand = 'capabilities' | 'probe';

const MANAGED_MODES = new Set<ManagedMode>(['ralph', 'ultrawork', 'search']);
const EXTENDED_COMMANDS = new Set<ExtendedCliCommand>([
  'workflow',
  'mcp-server',
  'wiki',
  'hud',
  'session',
  'cancel',
  'native-status',
  'lsp-status',
  'sidecar-status',
  'notify',
  'resume',
  'recovery',
  'update',
  'uninstall',
  'parity',
  'production',
]);

export function parseCliArguments(argv: readonly string[]): ParsedCliCommand {
  if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) return { kind: 'help' };
  if (argv.length === 1 && ['--version', '-v', 'version'].includes(argv[0])) return { kind: 'version' };

  const first = argv[0];
  if (isManagedMode(first)) {
    const delimiter = argv.indexOf('--', 1);
    if (delimiter >= 0) {
      const between = argv.slice(1, delimiter);
      if (between.length > 0) {
        return {
          kind: 'invalid',
          code: 'E_DIRECTIVE_INVALID',
          message: `${first}: unexpected token(s) before --: ${between.join(' ')}`,
        };
      }
      const task = argv.slice(delimiter + 1).join(' ');
      if (task.trim() === '') {
        return {
          kind: 'invalid',
          code: 'E_DIRECTIVE_INVALID',
          message: `${first} requires a non-empty task after --`,
        };
      }
      return { kind: 'mode', mode: first, task };
    }
    // 無 `--` 時仍解析為 mode（structured 入口通常要求 `--`；保留相容）
    const task = argv.slice(1).join(' ');
    if (task.trim() === '') {
      return {
        kind: 'invalid',
        code: 'E_DIRECTIVE_INVALID',
        message: `${first} requires a non-empty task after --`,
      };
    }
    return { kind: 'mode', mode: first, task };
  }

  if (first === 'autopilot') return { kind: 'autopilot', args: argv.slice(1) };
  if (first === 'team') return { kind: 'team', args: argv.slice(1) };
  if (first === 'setup') return { kind: 'setup', args: argv.slice(1) };
  if (first === 'doctor') return { kind: 'doctor', args: argv.slice(1) };
  if (first === 'skill') return { kind: 'skill', args: argv.slice(1) };
  if (first === 'native' && isNativeCliCommand(argv[1])) {
    return { kind: 'native', command: argv[1], args: argv.slice(2) };
  }
  if (isExtendedCommand(first)) {
    return { kind: 'extended', command: first, args: argv.slice(1) };
  }
  return { kind: 'passthrough', args: [...argv] };
}

function isManagedMode(value: string | undefined): value is ManagedMode {
  return value !== undefined && MANAGED_MODES.has(value as ManagedMode);
}

function isExtendedCommand(value: string | undefined): value is ExtendedCliCommand {
  return value !== undefined && EXTENDED_COMMANDS.has(value as ExtendedCliCommand);
}

export function isStructuredNativeCommand(argv: readonly string[]): boolean {
  return argv[0] === 'native' && isNativeCliCommand(argv[1]);
}

function isNativeCliCommand(value: string | undefined): value is NativeCliCommand {
  return value === 'capabilities' || value === 'probe';
}
