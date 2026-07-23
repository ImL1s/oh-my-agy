import { HttpsNotificationDependenciesV1, HttpsNotificationTargetV1, notifyHttps } from './https';
import { TerminalNotificationDependenciesV1, TerminalNotificationTargetV1, notifyTerminal } from './terminal';
import { TmuxNotificationDependenciesV1, TmuxNotificationTargetV1, notifyTmux } from './tmux';
import { NotificationEventV1, NotificationOutcomeV1, outcome } from './types';

export type NotificationTargetV1 =
  | TerminalNotificationTargetV1
  | TmuxNotificationTargetV1
  | HttpsNotificationTargetV1;

export interface NotificationDispatcherDependenciesV1 {
  terminal?: TerminalNotificationDependenciesV1;
  tmux?: TmuxNotificationDependenciesV1;
  https?: HttpsNotificationDependenciesV1;
}

export async function dispatchNotifications(
  event: Readonly<NotificationEventV1>,
  targets: readonly Readonly<NotificationTargetV1>[],
  dependencies: Readonly<NotificationDispatcherDependenciesV1> = {},
): Promise<NotificationOutcomeV1[]> {
  const results: NotificationOutcomeV1[] = [];
  for (const target of targets) {
    try {
      if (target.adapter === 'terminal') results.push(notifyTerminal(event, target, dependencies.terminal));
      else if (target.adapter === 'tmux') results.push(notifyTmux(event, target, dependencies.tmux));
      else results.push(await notifyHttps(event, target, dependencies.https));
    } catch (error) {
      results.push(outcome(target.adapter, 'failed', 'NOTIFICATION_ADAPTER_FAILED', event, null,
        error instanceof Error ? error.message : String(error)));
    }
  }
  return results;
}
