/**
 * OMX-shaped `oma team api <op>` interop (P0 subset).
 *
 * Authority remains TeamStateStore / TeamOrchestrator — this module is a thin
 * dispatch table over existing claim + mailbox methods. Not full OMX 33-op parity.
 *
 * State layout differs from OMX `.omx/state/team/<name>/…`: OMA keeps the
 * aggregate under `{stateRoot}/repositories/<repo>/teams/<teamId>/aggregate`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { sha256, atomicWriteFile } from '../runtime/atomic';
import { isCanonicalTeamIdentifier } from './manifest';
import { TeamStateStore } from './state';
import {
  CanonicalTeamTaskV1,
  MailboxMessageV1,
  TeamTaskStatus,
} from './types';

/** P0 ops aligned with OMX TEAM_API_OPERATIONS names (subset). */
export const TEAM_API_OPERATIONS_P0 = [
  'send-message',
  'mailbox-list',
  'mailbox-mark-delivered',
  'create-task',
  'list-tasks',
  'claim-task',
  'transition-task-status',
  'release-task-claim',
  'get-summary',
  'write-worker-inbox',
] as const;

export type TeamApiOperationP0 = typeof TEAM_API_OPERATIONS_P0[number];

const P0_SET = new Set<string>(TEAM_API_OPERATIONS_P0);

export type TeamApiEnvelope =
  | { ok: true; operation: TeamApiOperationP0; data: Record<string, unknown> }
  | {
      ok: false;
      operation: TeamApiOperationP0 | 'unknown';
      error: { code: string; message: string; details?: Record<string, unknown> };
    };

export interface TeamApiContext {
  store: TeamStateStore;
  /** Wall clock for leases / deliveredAt / inbox mtime semantics. */
  nowMs?: number;
  tokenFactory?: () => string;
  /** Default claim lease when claim-task omits lease_ms. */
  defaultLeaseMs?: number;
}

export function isTeamApiOperationP0(value: string): value is TeamApiOperationP0 {
  return P0_SET.has(value);
}

export async function executeTeamApiOperation(
  operation: string,
  args: Record<string, unknown>,
  context: TeamApiContext,
): Promise<TeamApiEnvelope> {
  if (!isTeamApiOperationP0(operation)) {
    return {
      ok: false,
      operation: 'unknown',
      error: {
        code: 'E_TEAM_API_UNKNOWN',
        message: `Unknown or non-P0 team api operation: ${operation}`,
        details: { supported: [...TEAM_API_OPERATIONS_P0] },
      },
    };
  }

  try {
    switch (operation) {
      case 'send-message':
        return await opSendMessage(operation, args, context);
      case 'mailbox-list':
        return opMailboxList(operation, args, context);
      case 'mailbox-mark-delivered':
        return await opMailboxMarkDelivered(operation, args, context);
      case 'create-task':
        return await opCreateTask(operation, args, context);
      case 'list-tasks':
        return opListTasks(operation, context);
      case 'claim-task':
        return await opClaimTask(operation, args, context);
      case 'transition-task-status':
        return await opTransitionTaskStatus(operation, args, context);
      case 'release-task-claim':
        return await opReleaseTaskClaim(operation, args, context);
      case 'get-summary':
        return opGetSummary(operation, context);
      case 'write-worker-inbox':
        return opWriteWorkerInbox(operation, args, context);
      default: {
        const _exhaustive: never = operation;
        return {
          ok: false,
          operation: 'unknown',
          error: { code: 'E_TEAM_API_UNKNOWN', message: String(_exhaustive) },
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      operation,
      error: {
        code: 'E_TEAM_API_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** CLI / JSON envelope wrapper (schema_version + timestamp). */
export function wrapTeamApiCliEnvelope(
  envelope: TeamApiEnvelope,
  options: { timestamp?: string } = {},
): Record<string, unknown> {
  const base = {
    schema_version: 1,
    timestamp: options.timestamp ?? new Date().toISOString(),
    command: 'team api',
    ok: envelope.ok,
    operation: envelope.operation,
  };
  if (envelope.ok) {
    return { ...base, data: envelope.data };
  }
  return { ...base, error: envelope.error };
}

function fail(
  operation: TeamApiOperationP0,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): TeamApiEnvelope {
  return {
    ok: false,
    operation,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

function requireString(args: Record<string, unknown>, field: string): string | null {
  const raw = args[field];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function readRevisionFor(
  operation: TeamApiOperationP0,
  args: Record<string, unknown>,
  store: TeamStateStore,
): number | TeamApiEnvelope {
  if (args.expected_revision !== undefined) {
    const value = args.expected_revision;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'expected_revision must be a non-negative integer');
    }
    return value;
  }
  const snapshot = store.read();
  if (!snapshot.ok) {
    return fail(operation, snapshot.error.code, snapshot.error.message, snapshot.error.details as Record<string, unknown> | undefined);
  }
  return snapshot.value.revision;
}

function nowMs(context: TeamApiContext): number {
  return context.nowMs ?? Date.now();
}

function newClaimToken(context: TeamApiContext): string {
  return context.tokenFactory?.() ?? randomBytes(16).toString('hex');
}

function serializeMessage(message: MailboxMessageV1, body?: string): Record<string, unknown> {
  return {
    message_id: message.id,
    id: message.id,
    from_worker: message.sender,
    to_worker: message.recipient,
    sender: message.sender,
    recipient: message.recipient,
    body_digest: message.bodyDigest,
    body: body ?? null,
    created_at_ms: message.createdAtMs,
    delivered_at: message.deliveredAtMs ?? null,
    delivered_at_ms: message.deliveredAtMs ?? null,
    sequence: message.sequence ?? null,
    generation: message.generation ?? null,
    acknowledged_at_ms: message.acknowledgedAtMs ?? null,
  };
}

function mailboxBodiesRoot(store: TeamStateStore): string {
  return path.join(store.teamDirectory(), 'mailbox-bodies');
}

function isSafeMessageId(messageId: string): boolean {
  return isCanonicalTeamIdentifier(messageId);
}

function validateMessageIdOrFail(
  operation: TeamApiOperationP0,
  messageId: string,
): TeamApiEnvelope | undefined {
  if (!isSafeMessageId(messageId)) {
    return fail(
      operation,
      'E_TEAM_API_INVALID_INPUT',
      'message_id must be a canonical identifier (no path separators or traversal)',
      { message_id: messageId },
    );
  }
  return undefined;
}

function bodyPath(store: TeamStateStore, messageId: string): string {
  const bodiesRoot = path.resolve(mailboxBodiesRoot(store));
  const target = path.resolve(bodiesRoot, `${messageId}.txt`);
  if (target !== bodiesRoot && !target.startsWith(`${bodiesRoot}${path.sep}`)) {
    throw new Error('message_id path escapes mailbox-bodies directory');
  }
  return target;
}

function writeBody(store: TeamStateStore, messageId: string, body: string): void {
  const target = bodyPath(store, messageId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWriteFile(target, Buffer.from(body, 'utf8'), { mode: 0o600 });
}

function readBody(store: TeamStateStore, messageId: string): string | undefined {
  if (!isSafeMessageId(messageId)) return undefined;
  const target = bodyPath(store, messageId);
  try {
    if (!fs.existsSync(target)) return undefined;
    return fs.readFileSync(target, 'utf8');
  } catch {
    return undefined;
  }
}

function writeBodyOrFail(
  operation: 'send-message',
  store: TeamStateStore,
  messageId: string,
  body: string,
): TeamApiEnvelope | undefined {
  const invalid = validateMessageIdOrFail(operation, messageId);
  if (invalid !== undefined) return invalid;
  try {
    writeBody(store, messageId, body);
    return undefined;
  } catch (error) {
    return fail(
      operation,
      'E_TEAM_API_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function serializeVerifiedMessages(
  operation: 'mailbox-list',
  store: TeamStateStore,
  messages: readonly MailboxMessageV1[],
): TeamApiEnvelope | Record<string, unknown>[] {
  const serialized: Record<string, unknown>[] = [];
  for (const message of messages) {
    const body = readBody(store, message.id);
    if (body === undefined || sha256(body) !== message.bodyDigest) {
      return fail(operation, 'E_TEAM_MAILBOX_CORRUPT', 'Mailbox body missing or digest mismatch', {
        message_id: message.id,
        body_missing: body === undefined,
      });
    }
    serialized.push(serializeMessage(message, body));
  }
  return serialized;
}

async function opSendMessage(
  operation: 'send-message',
  args: Record<string, unknown>,
  context: TeamApiContext,
): Promise<TeamApiEnvelope> {
  const fromWorker = requireString(args, 'from_worker');
  const toWorker = requireString(args, 'to_worker');
  const body = requireString(args, 'body');
  if (!fromWorker || !toWorker || !body) {
    return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'from_worker, to_worker, body are required');
  }
  const revision = readRevisionFor(operation, args, context.store);
  if (typeof revision !== 'number') return revision;

  const messageId = requireString(args, 'message_id') ?? `msg-${sha256(`${fromWorker}:${toWorker}:${body}:${nowMs(context)}`).slice(0, 16)}`;
  const messageIdError = validateMessageIdOrFail(operation, messageId);
  if (messageIdError !== undefined) return messageIdError;

  const createdAtMs = nowMs(context);
  const bodyDigest = sha256(body);
  const generation = args.generation;
  const claimToken = requireString(args, 'claim_token');
  const hasClaim = claimToken !== null;
  const hasGeneration = generation !== undefined;

  // Partial fencing is fail-closed — no silent unordered downgrade.
  if (hasClaim !== hasGeneration) {
    return fail(
      operation,
      'E_TEAM_API_INVALID_INPUT',
      'ordered send-message requires both claim_token and generation (or neither for unordered)',
    );
  }

  if (hasClaim && hasGeneration) {
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
      return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'generation must be a positive integer when provided');
    }
    const snapshot = context.store.read();
    if (!snapshot.ok) {
      return fail(operation, snapshot.error.code, snapshot.error.message, snapshot.error.details as Record<string, unknown> | undefined);
    }
    const task = snapshot.value.value.tasks[toWorker];
    if (task?.claim?.token !== claimToken || task.claim.generation !== generation) {
      return fail(operation, 'E_REVISION_CONFLICT', 'Task claim token or generation is stale', {
        task_id: toWorker,
      });
    }

    const bodyWriteError = writeBodyOrFail(operation, context.store, messageId, body);
    if (bodyWriteError !== undefined) return bodyWriteError;

    const result = await context.store.sendOrderedMailbox(revision, toWorker, generation, {
      schemaVersion: 1,
      id: messageId,
      sender: fromWorker,
      bodyDigest,
      createdAtMs,
    });
    if (!result.ok) {
      return fail(operation, result.error.code, result.error.message, result.error.details as Record<string, unknown> | undefined);
    }
    const message = result.value.value.mailbox[messageId]!;
    return {
      ok: true,
      operation,
      data: {
        message: serializeMessage(message, body),
        revision: result.value.revision,
      },
    };
  }

  const bodyWriteError = writeBodyOrFail(operation, context.store, messageId, body);
  if (bodyWriteError !== undefined) return bodyWriteError;

  const message: MailboxMessageV1 = {
    schemaVersion: 1,
    id: messageId,
    sender: fromWorker,
    recipient: toWorker,
    bodyDigest,
    createdAtMs,
  };
  const result = await context.store.sendMailbox(revision, message);
  if (!result.ok) {
    return fail(operation, result.error.code, result.error.message, result.error.details as Record<string, unknown> | undefined);
  }
  return {
    ok: true,
    operation,
    data: {
      message: serializeMessage(message, body),
      revision: result.value.revision,
    },
  };
}

function opMailboxList(
  operation: 'mailbox-list',
  args: Record<string, unknown>,
  context: TeamApiContext,
): TeamApiEnvelope {
  const worker = requireString(args, 'worker') ?? requireString(args, 'to_worker');
  if (!worker) {
    return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'worker is required');
  }
  const includeDelivered = args.include_delivered !== false;
  const claimToken = requireString(args, 'claim_token');
  const generation = args.generation;
  const afterCursor = args.after_cursor;
  const hasClaim = claimToken !== null;
  const hasGeneration = generation !== undefined;

  // Partial fencing is fail-closed (matches MCP mailbox.list contract).
  if (hasClaim !== hasGeneration) {
    return fail(
      operation,
      'E_TEAM_API_INVALID_INPUT',
      'ordered mailbox-list requires both claim_token and generation (or neither for unordered-only)',
    );
  }

  if (hasClaim && hasGeneration) {
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
      return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'generation must be a positive integer');
    }
    const cursor = afterCursor === undefined ? 0 : afterCursor;
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) {
      return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'after_cursor must be a non-negative integer');
    }
    const page = context.store.listOrderedMailbox({
      taskId: worker,
      claimToken: claimToken!,
      generation,
      afterCursor: cursor,
    });
    if (!page.ok) {
      return fail(operation, page.error.code, page.error.message, page.error.details as Record<string, unknown> | undefined);
    }
    const filtered = page.value.messages
      .filter((message) => includeDelivered || message.deliveredAtMs === undefined);
    const messagesOrFail = serializeVerifiedMessages(operation, context.store, filtered);
    if (!Array.isArray(messagesOrFail)) return messagesOrFail;
    return {
      ok: true,
      operation,
      data: {
        worker,
        count: messagesOrFail.length,
        cursor: page.value.cursor,
        messages: messagesOrFail,
      },
    };
  }

  // Unfenced path: unordered messages only (no sequence). Ordered traffic
  // must use claim_token + generation — never leak ordered plaintext bodies.
  const snapshot = context.store.read();
  if (!snapshot.ok) {
    return fail(operation, snapshot.error.code, snapshot.error.message, snapshot.error.details as Record<string, unknown> | undefined);
  }
  const all = Object.values(snapshot.value.value.mailbox)
    .filter((message) => message.recipient === worker && message.sequence === undefined);
  const filtered = includeDelivered ? all : all.filter((message) => message.deliveredAtMs === undefined);
  const sorted = filtered.slice().sort((left, right) => left.createdAtMs - right.createdAtMs);
  const messagesOrFail = serializeVerifiedMessages(operation, context.store, sorted);
  if (!Array.isArray(messagesOrFail)) return messagesOrFail;
  return {
    ok: true,
    operation,
    data: { worker, count: messagesOrFail.length, messages: messagesOrFail, mode: 'unordered' },
  };
}

async function opMailboxMarkDelivered(
  operation: 'mailbox-mark-delivered',
  args: Record<string, unknown>,
  context: TeamApiContext,
): Promise<TeamApiEnvelope> {
  const worker = requireString(args, 'worker');
  const messageId = requireString(args, 'message_id');
  if (!worker || !messageId) {
    return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'worker and message_id are required');
  }
  const revision = readRevisionFor(operation, args, context.store);
  if (typeof revision !== 'number') return revision;

  const snapshot = context.store.read();
  if (!snapshot.ok) {
    return fail(operation, snapshot.error.code, snapshot.error.message);
  }
  const existing = snapshot.value.value.mailbox[messageId];
  if (existing === undefined || existing.recipient !== worker) {
    return fail(operation, 'E_NOT_FOUND', 'Mailbox message not found for worker', { worker, message_id: messageId });
  }

  const claimToken = requireString(args, 'claim_token');
  const generation = args.generation;
  const hasClaim = claimToken !== null;
  const hasGeneration = generation !== undefined;
  if (hasClaim !== hasGeneration) {
    return fail(
      operation,
      'E_TEAM_API_INVALID_INPUT',
      'ordered mailbox-mark-delivered requires both claim_token and generation (or neither for unordered)',
    );
  }

  const isOrdered = existing.sequence !== undefined;
  if (isOrdered && (!hasClaim || !hasGeneration)) {
    return fail(
      operation,
      'E_TEAM_API_INVALID_INPUT',
      'ordered mailbox messages require claim_token + generation before mark-delivered',
      { worker, message_id: messageId },
    );
  }

  // Ordered: prove claim first (no delivered side-effect on bad token), then mark+ack.
  if (isOrdered && hasClaim && typeof generation === 'number') {
    const mailboxCursor = (snapshot.value.value.mailboxCursors ?? {})[worker];
    const proveAfterCursor = typeof args.after_cursor === 'number'
      ? args.after_cursor
      : (mailboxCursor?.generation === generation ? mailboxCursor.cursor : 0);
    if (typeof proveAfterCursor !== 'number' || !Number.isSafeInteger(proveAfterCursor) || proveAfterCursor < 0) {
      return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'after_cursor must be a non-negative integer');
    }
    const prove = context.store.listOrderedMailbox({
      taskId: worker,
      claimToken: claimToken!,
      generation,
      afterCursor: proveAfterCursor,
    });
    if (!prove.ok) {
      return fail(operation, prove.error.code, prove.error.message, prove.error.details as Record<string, unknown> | undefined);
    }
    const delivered = await context.store.markMailboxDelivered(revision, messageId, nowMs(context));
    if (!delivered.ok) {
      return fail(operation, delivered.error.code, delivered.error.message, delivered.error.details as Record<string, unknown> | undefined);
    }
    const expectedCursor = typeof args.expected_cursor === 'number'
      ? args.expected_cursor
      : existing.sequence! - 1;
    const ackResult = await context.store.acknowledgeOrderedMailbox({
      expectedRevision: delivered.value.revision,
      taskId: worker,
      claimToken: claimToken!,
      generation,
      expectedCursor,
      nextCursor: existing.sequence!,
      messageIds: [messageId],
      acknowledgedAtMs: nowMs(context),
    });
    if (!ackResult.ok) {
      return fail(operation, ackResult.error.code, ackResult.error.message, ackResult.error.details as Record<string, unknown> | undefined);
    }
    return {
      ok: true,
      operation,
      data: {
        worker,
        message_id: messageId,
        updated: true,
        revision: ackResult.value.revision,
        ack: {
          acknowledged: true,
          next_cursor: existing.sequence,
          revision: ackResult.value.revision,
        },
      },
    };
  }

  const delivered = await context.store.markMailboxDelivered(revision, messageId, nowMs(context));
  if (!delivered.ok) {
    return fail(operation, delivered.error.code, delivered.error.message, delivered.error.details as Record<string, unknown> | undefined);
  }

  return {
    ok: true,
    operation,
    data: {
      worker,
      message_id: messageId,
      updated: true,
      revision: delivered.value.revision,
      ack: null,
    },
  };
}

async function opCreateTask(
  operation: 'create-task',
  args: Record<string, unknown>,
  context: TeamApiContext,
): Promise<TeamApiEnvelope> {
  const subject = requireString(args, 'subject');
  const description = requireString(args, 'description');
  if (!subject || !description) {
    return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'subject and description are required');
  }
  const revision = readRevisionFor(operation, args, context.store);
  if (typeof revision !== 'number') return revision;

  let taskId = requireString(args, 'task_id');
  if (taskId === null) {
    const slug = subject
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    taskId = isCanonicalTeamIdentifier(slug) ? slug : `task-${sha256(subject).slice(0, 12)}`;
  } else if (!isCanonicalTeamIdentifier(taskId)) {
    return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'task_id must be a canonical team identifier');
  }

  const blockedBy = args.blocked_by;
  const dependencies: string[] = [];
  if (blockedBy !== undefined) {
    if (!Array.isArray(blockedBy) || !blockedBy.every((entry) => typeof entry === 'string' && isCanonicalTeamIdentifier(entry))) {
      return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'blocked_by must be an array of task ids');
    }
    dependencies.push(...blockedBy);
  }

  const task: CanonicalTeamTaskV1 = {
    id: taskId,
    dependencies,
    write_scope: 'none',
    mode: 'read_only',
    verification: { version: 1, commands: [], requiredArtifacts: [] },
    subject,
    description,
  };

  const result = await context.store.createTask(revision, task);
  if (!result.ok) {
    return fail(operation, result.error.code, result.error.message, result.error.details as Record<string, unknown> | undefined);
  }
  const runtime = result.value.value.tasks[taskId]!;
  return {
    ok: true,
    operation,
    data: {
      task: {
        id: taskId,
        subject,
        description,
        status: runtime.status,
        dependencies,
        mode: task.mode,
        write_scope: task.write_scope,
      },
      revision: result.value.revision,
    },
  };
}

function opListTasks(
  operation: 'list-tasks',
  context: TeamApiContext,
): TeamApiEnvelope {
  const snapshot = context.store.read();
  if (!snapshot.ok) {
    return fail(operation, snapshot.error.code, snapshot.error.message);
  }
  const tasks = Object.values(snapshot.value.value.tasks).map((task) => {
    const spec = snapshot.value.value.manifest.tasks.find((entry) => entry.id === task.id);
    return {
      id: task.id,
      status: task.status,
      revision: task.revision,
      claim: task.claim === undefined
        ? null
        : {
            owner_id: task.claim.ownerId,
            generation: task.claim.generation,
            leased_until_ms: task.claim.leasedUntilMs,
            // token intentionally omitted from list
          },
      dependencies: spec?.dependencies ?? [],
      mode: spec?.mode ?? null,
      subject: spec?.subject ?? null,
      description: spec?.description ?? null,
    };
  });
  return {
    ok: true,
    operation,
    data: { count: tasks.length, tasks, revision: snapshot.value.revision },
  };
}

async function opClaimTask(
  operation: 'claim-task',
  args: Record<string, unknown>,
  context: TeamApiContext,
): Promise<TeamApiEnvelope> {
  const taskId = requireString(args, 'task_id');
  const worker = requireString(args, 'worker');
  if (!taskId || !worker) {
    return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'task_id and worker are required');
  }
  const revision = readRevisionFor(operation, args, context.store);
  if (typeof revision !== 'number') return revision;
  const leaseMs = typeof args.lease_ms === 'number' && Number.isSafeInteger(args.lease_ms) && args.lease_ms > 0
    ? args.lease_ms
    : (context.defaultLeaseMs ?? 60_000);
  const claimToken = requireString(args, 'claim_token') ?? newClaimToken(context);
  const result = await context.store.claimTask(
    taskId,
    worker,
    revision,
    nowMs(context),
    leaseMs,
    claimToken,
  );
  if (!result.ok) {
    return fail(operation, result.error.code, result.error.message, result.error.details as Record<string, unknown> | undefined);
  }
  const task = result.value.value.tasks[taskId]!;
  return {
    ok: true,
    operation,
    data: {
      task_id: taskId,
      worker,
      claim_token: claimToken,
      generation: task.claim!.generation,
      leased_until_ms: task.claim!.leasedUntilMs,
      status: task.status,
      revision: result.value.revision,
    },
  };
}

async function opTransitionTaskStatus(
  operation: 'transition-task-status',
  args: Record<string, unknown>,
  context: TeamApiContext,
): Promise<TeamApiEnvelope> {
  const taskId = requireString(args, 'task_id');
  const from = requireString(args, 'from');
  const to = requireString(args, 'to');
  const claimToken = requireString(args, 'claim_token');
  if (!taskId || !from || !to || !claimToken) {
    return fail(
      operation,
      'E_TEAM_API_INVALID_INPUT',
      'task_id, from, to, claim_token are required',
    );
  }
  const revision = readRevisionFor(operation, args, context.store);
  if (typeof revision !== 'number') return revision;

  const snapshot = context.store.read();
  if (!snapshot.ok) {
    return fail(operation, snapshot.error.code, snapshot.error.message);
  }
  const task = snapshot.value.value.tasks[taskId];
  if (task === undefined) {
    return fail(operation, 'E_NOT_FOUND', 'Team task does not exist', { taskId });
  }
  if (task.claim === undefined) {
    return fail(operation, 'E_REVISION_CONFLICT', 'Task has no active claim; claim_token required', { taskId });
  }
  // Token rule: wrong token must fail closed.
  if (task.claim.token !== claimToken) {
    return fail(operation, 'E_REVISION_CONFLICT', 'Task claim token or generation is stale', { taskId });
  }

  const result = await context.store.transitionTaskStatus({
    taskId,
    expectedRevision: revision,
    from: from as TeamTaskStatus,
    to: to as TeamTaskStatus,
    claimToken,
    generation: task.claim.generation,
  });
  if (!result.ok) {
    return fail(operation, result.error.code, result.error.message, result.error.details as Record<string, unknown> | undefined);
  }
  return {
    ok: true,
    operation,
    data: {
      task_id: taskId,
      from,
      to,
      status: result.value.value.tasks[taskId]!.status,
      revision: result.value.revision,
    },
  };
}

async function opReleaseTaskClaim(
  operation: 'release-task-claim',
  args: Record<string, unknown>,
  context: TeamApiContext,
): Promise<TeamApiEnvelope> {
  const taskId = requireString(args, 'task_id');
  const claimToken = requireString(args, 'claim_token');
  const worker = requireString(args, 'worker');
  if (!taskId || !claimToken || !worker) {
    return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'task_id, claim_token, worker are required');
  }
  const revision = readRevisionFor(operation, args, context.store);
  if (typeof revision !== 'number') return revision;

  const snapshot = context.store.read();
  if (!snapshot.ok) {
    return fail(operation, snapshot.error.code, snapshot.error.message);
  }
  const task = snapshot.value.value.tasks[taskId];
  if (task?.claim === undefined) {
    return fail(operation, 'E_REVISION_CONFLICT', 'Task has no active claim', { taskId });
  }
  if (task.claim.token !== claimToken) {
    return fail(operation, 'E_REVISION_CONFLICT', 'Task claim token or generation is stale', { taskId });
  }
  if (task.claim.ownerId !== worker) {
    return fail(operation, 'E_REVISION_CONFLICT', 'Claim owner does not match worker', {
      taskId,
      worker,
      owner_id: task.claim.ownerId,
    });
  }

  const result = await context.store.releaseTaskClaim({
    taskId,
    expectedRevision: revision,
    claimToken,
    generation: task.claim.generation,
  });
  if (!result.ok) {
    return fail(operation, result.error.code, result.error.message, result.error.details as Record<string, unknown> | undefined);
  }
  return {
    ok: true,
    operation,
    data: {
      task_id: taskId,
      worker,
      status: result.value.value.tasks[taskId]!.status,
      revision: result.value.revision,
    },
  };
}

function opGetSummary(
  operation: 'get-summary',
  context: TeamApiContext,
): TeamApiEnvelope {
  const snapshot = context.store.read();
  if (!snapshot.ok) {
    return fail(operation, snapshot.error.code, snapshot.error.message);
  }
  const summary = context.store.summary();
  return {
    ok: true,
    operation,
    data: {
      team_id: snapshot.value.value.teamId,
      revision: snapshot.value.revision,
      complete: summary.complete,
      blockers: summary.blockers,
      task_count: Object.keys(snapshot.value.value.tasks).length,
      mailbox_count: Object.keys(snapshot.value.value.mailbox).length,
    },
  };
}

function opWriteWorkerInbox(
  operation: 'write-worker-inbox',
  args: Record<string, unknown>,
  context: TeamApiContext,
): TeamApiEnvelope {
  const worker = requireString(args, 'worker');
  const content = typeof args.content === 'string' ? args.content : null;
  if (!worker || content === null || content.trim() === '') {
    return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'worker and content are required');
  }

  const snapshot = context.store.read();
  if (!snapshot.ok) {
    return fail(
      operation,
      snapshot.error.code,
      snapshot.error.message,
      snapshot.error.details as Record<string, unknown> | undefined,
    );
  }

  if (!isCanonicalTeamIdentifier(worker) && worker !== 'leader-fixed') {
    // Allow leader-fixed OMX alias; otherwise require safe worker id.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(worker)) {
      return fail(operation, 'E_TEAM_API_INVALID_INPUT', 'worker id is invalid');
    }
  }

  const teamDir = context.store.teamDirectory();
  const target = path.resolve(teamDir, 'workers', worker, 'inbox.md');
  if (target !== teamDir && !target.startsWith(`${teamDir}${path.sep}`)) {
    return fail(operation, 'E_PATH_OUTSIDE_ROOT', 'Worker inbox path escapes team directory');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWriteFile(target, Buffer.from(content, 'utf8'), { mode: 0o600 });
  return {
    ok: true,
    operation,
    data: {
      worker,
      path: target,
      bytes: Buffer.byteLength(content, 'utf8'),
    },
  };
}
