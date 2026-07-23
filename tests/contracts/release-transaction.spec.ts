import * as fs from 'fs';
import * as path from 'path';
import {
  GITHUB_CHANNEL_STATE_SET_V1,
  GITHUB_LATEST_RESTORE_STATE_SET_V1,
  OMA_REGISTRY_STATE_SUFFIX_SET_V1,
  RELEASE_EXTERNAL_OPERATION_ORACLE_V1,
  REGISTRY_BARRIER_STATE_SET_V1,
  W6_BRANCH_FREEZE_CHAIN_V1,
  ReleaseBuildReceiptV1,
  ReleaseBundleManifestV1,
  ReleaseTransactionV1,
  assertRegistryTransition,
  assertW6BranchFreezeTransition,
  canonicalBytesV1,
  claimedRegistryPolicyHash,
  qualifyRegistryState,
  registryCleanupDispositionKey,
  registryPendingDerivativeOracle,
  reconcileReleaseIdentityCardinality,
  releaseExternalOperationState,
  releaseAssetRootV1,
  releaseBundleManifestRelativePath,
  releaseIdempotencyKey,
  releaseTransactionIdentity,
  sha256Hex,
  stagingDistTag,
  validateClaimedRegistry,
  validateRegistryCleanupDispositions,
  validateRegistryPolicy,
  validateReleaseBundleManifest,
  validateReleaseCallRecord,
  validateReleaseTransaction,
} from '../../src/contracts';

const sha = (value: string): string => value.repeat(64);
const oid = (value: string): string => value.repeat(40);
const releaseFixture = (name: string): any => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'release', name), 'utf8',
));

describe('OMA W0 idempotent release transaction contract', () => {
  test('registry/GitHub state suffix sets and W6 chain exactly match the frozen oracle', () => {
    expect(OMA_REGISTRY_STATE_SUFFIX_SET_V1).toEqual([
      'publish_pending', 'publish_unknown', 'publish_failed', 'published',
      'version_readback_pending', 'version_readback_unknown', 'version_readback_failed',
      'version_readback_passed', 'staging_tag_set_pending', 'staging_tag_set_unknown',
      'staging_tag_set_failed', 'staging_tag_set', 'staging_tag_readback_pending',
      'staging_tag_readback_unknown', 'staging_tag_readback_failed', 'staging_tag_readback_passed',
      'final_tag_set_pending', 'final_tag_set_unknown', 'final_tag_set_failed', 'final_tag_set',
      'final_tag_readback_pending', 'final_tag_readback_unknown', 'final_tag_readback_failed',
      'final_tag_readback_passed', 'final_tag_restore_pending', 'final_tag_restore_unknown',
      'final_tag_restore_failed', 'final_tag_restored', 'final_tag_restore_readback_pending',
      'final_tag_restore_readback_unknown', 'final_tag_restore_readback_failed',
      'final_tag_restore_readback_passed', 'deprecation_pending', 'deprecation_unknown',
      'deprecation_failed', 'deprecated', 'deprecation_readback_pending',
      'deprecation_readback_unknown', 'deprecation_readback_failed',
      'deprecation_readback_passed', 'deprecation_not_applicable',
    ]);
    expect(GITHUB_CHANNEL_STATE_SET_V1).toHaveLength(18);
    expect(GITHUB_LATEST_RESTORE_STATE_SET_V1).toHaveLength(8);
    expect(REGISTRY_BARRIER_STATE_SET_V1).toEqual([
      'registries_staged_passed', 'registries_not_applicable',
      'registry_final_tags_readback_passed', 'registry_final_tags_not_applicable',
    ]);
    expect(W6_BRANCH_FREEZE_CHAIN_V1).toEqual(releaseFixture('state-oracles.json').w6_chain);
    for (let index = 0; index < W6_BRANCH_FREEZE_CHAIN_V1.length - 1; index += 1) {
      expect(() => assertW6BranchFreezeTransition(
        W6_BRANCH_FREEZE_CHAIN_V1[index], W6_BRANCH_FREEZE_CHAIN_V1[index + 1],
      )).not.toThrow();
    }
    expect(() => assertW6BranchFreezeTransition('candidate_gates_passed', 'frozen_pass')).toThrow();
  });

  test('every registry external pending/readback operation has qualified unknown+failed derivatives', () => {
    const derivatives = registryPendingDerivativeOracle();
    expect(derivatives).toHaveLength(10);
    for (const derivative of derivatives) {
      expect(OMA_REGISTRY_STATE_SUFFIX_SET_V1).toEqual(expect.arrayContaining([
        derivative.pending, derivative.unknown, derivative.failed,
      ]));
      expect(qualifyRegistryState('github-packages', derivative.unknown))
        .toBe(`github-packages.${derivative.unknown}`);
      expect(() => assertRegistryTransition({
        registry_id: 'github-packages', current_suffix: derivative.pending,
        next_suffix: derivative.unknown,
      })).not.toThrow();
      expect(() => assertRegistryTransition({
        registry_id: 'github-packages', current_suffix: derivative.pending,
        next_suffix: derivative.failed,
      })).not.toThrow();
      expect(() => assertRegistryTransition({
        registry_id: 'github-packages', current_suffix: derivative.failed,
        next_suffix: derivative.pending, authoritative_no_write: true,
      })).not.toThrow();
      expect(() => assertRegistryTransition({
        registry_id: 'github-packages', current_suffix: derivative.failed,
        next_suffix: derivative.pending, authoritative_no_write: false,
      })).toThrow();
    }
  });

  test('every non-registry external operation distinguishes pending, hard failure, timeout, and success', () => {
    expect(RELEASE_EXTERNAL_OPERATION_ORACLE_V1).toHaveLength(21);
    expect(new Set(RELEASE_EXTERNAL_OPERATION_ORACLE_V1.map((row) => row.operation)).size)
      .toBe(RELEASE_EXTERNAL_OPERATION_ORACLE_V1.length);
    for (const row of RELEASE_EXTERNAL_OPERATION_ORACLE_V1) {
      const states = [
        releaseExternalOperationState(row.operation, 'pending'),
        releaseExternalOperationState(row.operation, 'hard_failure'),
        releaseExternalOperationState(row.operation, 'timeout'),
        releaseExternalOperationState(row.operation, 'success'),
      ];
      expect(states).toEqual([row.pending, row.failed, row.unknown, row.success]);
      expect(new Set(states).size).toBe(4);
    }
    expect(reconcileReleaseIdentityCardinality({ exact_matches: 0, conflicting_matches: 0 }))
      .toBe('absent');
    expect(reconcileReleaseIdentityCardinality({ exact_matches: 1, conflicting_matches: 0 }))
      .toBe('exact');
    expect(() => reconcileReleaseIdentityCardinality({ exact_matches: 2, conflicting_matches: 0 }))
      .toThrow('multiple');
    expect(() => reconcileReleaseIdentityCardinality({ exact_matches: 0, conflicting_matches: 1 }))
      .toThrow('conflicts');
    expect(() => reconcileReleaseIdentityCardinality({ exact_matches: 1, conflicting_matches: 1 }))
      .toThrow('multiple');
  });

  test('policy grammar, transaction identity, staging tag and per-call idempotency are byte stable', () => {
    const policy = releaseFixture('registry-policies-production.json').policies[0];
    expect(() => validateRegistryPolicy(policy)).not.toThrow();
    expect(() => validateRegistryPolicy({ ...policy, registry_id: 'evil' })).toThrow('allowlist');
    expect(() => validateRegistryPolicy({ ...policy, staging_tag_derivation: 'latest' })).toThrow();
    expect(() => validateRegistryPolicy({ ...policy, extra: true })).toThrow('keys');

    const base = {
      repository_id: 'OMA' as const, semver: '0.3.0', frozen_commit: oid('a'), transaction_nonce: 'nonce-1',
    };
    const identity = releaseTransactionIdentity(base);
    const claimed = {
      ...policy, tarball_sha256: sha('1'), integrity: 'sha512-example', provenance_hash: sha('2'),
      staging_dist_tag: stagingDistTag(identity), prior_final_tag_identity: '0.2.3',
    };
    expect(() => validateClaimedRegistry(claimed, identity)).not.toThrow();
    expect(claimed.staging_dist_tag).toBe(`oma-prerelease-${identity.slice(0, 12)}`);
    const expectedIdentityDigest = sha('3');
    const idempotencyKey = releaseIdempotencyKey({
      ...base, step: 'prerelease_create', expected_identity_digest: expectedIdentityDigest,
    });
    const record = {
      store_kind: 'release_call_record', schema_version: 1, state: 'prerelease_create_pending',
      allowed_predecessor: 'tag_readback_passed', attempt: 1, redacted_external_locator: 'github:<redacted>',
      expected_identity_digest: expectedIdentityDigest, byte_digest: sha('4'), request_digest: sha('5'),
      idempotency_key: idempotencyKey, prior_mutable_object_identity: null, dispatched: false,
      external_id: null, external_etag: null, external_object_digest: null, readback_at: null,
    } as const;
    expect(() => validateReleaseCallRecord(record, base, 'prerelease_create')).not.toThrow();
    expect(() => validateReleaseCallRecord(record, base, 'github-prerelease-create'))
      .toThrow('immutable state');
    expect(() => validateReleaseCallRecord({ ...record, idempotency_key: sha('9') }, base, 'prerelease_create'))
      .toThrow('idempotency');
    expect(() => validateReleaseCallRecord({ ...record, extra: true } as any, base, 'prerelease_create'))
      .toThrow('keys');
    expect(() => validateReleaseCallRecord({
      ...record, redacted_external_locator: 'github:token=raw-secret',
    }, base, 'prerelease_create')).toThrow('redacted');
    expect(() => validateReleaseCallRecord({
      ...record, dispatched: true, external_id: 'release-1', external_object_digest: sha('4'),
      readback_at: '2026-07-22T00:00:00.000Z',
    }, base, 'prerelease_create')).not.toThrow();
    expect(() => validateReleaseCallRecord({
      ...record, dispatched: true, readback_at: '2026-07-22T00:00:00.000Z',
    }, base, 'prerelease_create')).toThrow('lacks');

    const transaction: ReleaseTransactionV1 = {
      store_kind: 'release_transaction', schema_version: 1, repository_id: 'OMA', semver: base.semver,
      frozen_commit: base.frozen_commit, transaction_nonce: base.transaction_nonce,
      transaction_identity_hash: identity, parent_w6_aggregate_hash: sha('6'), state: 'frozen_pass',
      claimed_registry_policy_hash: claimedRegistryPolicyHash([policy]), claimed_registries: [claimed],
      call_records: [record], channel_states: {}, supersedes_transaction_hash: null, canonical_verified: false,
    };
    expect(() => validateReleaseTransaction(transaction)).not.toThrow();
    const crossIdentity = releaseTransactionIdentity({
      ...base,
      transaction_nonce: 'nonce-cross-transaction',
    });
    expect(() => validateReleaseTransaction({
      ...transaction,
      transaction_nonce: 'nonce-cross-transaction',
      transaction_identity_hash: crossIdentity,
      claimed_registries: [{ ...claimed, staging_dist_tag: stagingDistTag(crossIdentity) }],
    })).toThrow('idempotency');
    expect(() => validateReleaseTransaction({ ...transaction, state: 'package_published' })).toThrow('Scalar');
    expect(() => validateReleaseTransaction({
      ...transaction, state: 'unknown_release_transaction_state',
    })).toThrow('frozen grammar');
    expect(() => validateReleaseTransaction({
      ...transaction, channel_states: { github: 'arbitrary_channel_state' },
    })).toThrow('channel state');
    expect(() => validateReleaseTransaction({
      ...transaction, call_records: [{ store_kind: 'release_call_record' }] as any,
    })).toThrow('keys');
    expect(() => validateReleaseTransaction({ ...transaction, claimed_registry_policy_hash: sha('7') }))
      .toThrow('policy hash');
    expect(() => validateReleaseTransaction({ ...transaction, extra: true } as any)).toThrow('keys');
  });

  test('three-registry withdrawal vectors require one ordered keyed terminal disposition per registry', () => {
    const fixture = releaseFixture('withdrawal-three-registry.json');
    const transaction = {
      repository_id: 'OMA' as const, semver: '0.3.0', frozen_commit: oid('b'), transaction_nonce: 'nonce-2',
    };
    for (const vectorName of ['failure_at_first', 'failure_at_middle', 'failure_at_last']) {
      const vector: string[] = fixture[vectorName];
      const dispositions = fixture.fixture_only_registry_ids.map((registryId: string, index: number) => {
        const state = vector[index] === 'N/A'
          ? qualifyRegistryState(registryId, 'deprecation_not_applicable')
          : qualifyRegistryState(registryId, 'deprecation_readback_passed');
        return {
          registry_id: registryId,
          state,
          record_key: registryCleanupDispositionKey({ ...transaction, registry_id: registryId }),
          predecessor: index === 0 ? 'withdrawal_registry_cleanup_pending' : '',
          authoritative_no_write_proof: vector[index] === 'N/A',
        };
      });
      for (let index = 1; index < dispositions.length; index += 1) {
        dispositions[index].predecessor = dispositions[index - 1].state;
      }
      expect(() => validateRegistryCleanupDispositions({
        transaction, registry_ids: fixture.fixture_only_registry_ids, dispositions,
      })).not.toThrow();
      expect(() => validateRegistryCleanupDispositions({
        transaction, registry_ids: fixture.fixture_only_registry_ids,
        dispositions: dispositions.slice(0, -1),
      })).toThrow('Every registry');
      const wrong = dispositions.map((entry: {
        registry_id: string;
        state: string;
        record_key: string;
        predecessor: string;
        authoritative_no_write_proof: boolean;
      }) => ({ ...entry }));
      wrong[0].record_key = sha('f');
      expect(() => validateRegistryCleanupDispositions({
        transaction, registry_ids: fixture.fixture_only_registry_ids, dispositions: wrong,
      })).toThrow('key');
    }
  });

  test('release_bundle_manifest/1 binds exact prebuilt tarball, checksum bytes, receipt and registries', () => {
    const policy = releaseFixture('registry-policies-production.json').policies[0];
    const identity = releaseTransactionIdentity({
      repository_id: 'OMA', semver: '0.3.0', frozen_commit: oid('c'), transaction_nonce: 'nonce-3',
    });
    const claimed = {
      ...policy, tarball_sha256: sha('1'), integrity: 'sha512-example', provenance_hash: sha('2'),
      staging_dist_tag: stagingDistTag(identity), prior_final_tag_identity: '0.2.3',
    };
    const payloadName = 'iml1s-oh-my-agy-0.3.0.tgz';
    const checksumBytes = `${claimed.tarball_sha256}  ${payloadName}\n`;
    const checksumHash = sha256Hex(Buffer.from(checksumBytes));
    const receiptWithoutHash = {
      argv: ['npm', 'pack'], cwd_realpath_hash: sha('3'),
      toolchain: [{ name: 'node', version: '22.0.0', binary_sha256: sha('4') }],
      sanitized_environment: [{ name: 'SOURCE_DATE_EPOCH', value_hash: sha('5') }],
      source_date_epoch: '1', locale: 'C', timezone: 'UTC', umask: '022',
      exit_code: 0, stdout_sha256: sha('6'), stderr_sha256: sha('7'),
      archive_sha256: claimed.tarball_sha256, packlist_sha256: sha('8'),
    };
    const buildReceipt: ReleaseBuildReceiptV1 = {
      ...receiptWithoutHash, receipt_hash: sha256Hex(canonicalBytesV1(receiptWithoutHash)),
    };
    const assets = [
      { name: payloadName, relative_path: `release-bundle/${payloadName}`, byte_length: 123, sha256: claimed.tarball_sha256, media_type: 'application/gzip' },
      { name: 'SHA256SUMS', relative_path: 'release-bundle/SHA256SUMS', byte_length: Buffer.byteLength(checksumBytes), sha256: checksumHash, media_type: 'text/plain' },
    ];
    const manifest: ReleaseBundleManifestV1 = {
      store_kind: 'release_bundle_manifest', schema_version: 1, repository_id: 'OMA', run_id: 'run-3',
      owner: 'oma-final-composition-owner', candidate_commit: oid('c'), candidate_tree: oid('d'),
      semver: '0.3.0', bundle_directory: 'release-bundle', public_upload_order: [payloadName, 'SHA256SUMS'],
      assets, checksum_bytes: checksumBytes, checksum_byte_length: Buffer.byteLength(checksumBytes),
      checksum_sha256: checksumHash, build_receipt: buildReceipt, registry_bindings: [claimed],
      release_asset_root: releaseAssetRootV1(assets),
    };
    expect(releaseBundleManifestRelativePath('run-3')).toMatch(
      /^\.agy\/artifacts\/dual-parity\/[0-9a-f]{64}\/OMA-W6\/release-bundle-manifest\.json$/,
    );
    expect(() => validateReleaseBundleManifest(manifest, [claimed])).not.toThrow();
    expect(() => validateReleaseBundleManifest({ ...manifest, extra: true } as any, [claimed]))
      .toThrow('keys');
    expect(() => validateReleaseBundleManifest({
      ...manifest, candidate_commit: 'not-a-git-object-id',
    }, [claimed])).toThrow('Git object ID');
    expect(() => validateReleaseBundleManifest({
      ...manifest,
      assets: [{ ...assets[0], relative_path: '../../escape' }, assets[1]],
    }, [claimed])).toThrow('confined relative POSIX path');
    expect(() => validateReleaseBundleManifest({
      ...manifest, public_upload_order: ['SHA256SUMS', payloadName],
    }, [claimed])).toThrow('order');
    expect(() => validateReleaseBundleManifest({
      ...manifest, checksum_bytes: `${claimed.tarball_sha256} ${payloadName}\n`,
    }, [claimed])).toThrow('SHA256SUMS');
    expect(() => validateReleaseBundleManifest({
      ...manifest, assets: [...assets, { ...assets[0], name: 'extra' }],
    }, [claimed])).toThrow('set/order');
    expect(() => validateReleaseBundleManifest(manifest, [{ ...claimed, integrity: 'changed' }]))
      .toThrow('Registry bindings');
  });
});
