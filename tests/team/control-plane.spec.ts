import {
  HostIdentityV1,
  PluginIdentityV1,
  assembleHostCapabilityProfile,
  issueHostRouteReceipt,
  routeHostCapability,
} from '../../src/native/capability-profile';
import { sha256 } from '../../src/runtime/atomic';
import { WorkerEnvelopeV1 } from '../../src/contracts/worker-envelope';
import { prepareWorkerControl } from '../../src/team/control-plane';

const selectedAt = '2026-07-31T12:00:00.000Z';
const now = '2026-07-31T12:00:01.000Z';
const contextDigest = sha256('context');

function authority(provider: 'agy_headless' | 'tmux_agy') {
  const host: HostIdentityV1 = { realpath: '/opt/agy', binarySha256: sha256('binary'), version: null, versionOutputSha256: sha256('version'), helpOutputSha256: sha256('help'), platform: 'darwin', arch: 'arm64' };
  const plugin: PluginIdentityV1 = { status: 'present', realpath: '/opt/plugin', packageDigest: sha256('plugin'), version: '1', readbackDigest: sha256('readback'), enabled: true };
  const empty = assembleHostCapabilityProfile({ evaluationTimestamp: selectedAt, hostIdentityBefore: host, hostIdentityAfter: host, pluginIdentityBefore: plugin, pluginIdentityAfter: plugin, observations: [] });
  const profile = assembleHostCapabilityProfile({ evaluationTimestamp: selectedAt, hostIdentityBefore: host, hostIdentityAfter: host, pluginIdentityBefore: plugin, pluginIdentityAfter: plugin, observations: [{ capability: 'headless.print', source: 'live_probe', tier: 'healthy', result: 'positive', observedAt: selectedAt, identityDigest: empty.identityDigest, detailCode: 'OK', diagnostic: null }] });
  const candidate = routeHostCapability(profile, { capability: 'headless.print', provider, requestMode: provider === 'agy_headless' ? 'headless' : 'interactive', generation: 1, contextDigest, selectedAt, ttlMs: 60_000, fallbackPreconditionsSatisfied: true });
  return { profile, receipt: issueHostRouteReceipt(candidate, '/opt/agy', `${provider}_v1`) };
}

function envelope(route: ReturnType<typeof authority>): WorkerEnvelopeV1 {
  return {
    store_kind: 'oma_worker_envelope', schema_version: 1, repository_id: 'OMA',
    run_id: 'run', team_id: 'team', task_id: 'task', task_text: 'Implement owned task',
    dependencies: [], write_scope: ['src/team'], verification_argv: [['npm', 'test']],
    artifact_contract: { proposal_root: 'artifacts/task', required_files: ['src/team/out.ts'], terminal_receipt_path: 'artifacts/task/terminal.json' },
    contributor_guidance_hashes: [{ path: 'AGENTS.md', sha256: sha256('guidance') }],
    mailbox_cursor: 0, claim_id: 'claim', generation: 1, state_endpoint: 'oma://state',
    cancellation_token_hash: sha256('cancel'), provider: route.receipt.provider as WorkerEnvelopeV1['provider'],
    provider_profile_digest: route.profile.profileDigest, route_receipt_digest: route.receipt.receiptDigest,
    native_role: 'executor', capability_mode: 'read-write', deadline_ms: 300_000,
  };
}

function input(route: ReturnType<typeof authority>) {
  return {
    envelope: envelope(route), profile: route.profile, receipt: route.receipt,
    validation: { now, contextDigest, identityDigest: route.profile.identityDigest, fallbackPreconditionsSatisfied: true },
    claimToken: 'secret', boundAtMs: 2,
  };
}

describe('receipt-bound worker control plane', () => {
  test('headless launch uses pinned executable and binds profile/receipt before launch', () => {
    const route = authority('agy_headless');
    const result = prepareWorkerControl({ ...input(route), process: { pid: 42, startMarker: 'process-start' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.launch).toEqual({
      executable: '/opt/agy', shell: false,
      argv: ['--model', 'gemini-3.6-flash-high', '--print', 'Implement owned task', '--print-timeout', '5m0s', '--mode', 'accept-edits'],
    });
    expect(result.value.binding).toMatchObject({
      provider: 'agy_headless', generation: 1,
      providerProfileDigest: route.profile.profileDigest,
      providerReceiptHash: route.receipt.receiptDigest,
      claimTokenDigest: sha256('secret'),
    });
  });

  test('tmux requires pane+process and receipt tamper fails before binding', () => {
    const route = authority('tmux_agy');
    expect(prepareWorkerControl({ ...input(route), process: { pid: 42, startMarker: 'process-start' } }).ok).toBe(false);
    expect(prepareWorkerControl({
      ...input(route),
      process: { pid: 42, startMarker: 'process-start' },
      pane: { schemaVersion: 1, sessionName: 's', paneId: '%1', ownerNonce: 'o', workerNonce: 'w' },
      receipt: { ...route.receipt, receiptDigest: sha256('tampered') },
    }).ok).toBe(false);
  });

  test('tmux binding defaults readinessPhase to pane_created and accepts an explicit phase', () => {
    const route = authority('tmux_agy');
    const pane = { schemaVersion: 1 as const, sessionName: 's', paneId: '%1', ownerNonce: 'o', workerNonce: 'w' };
    const process = { pid: 42, startMarker: 'Mon Aug 24 10:00:01 2026' };
    const prepared = prepareWorkerControl({ ...input(route), process, pane });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.binding.readinessPhase).toBe('pane_created');
    const dispatched = prepareWorkerControl({
      ...input(route), process, pane, readinessPhase: 'task_dispatched',
    });
    expect(dispatched.ok).toBe(true);
    if (dispatched.ok) expect(dispatched.value.binding.readinessPhase).toBe('task_dispatched');
  });
});
