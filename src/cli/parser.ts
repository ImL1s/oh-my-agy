import { RuntimeErrorCode } from '../runtime/errors';
import { ManagedMode } from '../modes/directives';

export type ParsedCliCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'mode'; readonly mode: ManagedMode; readonly task: string }
  | { readonly kind: 'autopilot'; readonly args: readonly string[] }
  | { readonly kind: 'team'; readonly args: readonly string[] }
  | { readonly kind: 'setup'; readonly args: readonly string[] }
  | { readonly kind: 'passthrough'; readonly args: readonly string[] }
  | { readonly kind: 'invalid'; readonly code: RuntimeErrorCode; readonly message: string };

const MANAGED_MODES = new Set<ManagedMode>(['ralph', 'ultrawork', 'search']);

export function parseCliArguments(argv: readonly string[]): ParsedCliCommand {
  if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) return { kind: 'help' };
  if (argv.length === 1 && ['--version', '-v', 'version'].includes(argv[0])) return { kind: 'version' };

  const first = argv[0];
  if (isManagedMode(first)) {
    const delimiter = argv.indexOf('--', 1);
    const taskArgs = delimiter >= 0 ? argv.slice(delimiter + 1) : argv.slice(1);
    const task = taskArgs.join(' ');
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
  return { kind: 'passthrough', args: [...argv] };
}

function isManagedMode(value: string | undefined): value is ManagedMode {
  return value !== undefined && MANAGED_MODES.has(value as ManagedMode);
}
