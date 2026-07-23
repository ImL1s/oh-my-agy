import { sha256 } from '../../src/runtime/atomic';
import { WorkerEnvelopeV1 } from '../../src/contracts/worker-envelope';
import { prepareWorkerControl } from '../../src/team/control-plane';
import { ProviderSelectionV1 } from '../../src/team/provider';

function envelope(provider: WorkerEnvelopeV1['provider']): WorkerEnvelopeV1 {
  return {
    store_kind: 'oma_worker_envelope', schema_version: 1, repository_id: 'OMA',
    run_id: 'run', team_id: 'team', task_id: 'task', task_text: 'Implement owned task',
    dependencies: [], write_scope: ['src/team'], verification_argv: [['npm', 'test']],
    artifact_contract: { proposal_root: 'artifacts/task', required_files: ['src/team/out.ts'], terminal_receipt_path: 'artifacts/task/terminal.json' },
    contributor_guidance_hashes: [{ path: 'AGENTS.md', sha256: sha256('guidance') }],
    mailbox_cursor: 0, claim_id: 'claim', generation: 1, state_endpoint: 'oma://state',
    cancellation_token_hash: sha256('cancel'), provider, native_role: 'executor',
    capability_mode: 'read-write', deadline_ms: 300_000,
  };
}

function selection(provider: WorkerEnvelopeV1['provider']): ProviderSelectionV1 {
  return { schemaVersion: 1, provider, generation: 1, evidenceHash: sha256(provider), observedAtMs: 1 };
}

describe('prepared worker control plane', () => {
  test('headless launch is a shell-free exact argv vector bound to process receipt', () => {
    const result = prepareWorkerControl({
      envelope: envelope('agy_headless'), selection: selection('agy_headless'), claimToken: 'secret', boundAtMs: 2,
      process: { pid: 42, startMarker: 'process-start' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.launch).toEqual({
      executable: 'agy', shell: false,
      argv: ['--print', '--print-timeout', '5m0s', '--mode', 'accept-edits', 'Implement owned task'],
    });
    expect(result.value.binding).toMatchObject({
      provider: 'agy_headless', generation: 1, state: 'claimed', transitionSequence: 0,
      claimTokenDigest: sha256('secret'), process: { pid: 42, startMarker: 'process-start' },
    });
  });

  test('tmux requires pane+process while native accepts only generation-fenced conversation receipt', () => {
    expect(prepareWorkerControl({
      envelope: envelope('tmux_agy'), selection: selection('tmux_agy'), claimToken: 'secret', boundAtMs: 2,
      process: { pid: 42, startMarker: 'process-start' },
    }).ok).toBe(false);
    const nativeSelection: ProviderSelectionV1 = {
      ...selection('antigravity_native'),
      conversationReceipt: {
        schemaVersion: 1, provider: 'antigravity_native', conversationId: 'conversation', receiptId: 'receipt',
        generation: 1, observedAtMs: 1, capabilityDigest: sha256('capability'),
      },
    };
    const native = prepareWorkerControl({
      envelope: envelope('antigravity_native'), selection: nativeSelection, claimToken: 'secret', boundAtMs: 2,
    });
    expect(native.ok).toBe(true);
    if (native.ok) expect(native.value.launch).toBeUndefined();
  });
});
