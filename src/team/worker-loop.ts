import { WorkerEnvelopeV1, validateWorkerEnvelope } from '../contracts/worker-envelope';
import { canonicalJson, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { MailboxMessageV1 } from './types';

export interface VerificationOutcomeV1 {
  argv: readonly string[];
  exitCode: number;
  stdoutHash: string;
  stderrHash: string;
  artifactHash: string;
}

export interface WorkerLoopHost {
  heartbeat(): Promise<Result<void, RuntimeError>>;
  listMailbox(cursor: number): Promise<Result<readonly MailboxMessageV1[], RuntimeError>>;
  readMailbox(message: Readonly<MailboxMessageV1>): Promise<Result<string, RuntimeError>>;
  acknowledgeMailbox(messageIds: readonly string[], nextCursor: number): Promise<Result<void, RuntimeError>>;
  recordProgress(kind: 'checkpoint' | 'artifact' | 'verification', artifactHash: string): Promise<Result<void, RuntimeError>>;
  transition(
    expected: 'claimed' | 'launched' | 'running' | 'verifying' | 'delivery_ready',
    next: 'launched' | 'running' | 'verifying' | 'delivery_ready' | 'integration_requested',
  ): Promise<Result<void, RuntimeError>>;
  runVerification(argv: readonly string[], deadlineMs: number): Promise<Result<VerificationOutcomeV1, RuntimeError>>;
  recordCommandEvidence(outcome: Readonly<VerificationOutcomeV1>): Promise<Result<void, RuntimeError>>;
  createImmutableDelivery(): Promise<Result<{ deliveryDigest: string }, RuntimeError>>;
  requestIntegration(deliveryDigest: string): Promise<Result<{ integrationReceiptHash: string }, RuntimeError>>;
  cleanupCapabilityPlaintext(): Promise<Result<void, RuntimeError>>;
  terminal(
    outcome: 'completed' | 'failed' | 'cancelled',
    materialHash: string,
  ): Promise<Result<void, RuntimeError>>;
}

export interface WorkerLoopResultV1 {
  outcome: 'completed';
  deliveryDigest: string;
  integrationReceiptHash: string;
  mailboxCursor: number;
  commandCount: number;
}

/**
 * Provider-independent worker protocol.  All canonical mutations are delegated
 * to a CLI authority host; the worker itself cannot manufacture completion.
 */
export async function runWorkerProtocolLoop(
  envelopeInput: unknown,
  host: WorkerLoopHost,
): Promise<Result<WorkerLoopResultV1, RuntimeError>> {
  let envelope: WorkerEnvelopeV1;
  try { envelope = validateWorkerEnvelope(envelopeInput); } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'Worker loop envelope is invalid', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }

  let cursor = envelope.mailbox_cursor;
  let cleanupAttempted = false;
  const fail = async (cause: RuntimeError): Promise<Result<WorkerLoopResultV1, RuntimeError>> => {
    const cleanup = await host.cleanupCapabilityPlaintext();
    cleanupAttempted = true;
    if (!cleanup.ok) return err(cleanup.error);
    const terminal = await host.terminal('failed', sha256(canonicalJson(cause)));
    return terminal.ok ? err(cause) : err(terminal.error);
  };

  const launch = await host.transition('claimed', 'launched');
  if (!launch.ok) return fail(launch.error);
  const initialHeartbeat = await host.heartbeat();
  if (!initialHeartbeat.ok) return fail(initialHeartbeat.error);
  const running = await host.transition('launched', 'running');
  if (!running.ok) return fail(running.error);

  const listed = await host.listMailbox(cursor);
  if (!listed.ok) return fail(listed.error);
  const acknowledged: string[] = [];
  for (const message of listed.value) {
    const expectedSequence = cursor + acknowledged.length + 1;
    if (message.sequence !== expectedSequence || message.generation !== envelope.generation) {
      return fail(runtimeError('E_REVISION_CONFLICT', 'Mailbox batch is stale or out of order'));
    }
    const body = await host.readMailbox(message);
    if (!body.ok) return fail(body.error);
    if (sha256(body.value) !== message.bodyDigest) {
      return fail(runtimeError('E_CORRUPT_STATE', 'Mailbox body digest does not match'));
    }
    acknowledged.push(message.id);
  }
  if (acknowledged.length > 0) {
    cursor += acknowledged.length;
    const ack = await host.acknowledgeMailbox(acknowledged, cursor);
    if (!ack.ok) return fail(ack.error);
  }

  const progress = await host.recordProgress('checkpoint', sha256(canonicalJson({
    task: envelope.task_id,
    cursor,
    dependencies: envelope.dependencies,
  })));
  if (!progress.ok) return fail(progress.error);
  const liveBeforeVerify = await host.heartbeat();
  if (!liveBeforeVerify.ok) return fail(liveBeforeVerify.error);
  const verifying = await host.transition('running', 'verifying');
  if (!verifying.ok) return fail(verifying.error);

  let commandCount = 0;
  for (const argv of envelope.verification_argv) {
    const outcome = await host.runVerification(argv, envelope.deadline_ms);
    if (!outcome.ok) return fail(outcome.error);
    const recorded = await host.recordCommandEvidence(outcome.value);
    if (!recorded.ok) return fail(recorded.error);
    commandCount += 1;
    if (outcome.value.exitCode !== 0) {
      return fail(runtimeError('E_VALIDATOR_REJECTED', 'Worker verification command failed', {
        argvHash: sha256(canonicalJson(argv)),
        exitCode: outcome.value.exitCode,
      }));
    }
    const live = await host.heartbeat();
    if (!live.ok) return fail(live.error);
  }
  const verified = await host.recordProgress('verification', sha256(canonicalJson({
    required: envelope.artifact_contract.required_files,
    commandCount,
  })));
  if (!verified.ok) return fail(verified.error);

  const delivery = await host.createImmutableDelivery();
  if (!delivery.ok) return fail(delivery.error);
  const deliveryReady = await host.transition('verifying', 'delivery_ready');
  if (!deliveryReady.ok) return fail(deliveryReady.error);
  const deliveryProgress = await host.recordProgress('artifact', delivery.value.deliveryDigest);
  if (!deliveryProgress.ok) return fail(deliveryProgress.error);
  const integration = await host.requestIntegration(delivery.value.deliveryDigest);
  if (!integration.ok) return fail(integration.error);
  const requested = await host.transition('delivery_ready', 'integration_requested');
  if (!requested.ok) return fail(requested.error);

  const cleanup = await host.cleanupCapabilityPlaintext();
  cleanupAttempted = true;
  if (!cleanup.ok) return err(cleanup.error);
  const terminal = await host.terminal('completed', integration.value.integrationReceiptHash);
  if (!terminal.ok) return err(terminal.error);
  if (!cleanupAttempted) {
    return err(runtimeError('E_TERMINAL_STATE', 'Worker terminalization requires capability cleanup'));
  }
  return ok({
    outcome: 'completed',
    deliveryDigest: delivery.value.deliveryDigest,
    integrationReceiptHash: integration.value.integrationReceiptHash,
    mailboxCursor: cursor,
    commandCount,
  });
}
