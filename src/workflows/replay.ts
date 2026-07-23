import * as fs from 'fs';
import * as path from 'path';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import { WORKFLOW_TERMINALS_V1 } from '../contracts/repository-workflow';
import {
  appendJsonLineUnderLock,
  withDurableJsonLineLock,
} from '../runtime/atomic';
import {
  WORKFLOW_JOURNAL_SCHEMA_V1,
  WORKFLOW_RUN_SCHEMA_V1,
  WorkflowJournalEventKindV1,
  WorkflowJournalEventV1,
  WorkflowPlanV1,
  WorkflowRunSnapshotV1,
  WorkflowTaskReceiptV1,
  createWorkflowJournalEvent,
  workflowJournalEventHash,
} from './schema';

export const MAX_WORKFLOW_JOURNAL_EVENTS_V1 = 100_000;
export const MAX_WORKFLOW_JOURNAL_LINE_BYTES_V1 = 1_048_576;

export function initializeWorkflowRun(plan: Readonly<WorkflowPlanV1>): WorkflowRunSnapshotV1 {
  return {
    store_kind: 'oma_repository_workflow_run',
    schema_version: 1,
    contract: WORKFLOW_RUN_SCHEMA_V1,
    repository_id: 'OMA',
    run_id: plan.run_id,
    plan_digest: plan.plan_digest,
    revision: 0,
    journal_head: null,
    tasks: Object.fromEntries(plan.tasks.map((task) => [task.task_id, {
      task,
      status: 'pending',
      attempts: 0,
      envelope_digest: null,
      receipt: null,
    }])),
    terminal: null,
    warnings: [],
  };
}

export function replayWorkflowEvents(
  plan: Readonly<WorkflowPlanV1>,
  events: readonly WorkflowJournalEventV1[],
  options: { allow_reconciliation?: boolean; allow_product_ship?: boolean } = {},
): WorkflowRunSnapshotV1 {
  const snapshot = initializeWorkflowRun(plan);
  const seen = new Set<string>();
  let previous: string | null = null;
  try {
    if (events.length > MAX_WORKFLOW_JOURNAL_EVENTS_V1) {
      throw new Error('journal exceeds event bound');
    }
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      validateEvent(event, plan.run_id, index, previous);
      if (seen.has(event.event_hash)) throw new Error('duplicate event hash');
      seen.add(event.event_hash);
      applyEvent(snapshot, plan, event, options);
      previous = event.event_hash;
      snapshot.revision += 1;
      snapshot.journal_head = event.event_hash;
    }
  } catch (error) {
    snapshot.terminal = 'effect_unknown';
    snapshot.warnings.push(`E_WORKFLOW_JOURNAL_CORRUPT:${error instanceof Error ? error.message : String(error)}`);
    return snapshot;
  }
  for (const runtime of Object.values(snapshot.tasks)) {
    if (runtime.status !== 'dispatched') continue;
    const stageEvent = [...events].reverse().find((event) =>
      event.kind === 'task_dispatched' && event.task_id === runtime.task.task_id);
    const effectTypes = stringArray(stageEvent?.payload.external_effect_types ?? []);
    if (effectTypes.length > 0) {
      if (options.allow_reconciliation === true) {
        snapshot.warnings.push(`W_WORKFLOW_EFFECT_RECONCILIATION_REQUIRED:${runtime.task.task_id}`);
        continue;
      }
      runtime.status = 'effect_unknown';
      runtime.receipt = {
        task_id: runtime.task.task_id,
        attempt: runtime.attempts,
        status: 'effect_unknown',
        result_hash: null,
        artifact_roots: [],
        approval: null,
        ship_proof_digest: null,
        external_effect_types: effectTypes,
        effect_receipt_digests: [],
        permission_denied: false,
      };
      snapshot.terminal = 'effect_unknown';
      snapshot.warnings.push(`W_WORKFLOW_EFFECT_UNRECONCILED:${runtime.task.task_id}`);
    } else {
      snapshot.warnings.push(`W_WORKFLOW_DISPATCH_INTERRUPTED:${runtime.task.task_id}`);
    }
  }
  return snapshot;
}

export function readWorkflowJournal(journalPath: string): WorkflowJournalEventV1[] {
  if (!fs.existsSync(journalPath)) return [];
  const stat = fs.lstatSync(journalPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) {
    throw new Error('E_WORKFLOW_JOURNAL: journal must be a bounded regular non-symlink file');
  }
  const bytes = fs.readFileSync(journalPath);
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0x0a) throw new Error('E_WORKFLOW_JOURNAL: journal ends with a torn line');
  const lines = bytes.toString('utf8').slice(0, -1).split('\n');
  if (lines.length > MAX_WORKFLOW_JOURNAL_EVENTS_V1) throw new Error('E_WORKFLOW_JOURNAL: too many events');
  return lines.map((line, index) => {
    if (Buffer.byteLength(line, 'utf8') > MAX_WORKFLOW_JOURNAL_LINE_BYTES_V1) {
      throw new Error(`E_WORKFLOW_JOURNAL: line ${index} exceeds the byte bound`);
    }
    const parsed = JSON.parse(line) as WorkflowJournalEventV1;
    if (!canonicalBytesV1(parsed).equals(Buffer.from(line, 'utf8'))) {
      throw new Error(`E_WORKFLOW_JOURNAL: line ${index} is not canonical JSON`);
    }
    return parsed;
  });
}

export function appendWorkflowJournalEvent(input: {
  journal_path: string;
  run_id: string;
  kind: WorkflowJournalEventKindV1;
  task_id: string | null;
  payload: Readonly<Record<string, unknown>>;
}): WorkflowJournalEventV1 {
  const absolute = path.resolve(input.journal_path);
  return withDurableJsonLineLock(absolute, () => {
    const events = readWorkflowJournal(absolute);
    const previous = events.at(-1)?.event_hash ?? null;
    const event = createWorkflowJournalEvent({
      run_id: input.run_id,
      sequence: events.length,
      previous_event_hash: previous,
      kind: input.kind,
      task_id: input.task_id,
      payload: input.payload,
    });
    appendJsonLineUnderLock(absolute, event);
    return event;
  });
}

function validateEvent(
  event: WorkflowJournalEventV1,
  runId: string,
  sequence: number,
  previous: string | null,
): void {
  if (event.store_kind !== 'oma_repository_workflow_event'
    || event.schema_version !== 1 || event.contract !== WORKFLOW_JOURNAL_SCHEMA_V1
    || event.repository_id !== 'OMA' || event.run_id !== runId
    || event.sequence !== sequence || event.previous_event_hash !== previous
    || event.event_hash !== workflowJournalEventHash(stripEventHash(event))) {
    throw new Error(`invalid event at sequence ${sequence}`);
  }
}

function applyEvent(
  snapshot: WorkflowRunSnapshotV1,
  plan: Readonly<WorkflowPlanV1>,
  event: WorkflowJournalEventV1,
  options: { allow_product_ship?: boolean },
): void {
  if (snapshot.terminal !== null) throw new Error('event exists after terminal');
  if (event.kind === 'run_started') {
    if (event.sequence !== 0 || event.task_id !== null || event.payload.plan_digest !== plan.plan_digest) {
      throw new Error('run_started does not bind the immutable plan');
    }
    return;
  }
  if (event.kind === 'run_terminal') {
    if (event.task_id !== null
      || !(WORKFLOW_TERMINALS_V1 as readonly unknown[]).includes(event.payload.terminal)
      || (event.payload.terminal === 'ship' && options.allow_product_ship !== true)) {
      throw new Error('invalid workflow terminal event');
    }
    snapshot.terminal = event.payload.terminal as WorkflowRunSnapshotV1['terminal'];
    return;
  }
  if (event.task_id === null || snapshot.tasks[event.task_id] === undefined) {
    throw new Error('task event references an unknown task');
  }
  const runtime = snapshot.tasks[event.task_id];
  if (event.kind === 'task_dispatched') {
    const attempt = integer(event.payload.attempt);
    const envelopeDigest = digest(event.payload.envelope_digest);
    if (runtime.status !== 'pending' || attempt !== runtime.attempts + 1) {
      throw new Error('task dispatch is stale or duplicated');
    }
    runtime.status = 'dispatched';
    runtime.attempts = attempt;
    runtime.envelope_digest = envelopeDigest;
    runtime.receipt = null;
    stringArray(event.payload.external_effect_types ?? []);
    return;
  }
  if (event.kind === 'task_requeued') {
    if (runtime.status !== 'failed' || integer(event.payload.after_attempt) !== runtime.attempts) {
      throw new Error('task retry is stale or not failure-driven');
    }
    runtime.status = 'pending';
    runtime.receipt = null;
    return;
  }
  if (event.kind === 'task_receipt') {
    if (runtime.status !== 'dispatched') throw new Error('receipt has no dispatch intent');
    const receipt = parseReceipt(event.payload.receipt, event.task_id);
    if (receipt.attempt !== runtime.attempts) throw new Error('receipt attempt is stale');
    runtime.status = receipt.status;
    runtime.receipt = receipt;
    return;
  }
}

function parseReceipt(value: unknown, taskId: string): WorkflowTaskReceiptV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('receipt is not an object');
  }
  const receipt = value as WorkflowTaskReceiptV1;
  const statuses = ['passed', 'failed', 'blocked', 'skipped', 'effect_unknown'];
  if (receipt.task_id !== taskId || !statuses.includes(receipt.status)
    || !Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1
    || (receipt.result_hash !== null && !/^[a-f0-9]{64}$/.test(receipt.result_hash))
    || (receipt.ship_proof_digest !== null && !/^[a-f0-9]{64}$/.test(receipt.ship_proof_digest))
    || (receipt.approval !== null && typeof receipt.approval !== 'boolean')
    || typeof receipt.permission_denied !== 'boolean') {
    throw new Error('receipt fields are invalid');
  }
  for (const artifact of stringArray(receipt.artifact_roots)) {
    if (artifact === '..' || artifact.startsWith('../') || path.isAbsolute(artifact)) {
      throw new Error('receipt artifact root escapes repository');
    }
  }
  stringArray(receipt.external_effect_types);
  for (const effect of stringArray(receipt.effect_receipt_digests)) digest(effect);
  return JSON.parse(JSON.stringify(receipt)) as WorkflowTaskReceiptV1;
}

function stripEventHash(event: WorkflowJournalEventV1): Omit<WorkflowJournalEventV1, 'event_hash'> {
  const { event_hash: ignored, ...material } = event;
  void ignored;
  return material;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid digest');
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('invalid integer');
  return value as number;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100
    || value.some((entry) => typeof entry !== 'string' || entry.trim() === '' || entry.includes('\0'))
    || new Set(value).size !== value.length) {
    throw new Error('invalid string array');
  }
  return value as string[];
}
