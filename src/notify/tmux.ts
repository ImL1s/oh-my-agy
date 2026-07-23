import { spawnSync } from 'child_process';
import {
  NotificationEventV1,
  NotificationOutcomeV1,
  NotificationOwnerTargetV1,
  notificationLine,
  outcome,
  ownerMatches,
} from './types';

export interface TmuxCommandOutcomeV1 {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type TmuxNotificationRunnerV1 = (argv: readonly string[]) => TmuxCommandOutcomeV1;

export interface TmuxNotificationTargetV1 extends NotificationOwnerTargetV1 {
  adapter: 'tmux';
  enabled: boolean;
  session_name: string;
  pane_id: string;
  worker_nonce: string;
}

export interface TmuxNotificationDependenciesV1 {
  run?: TmuxNotificationRunnerV1;
}

export function notifyTmux(
  event: Readonly<NotificationEventV1>,
  target: Readonly<TmuxNotificationTargetV1>,
  dependencies: Readonly<TmuxNotificationDependenciesV1> = {},
): NotificationOutcomeV1 {
  const destination = `session:${target.session_name}:pane:${target.pane_id}`;
  if (!target.enabled) return outcome('tmux', 'skipped', 'TMUX_DISABLED', event, destination);
  if (!ownerMatches(event, target) || !validTarget(target)) {
    return outcome('tmux', 'failed', 'TMUX_OWNER_MISMATCH', event, destination);
  }
  const run = dependencies.run ?? defaultTmuxRunner;
  const identity = run(['display-message', '-p', '-t', target.pane_id, '#{session_name}\t#{pane_id}']);
  const owner = run(['show-options', '-v', '-t', target.session_name, '@oma_owner_nonce']);
  const worker = run(['show-options', '-p', '-v', '-t', target.pane_id, '@oma_worker_nonce']);
  const expectedIdentity = `${target.session_name}\t${target.pane_id}`;
  if (identity.status !== 0 || identity.stdout.trim() !== expectedIdentity
    || owner.status !== 0 || owner.stdout.trim() !== target.owner_nonce
    || worker.status !== 0 || worker.stdout.trim() !== target.worker_nonce) {
    return outcome('tmux', 'failed', 'TMUX_IDENTITY_MISMATCH', event, destination);
  }
  const sent = run(['display-message', '-t', target.pane_id, '--', notificationLine(event)]);
  return sent.status === 0
    ? outcome('tmux', 'delivered', 'TMUX_DELIVERED', event, destination)
    : outcome('tmux', 'failed', 'TMUX_DELIVERY_FAILED', event, destination, sent.stderr);
}

function defaultTmuxRunner(argv: readonly string[]): TmuxCommandOutcomeV1 {
  const result = spawnSync('tmux', [...argv], {
    encoding: 'utf8',
    timeout: 1_500,
    maxBuffer: 16 * 1024,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function validTarget(target: Readonly<TmuxNotificationTargetV1>): boolean {
  return /^[A-Za-z0-9_.-]{1,128}$/u.test(target.session_name)
    && /^%[0-9]{1,16}$/u.test(target.pane_id)
    && target.worker_nonce.length >= 16 && target.worker_nonce.length <= 4096
    && !/[\0\r\n]/u.test(target.worker_nonce);
}
