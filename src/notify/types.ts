import { canonicalJsonV1 } from '../contracts/state-schemas';
import { sha256 } from '../runtime/atomic';
import { redactDiagnostic } from '../runtime/redaction';

export type NotificationAdapter = 'terminal' | 'tmux' | 'https';

export interface NotificationOwnerV1 {
  owner_id: string;
  generation: number;
  owner_nonce_sha256: string;
}

export interface NotificationEventV1 {
  store_kind: 'oma_notification_event';
  schema_version: 1;
  repository_id: 'OMA';
  event_id: string;
  created_at: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  owner: NotificationOwnerV1;
}

export interface CreateNotificationEventInputV1 {
  created_at?: string;
  severity: NotificationEventV1['severity'];
  title: string;
  message: string;
  owner_id: string;
  generation: number;
  owner_nonce: string;
}

export interface NotificationOutcomeV1 {
  adapter: NotificationAdapter;
  status: 'delivered' | 'skipped' | 'failed';
  code: string;
  event_id: string;
  destination_sha256: string | null;
  diagnostic: string | null;
}

export interface NotificationOwnerTargetV1 {
  owner_id: string;
  generation: number;
  owner_nonce: string;
}

export function createNotificationEvent(
  input: Readonly<CreateNotificationEventInputV1>,
): NotificationEventV1 {
  const createdAt = input.created_at ?? new Date().toISOString();
  const parsedTimestamp = new Date(createdAt);
  if (!Number.isFinite(parsedTimestamp.getTime()) || parsedTimestamp.toISOString() !== createdAt) {
    throw new TypeError('Notification timestamp must be canonical UTC');
  }
  if (!['info', 'success', 'warning', 'error'].includes(input.severity)) {
    throw new TypeError('Notification severity is invalid');
  }
  if (!safeIdentifier(input.owner_id) || !Number.isSafeInteger(input.generation) || input.generation < 1
    || !safeNonce(input.owner_nonce)) {
    throw new TypeError('Notification owner identity is invalid');
  }
  const unsigned = {
    store_kind: 'oma_notification_event' as const,
    schema_version: 1 as const,
    repository_id: 'OMA' as const,
    created_at: createdAt,
    severity: input.severity,
    title: boundedLine(redactDiagnostic(input.title, 256), 256),
    message: boundedLine(redactDiagnostic(input.message, 2048), 2048),
    owner: {
      owner_id: input.owner_id,
      generation: input.generation,
      owner_nonce_sha256: sha256(input.owner_nonce),
    },
  };
  return { ...unsigned, event_id: sha256(canonicalJsonV1(unsigned)) };
}

export function ownerMatches(
  event: Readonly<NotificationEventV1>,
  target: Readonly<NotificationOwnerTargetV1>,
): boolean {
  return safeIdentifier(target.owner_id) && safeNonce(target.owner_nonce)
    && Number.isSafeInteger(target.generation) && target.generation >= 1
    && event.owner.owner_id === target.owner_id
    && event.owner.generation === target.generation
    && event.owner.owner_nonce_sha256 === sha256(target.owner_nonce);
}

export function notificationLine(event: Readonly<NotificationEventV1>, maximumBytes = 2048): string {
  const line = `[OMA ${event.severity.toUpperCase()}] ${event.title}: ${event.message}`;
  return boundedLine(line, maximumBytes);
}

export function destinationHash(value: string): string {
  return sha256(value);
}

export function outcome(
  adapter: NotificationAdapter,
  status: NotificationOutcomeV1['status'],
  code: string,
  event: Readonly<NotificationEventV1>,
  destination: string | null,
  diagnostic: string | null = null,
): NotificationOutcomeV1 {
  return {
    adapter,
    status,
    code,
    event_id: event.event_id,
    destination_sha256: destination === null ? null : destinationHash(destination),
    diagnostic: diagnostic === null ? null : redactDiagnostic(diagnostic, 512),
  };
}

function safeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,512}$/u.test(value) && !value.includes('/') && !value.includes('\\');
}

function safeNonce(value: string): boolean {
  return value.length >= 16 && value.length <= 4096 && !/[\0\r\n]/u.test(value);
}

function boundedLine(value: string, maximumBytes: number): string {
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
  const bytes = Buffer.from(normalized, 'utf8');
  if (bytes.length <= maximumBytes) return normalized;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}
