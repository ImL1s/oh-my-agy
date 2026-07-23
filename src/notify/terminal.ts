import { spawnSync } from 'child_process';
import {
  NotificationEventV1,
  NotificationOutcomeV1,
  NotificationOwnerTargetV1,
  notificationLine,
  outcome,
  ownerMatches,
} from './types';

export interface TerminalIdentityV1 {
  pid: number;
  start_marker: string;
  tty: string;
}

export interface TerminalNotificationTargetV1 extends NotificationOwnerTargetV1 {
  adapter: 'terminal';
  enabled: boolean;
  terminal: TerminalIdentityV1;
}

export interface TerminalNotificationDependenciesV1 {
  inspect?: (pid: number) => TerminalIdentityV1 | null;
  write?: (line: string) => boolean;
}

export function notifyTerminal(
  event: Readonly<NotificationEventV1>,
  target: Readonly<TerminalNotificationTargetV1>,
  dependencies: Readonly<TerminalNotificationDependenciesV1> = {},
): NotificationOutcomeV1 {
  const destination = `pid:${target.terminal.pid}:tty:${target.terminal.tty}`;
  if (!target.enabled) return outcome('terminal', 'skipped', 'TERMINAL_DISABLED', event, destination);
  if (!ownerMatches(event, target)) {
    return outcome('terminal', 'failed', 'TERMINAL_OWNER_MISMATCH', event, destination);
  }
  if (target.terminal.pid !== process.pid) {
    return outcome('terminal', 'failed', 'TERMINAL_PROCESS_NOT_CURRENT', event, destination);
  }
  const inspect = dependencies.inspect ?? inspectCurrentTerminal;
  const observed = inspect(target.terminal.pid);
  if (observed === null || !sameIdentity(observed, target.terminal)) {
    return outcome('terminal', 'failed', 'TERMINAL_IDENTITY_MISMATCH', event, destination);
  }
  const write = dependencies.write ?? defaultTerminalWrite;
  try {
    return write(`${notificationLine(event)}\n`)
      ? outcome('terminal', 'delivered', 'TERMINAL_DELIVERED', event, destination)
      : outcome('terminal', 'failed', 'TERMINAL_WRITE_FAILED', event, destination);
  } catch (error) {
    return outcome('terminal', 'failed', 'TERMINAL_WRITE_FAILED', event, destination,
      error instanceof Error ? error.message : String(error));
  }
}

export function inspectCurrentTerminal(pid: number): TerminalIdentityV1 | null {
  if (pid !== process.pid || process.stderr.isTTY !== true) return null;
  const result = spawnSync('ps', ['-o', 'lstart=', '-o', 'tty=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 1_000,
    maxBuffer: 8 * 1024,
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  const match = /^(.*?)\s+(\S+)\s*$/u.exec((result.stdout ?? '').trim());
  if (match === null || match[1] === '' || match[2] === '?' || match[2] === '??') return null;
  return { pid, start_marker: match[1], tty: match[2] };
}

function defaultTerminalWrite(line: string): boolean {
  process.stderr.write(line);
  return true;
}

function sameIdentity(left: Readonly<TerminalIdentityV1>, right: Readonly<TerminalIdentityV1>): boolean {
  return left.pid === right.pid && left.start_marker === right.start_marker && left.tty === right.tty;
}
