import { WorkerEnvelopeV1 } from '../../src/contracts/worker-envelope';
import { sha256 } from '../../src/runtime/atomic';
import { runtimeError } from '../../src/runtime/errors';
import { err, ok } from '../../src/runtime/types';
import { WorkerLoopHost, runWorkerProtocolLoop } from '../../src/team/worker-loop';

function envelope(): WorkerEnvelopeV1 {
  return {
    store_kind: 'oma_worker_envelope', schema_version: 1, repository_id: 'OMA', run_id: 'run',
    team_id: 'team', task_id: 'task', task_text: 'Execute task', dependencies: [], write_scope: ['src/team'],
    verification_argv: [['npm', 'test'], ['npm', 'run', 'build']],
    artifact_contract: { proposal_root: 'artifacts/task', required_files: ['src/team/result.ts'], terminal_receipt_path: 'artifacts/task/terminal.json' },
    contributor_guidance_hashes: [{ path: 'AGENTS.md', sha256: sha256('guidance') }],
    mailbox_cursor: 4, claim_id: 'claim', generation: 2, state_endpoint: 'oma://state',
    cancellation_token_hash: sha256('cancel'), provider: 'agy_headless', native_role: 'executor',
    capability_mode: 'read-write', deadline_ms: 300_000,
  };
}

function host(log: string[], failVerification = false): WorkerLoopHost {
  return {
    heartbeat: async () => { log.push('heartbeat'); return ok(undefined); },
    listMailbox: async (cursor) => {
      log.push(`list:${cursor}`);
      return ok([{
        schemaVersion: 1, id: 'm5', sender: 'leader', recipient: 'task', bodyDigest: sha256('message'),
        createdAtMs: 1, sequence: 5, generation: 2,
      }]);
    },
    readMailbox: async (message) => { log.push(`read:${message.id}`); return ok('message'); },
    acknowledgeMailbox: async (ids, cursor) => { log.push(`ack:${ids.join(',')}:${cursor}`); return ok(undefined); },
    recordProgress: async (kind) => { log.push(`progress:${kind}`); return ok(undefined); },
    transition: async (expected, next) => { log.push(`transition:${expected}->${next}`); return ok(undefined); },
    runVerification: async (argv) => {
      log.push(`verify:${argv.join(' ')}`);
      return ok({
        argv, exitCode: failVerification ? 1 : 0, stdoutHash: sha256('stdout'), stderrHash: sha256('stderr'),
        artifactHash: sha256(argv.join(' ')),
      });
    },
    recordCommandEvidence: async (outcome) => { log.push(`command:${outcome.exitCode}`); return ok(undefined); },
    createImmutableDelivery: async () => { log.push('delivery'); return ok({ deliveryDigest: sha256('delivery') }); },
    requestIntegration: async () => { log.push('integration'); return ok({ integrationReceiptHash: sha256('integration') }); },
    cleanupCapabilityPlaintext: async () => { log.push('cleanup'); return ok(undefined); },
    terminal: async (outcome) => { log.push(`terminal:${outcome}`); return ok(undefined); },
  };
}

describe('complete worker loop protocol', () => {
  test('orders claim launch, heartbeat, mailbox, progress, verification, delivery, integration, cleanup and terminal', async () => {
    const log: string[] = [];
    const result = await runWorkerProtocolLoop(envelope(), host(log));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ mailboxCursor: 5, commandCount: 2, outcome: 'completed' });
    expect(log).toEqual([
      'transition:claimed->launched', 'heartbeat', 'transition:launched->running',
      'list:4', 'read:m5', 'ack:m5:5', 'progress:checkpoint', 'heartbeat',
      'transition:running->verifying',
      'verify:npm test', 'command:0', 'heartbeat',
      'verify:npm run build', 'command:0', 'heartbeat',
      'progress:verification', 'delivery', 'transition:verifying->delivery_ready',
      'progress:artifact', 'integration', 'transition:delivery_ready->integration_requested',
      'cleanup', 'terminal:completed',
    ]);
  });

  test('failed verification still removes capability plaintext and writes a failed terminal receipt', async () => {
    const log: string[] = [];
    const result = await runWorkerProtocolLoop(envelope(), host(log, true));
    expect(result.ok).toBe(false);
    expect(log.slice(-2)).toEqual(['cleanup', 'terminal:failed']);
    expect(log).not.toContain('delivery');
    expect(log).not.toContain('integration');
  });

  test('mailbox digest mismatch fails closed before command execution', async () => {
    const log: string[] = [];
    const mismatch = host(log);
    mismatch.readMailbox = async () => ok('tampered');
    const result = await runWorkerProtocolLoop(envelope(), mismatch);
    expect(result.ok).toBe(false);
    expect(log).not.toContain('verify:npm test');
    expect(log.slice(-2)).toEqual(['cleanup', 'terminal:failed']);
  });
});
