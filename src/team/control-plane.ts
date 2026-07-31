import { WorkerEnvelopeV1, validateWorkerEnvelope } from '../contracts/worker-envelope';
import {
  HostCapabilityProfileV1,
  HostRouteReceiptV1,
  validateHostRouteReceipt,
} from '../native/capability-profile';
import { sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, Snapshot, err, ok } from '../runtime/types';
import { buildAgy115Argv } from './agy-argv';
import { TeamStateStore } from './state';
import {
  ProcessMarkerV1,
  TeamAggregateV1,
  WorkerAuthorityBindingV1,
  WorkerPaneReceiptV1,
} from './types';

export interface PrepareWorkerControlInputV1 {
  envelope: WorkerEnvelopeV1;
  profile: HostCapabilityProfileV1;
  receipt: HostRouteReceiptV1;
  validation: {
    now: string;
    contextDigest: string;
    identityDigest: string;
    fallbackPreconditionsSatisfied: boolean;
  };
  claimToken: string;
  boundAtMs: number;
  process?: ProcessMarkerV1;
  pane?: WorkerPaneReceiptV1;
  conversationId?: string;
  boundedDuration?: string;
}

export interface PreparedWorkerControlV1 {
  envelope: WorkerEnvelopeV1;
  binding: WorkerAuthorityBindingV1;
  launch?: {
    executable: string;
    argv: readonly string[];
    shell: false;
  };
}

export function prepareWorkerControl(
  input: Readonly<PrepareWorkerControlInputV1>,
): Result<PreparedWorkerControlV1, RuntimeError> {
  let envelope: WorkerEnvelopeV1;
  try { envelope = validateWorkerEnvelope(input.envelope); } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'Worker control envelope is invalid', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
  let receipt: HostRouteReceiptV1;
  try {
    receipt = validateHostRouteReceipt(input.receipt, input.profile, {
      ...input.validation,
      generation: envelope.generation,
    });
  } catch (error) {
    return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Worker control route receipt is invalid', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
  if (receipt.provider !== envelope.provider
    || receipt.profileDigest !== envelope.provider_profile_digest
    || receipt.receiptDigest !== envelope.route_receipt_digest
    || !Number.isSafeInteger(input.boundAtMs) || input.boundAtMs < 0) {
    return err(runtimeError('E_REVISION_CONFLICT', 'Worker route receipt does not match envelope generation'));
  }
  if (receipt.provider === 'antigravity_native') {
    return err(runtimeError('E_NATIVE_ADAPTER_UNAVAILABLE', 'Antigravity native worker adapter is unavailable', {
      provider: 'antigravity_native', adapterImplemented: false,
    }));
  }

  const binding: WorkerAuthorityBindingV1 = {
    schemaVersion: 1,
    taskId: envelope.task_id,
    claimTokenDigest: sha256(input.claimToken),
    generation: envelope.generation,
    provider: envelope.provider,
    providerProfileDigest: receipt.profileDigest,
    providerReceiptHash: receipt.receiptDigest,
    ...(input.process === undefined ? {} : { process: input.process }),
    ...(input.pane === undefined ? {} : { pane: input.pane }),
    state: 'claimed',
    transitionSequence: 0,
    boundAtMs: input.boundAtMs,
  };

  if (envelope.provider === 'agy_headless') {
    if (binding.process === undefined || binding.pane !== undefined) {
      return err(runtimeError('E_PROCESS_IDENTITY_UNPROVEN', 'Headless worker requires an exact process receipt and no pane'));
    }
  } else if (binding.process === undefined || binding.pane === undefined) {
    return err(runtimeError('E_PROCESS_IDENTITY_UNPROVEN', 'Tmux worker requires exact process and pane receipts'));
  }
  const argv = buildAgy115Argv({
    launchMode: envelope.provider === 'agy_headless' ? 'headless' : 'interactive',
    capabilityMode: envelope.capability_mode,
    prompt: envelope.task_text,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.boundedDuration === undefined ? {} : { boundedDuration: input.boundedDuration }),
  });
  if (!argv.ok) return argv;
  return ok({
    envelope,
    binding,
    launch: { executable: receipt.resolvedExecutable, argv: argv.value, shell: false },
  });
}

export function bindPreparedWorker(
  store: TeamStateStore,
  prepared: Readonly<PreparedWorkerControlV1>,
  expectedRevision: number,
  claimToken: string,
): Promise<Result<Snapshot<TeamAggregateV1>, RuntimeError>> {
  if (prepared.binding.claimTokenDigest !== sha256(claimToken)) {
    return Promise.resolve(err(runtimeError('E_REVISION_CONFLICT', 'Prepared worker claim capability is stale')));
  }
  return store.bindWorkerAuthority(expectedRevision, claimToken, prepared.binding);
}
