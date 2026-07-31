import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  NativeCapabilityInspectionV1,
  executePrivateProductRepositoryWorkflow,
  refreshProductWorkflowCapabilityProfile,
} from '../../src/cli/runtime-adapter';
import { RepositoryWorkflowV1 } from '../../src/contracts/repository-workflow';
import {
  HostCapabilityProfileV1,
  HostIdentityV1,
  assembleHostCapabilityProfile,
} from '../../src/native/capability-profile';
import { absentPluginIdentity } from '../../src/native/probes/identity';
import { sha256 } from '../../src/runtime/atomic';
import { planRepositoryWorkflow } from '../../src/workflows/planner';
import { WorkflowTaskReceiptV1 } from '../../src/workflows/schema';

const NOW = '2026-07-31T12:00:50.000Z';
const HOST: HostIdentityV1 = {
  realpath: '/usr/local/bin/agy',
  binarySha256: 'a'.repeat(64),
  version: '1.1.9',
  versionOutputSha256: 'b'.repeat(64),
  helpOutputSha256: 'c'.repeat(64),
  platform: 'darwin',
  arch: 'arm64',
};

describe('product workflow capability refresh', () => {
  it('reuses a freshly identity-checked profile without another live canary', async () => {
    const fresh = routableProfile(NOW);
    const calls: boolean[] = [];
    const selected = await refreshProductWorkflowCapabilityProfile({
      expected_realpath: HOST.realpath,
      expected_binary_sha256: HOST.binarySha256,
      now: () => NOW,
      inspect: async (live) => {
        calls.push(live);
        return inspection(fresh, live);
      },
    });
    expect(selected.profileDigest).toBe(fresh.profileDigest);
    expect(calls).toEqual([false]);
  });

  it('renews live evidence before a later batch when the startup profile lacks route headroom', async () => {
    const startup = routableProfile('2026-07-31T12:00:00.000Z');
    const refreshed = routableProfile(NOW);
    const calls: boolean[] = [];
    const selected = await refreshProductWorkflowCapabilityProfile({
      expected_realpath: HOST.realpath,
      expected_binary_sha256: HOST.binarySha256,
      now: () => NOW,
      inspect: async (live) => {
        calls.push(live);
        return inspection(live ? refreshed : startup, live);
      },
    });
    expect(selected.profileDigest).toBe(refreshed.profileDigest);
    expect(calls).toEqual([false, true]);
  });

  it('samples route time after a slow live refresh produces newer evidence', async () => {
    const startup = routableProfile('2026-07-31T12:00:00.000Z');
    const refreshedAt = '2026-07-31T12:01:00.000Z';
    const refreshed = routableProfile(refreshedAt);
    let clock = NOW;
    const events: string[] = [];
    const selected = await refreshProductWorkflowCapabilityProfile({
      expected_realpath: HOST.realpath,
      expected_binary_sha256: HOST.binarySha256,
      now: () => {
        events.push('clock');
        return clock;
      },
      inspect: async (live) => {
        events.push(live ? 'live' : 'passive');
        if (live) clock = '2026-07-31T12:01:01.000Z';
        return inspection(live ? refreshed : startup, live);
      },
    });
    expect(selected.profileDigest).toBe(refreshed.profileDigest);
    expect(events).toEqual(['passive', 'clock', 'live', 'clock']);
  });

  it('rejects refreshed evidence from a different executable identity', async () => {
    const foreign = routableProfile(NOW, { ...HOST, binarySha256: 'f'.repeat(64) });
    await expect(refreshProductWorkflowCapabilityProfile({
      expected_realpath: HOST.realpath,
      expected_binary_sha256: HOST.binarySha256,
      now: () => NOW,
      inspect: async (live) => inspection(foreign, live),
    })).rejects.toThrow(/exact capability profile/);
  });

  it('refreshes route evidence once before every dependent workflow batch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-profile-batches-'));
    const repositoryRoot = path.join(root, 'repository');
    const stateRoot = path.join(root, 'state');
    fs.mkdirSync(repositoryRoot, { mode: 0o700 });
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    const definition = JSON.parse(fs.readFileSync(path.resolve(
      __dirname,
      '..',
      'fixtures',
      'workflow',
      'production-safety-review-v1.json',
    ), 'utf8')) as RepositoryWorkflowV1;
    const plan = planRepositoryWorkflow({
      definition,
      run_id: 'profile-refresh-batches',
      input_digest: sha256('input'),
      generation: 1,
    });
    let refreshes = 0;
    let dispatches = 0;
    try {
      const result = await executePrivateProductRepositoryWorkflow({
        definition,
        plan,
        journal_path: path.join(repositoryRoot, 'journal.jsonl'),
        authority_state_root: stateRoot,
        repository_root: repositoryRoot,
        refresh_capability_profile: async () => { refreshes += 1; },
        permission_context: (taskId, attempt) => ({
          run_id: plan.run_id,
          team_id: 'workflow-team',
          claim_id: `${taskId}:${attempt}`,
          state_endpoint: path.join(stateRoot, 'workflow-state'),
          cancellation_token_hash: sha256('cancel'),
          provider: 'agy_headless',
          provider_profile_digest: 'd'.repeat(64),
          route_receipt_digest: 'e'.repeat(64),
          mailbox_cursor: 0,
          contributor_guidance_hashes: [],
        }),
        adapter: {
          async dispatch(input) {
            dispatches += 1;
            return passingReceipt(input.task.task_id, input.attempt, input.stage.kind);
          },
        },
      });
      expect(result.terminal).toBe('no_ship');
      expect(dispatches).toBe(7);
      expect(refreshes).toBe(4);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function inspection(profile: HostCapabilityProfileV1, live: boolean): NativeCapabilityInspectionV1 {
  return {
    kind: 'profile',
    profile,
    cacheStatus: live ? 'rebuilt' : 'hit',
    diagnostics: [],
    liveSucceeded: live ? true : null,
    publicCliStatus: 'public_cli_observed',
  };
}

function routableProfile(observedAt: string, host: HostIdentityV1 = HOST): HostCapabilityProfileV1 {
  const plugin = absentPluginIdentity();
  const empty = assembleHostCapabilityProfile({
    evaluationTimestamp: observedAt,
    hostIdentityBefore: host,
    hostIdentityAfter: host,
    pluginIdentityBefore: plugin,
    pluginIdentityAfter: plugin,
    observations: [],
  });
  return assembleHostCapabilityProfile({
    evaluationTimestamp: observedAt,
    hostIdentityBefore: host,
    hostIdentityAfter: host,
    pluginIdentityBefore: plugin,
    pluginIdentityAfter: plugin,
    observations: ['headless.print', 'headless.json'].map((capability) => ({
      capability,
      source: 'live_probe' as const,
      tier: 'verified' as const,
      result: 'positive' as const,
      observedAt,
      identityDigest: empty.identityDigest,
      detailCode: 'LIVE_VERIFIED',
      diagnostic: null,
    })),
  });
}

function passingReceipt(
  taskId: string,
  attempt: number,
  kind: RepositoryWorkflowV1['stages'][number]['kind'],
): WorkflowTaskReceiptV1 {
  return {
    task_id: taskId,
    attempt,
    status: 'passed',
    result_hash: sha256(`${taskId}:result`),
    artifact_roots: [`.agy/artifacts/workflows/${taskId}`],
    approval: kind === 'skeptic' || kind === 'verifier' ? true : null,
    ship_proof_digest: kind === 'ship_gate' ? sha256(`${taskId}:ship-proof`) : null,
    external_effect_types: [],
    effect_receipt_digests: [],
    permission_denied: false,
  };
}
