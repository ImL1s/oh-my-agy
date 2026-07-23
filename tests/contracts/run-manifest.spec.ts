import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AggregateEnvelopeV1,
  FROZEN_OMA_NORMATIVE_PLAN_HASHES_V1,
  FROZEN_OMA_OWNERSHIP_MANIFEST_HASH_V1,
  FinalSigningFaultPointV1,
  RepositoryAggregateFinalPayloadV1,
  RepositoryAggregateInputPayloadV1,
  RepositoryAggregateOwnerRootV1,
  RunManifestV1,
  SignedHandoffV1,
  W6RequestBindingV1,
  advanceRunManifest,
  canonicalBytesV1,
  createPathProposal,
  expectedRepositoryAggregatePath,
  expectedFinalSigningJournalPath,
  handoffHash,
  initializeRunManifest,
  locateRunManifest,
  merkleRootV1,
  readRunManifest,
  sha256Hex,
  signRepositoryAggregate,
  validateRunManifest,
  verifyRepositoryAggregate,
  verifyWaveHandoffArtifacts,
  writeWaveHandoffArtifacts,
} from '../../src/contracts';
import {
  collectFinalTreeEvidence,
  ownershipForPath,
} from '../../scripts/check-writer-ownership';

jest.setTimeout(240_000);

const sha = (character: string): string => character.repeat(64);

type WriterWave = RepositoryAggregateOwnerRootV1['wave'];

const WRITER_ROWS = [
  ['OMA-W0', 'oma-contract-owner', 'src/contracts/run-manifest.ts'],
  ['OMA-W1', 'oma-install-owner', 'src/setup/plugin.ts'],
  ['OMA-W2', 'oma-state-owner', 'src/runtime/state-store.ts'],
  ['OMA-W3', 'oma-team-owner', 'src/team/state.ts'],
  ['OMA-W4', 'oma-native-surface-owner', 'src/mcp/index.ts'],
  ['OMA-W5', 'oma-adapter-owner', 'src/hud/index.ts'],
] as const;

const PARENTS: Readonly<Record<WriterWave, readonly WriterWave[]>> = {
  'OMA-W0': [],
  'OMA-W1': ['OMA-W0'],
  'OMA-W2': ['OMA-W0'],
  'OMA-W3': ['OMA-W2'],
  'OMA-W4': ['OMA-W1', 'OMA-W2'],
  'OMA-W5': ['OMA-W3', 'OMA-W4'],
};

interface GitFixture {
  root: string;
  workspace: string;
  remote: string;
  baseCommit: string;
  baseTree: string;
}

function command(
  cwd: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): string {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
  if (result.status !== 0) {
    throw new Error(`${argv.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

function git(cwd: string, ...args: string[]): string {
  return command(cwd, ['git', ...args]);
}

function writeRepositoryFile(workspace: string, repositoryPath: string, bytes: string | Buffer): void {
  const target = path.join(workspace, ...repositoryPath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function createGitFixture(prefix: string): GitFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'workspace');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(workspace);
  git(root, 'init', '--bare', remote);
  git(workspace, 'init', '-b', 'main');
  git(workspace, 'config', 'user.name', 'OMA Contract Test');
  git(workspace, 'config', 'user.email', 'oma-contract@example.invalid');
  writeRepositoryFile(workspace, '.gitignore', '.agy/\n');
  writeRepositoryFile(workspace, 'package.json', `${JSON.stringify({
    name: '@iml1s/oh-my-agy',
    version: '0.3.0',
    private: true,
  }, null, 2)}\n`);
  for (const [wave, , repositoryPath] of WRITER_ROWS) {
    writeRepositoryFile(workspace, repositoryPath, `${wave} frozen base\n`);
  }
  writeRepositoryFile(workspace, 'tests/hud/placeholder.spec.ts', 'OMA-W5 unchanged alternate\n');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-m', 'frozen base', '--no-gpg-sign');
  git(workspace, 'remote', 'add', 'origin', remote);
  git(workspace, 'push', '-u', 'origin', 'main');
  const baseCommit = git(workspace, 'rev-parse', 'HEAD^{commit}');
  const baseTree = git(workspace, 'rev-parse', 'HEAD^{tree}');
  return { root, workspace, remote, baseCommit, baseTree };
}

function cleanup(fixture: GitFixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function input(fixture: GitFixture, runId = 'run/with raw unsafe value') {
  return {
    workspace_path: fixture.workspace,
    run_id: runId,
    frozen_base_commit: fixture.baseCommit,
    frozen_base_tree: fixture.baseTree,
    approved_branch: 'main',
    approved_remote: 'origin',
    approved_remote_old_oid: fixture.baseCommit,
    normative_plan_hashes: { ...FROZEN_OMA_NORMATIVE_PLAN_HASHES_V1 },
    ownership_manifest_hash: FROZEN_OMA_OWNERSHIP_MANIFEST_HASH_V1,
    claimed_release_channels: ['github'],
    claimed_registry_policy: [],
    created_at: '2026-07-22T00:00:00.000Z',
  } as const;
}

function mode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

function w6RequestDocument(runId: string, wave: WriterWave) {
  return {
    store_kind: 'oma_cross_wave_packaging_request',
    schema_version: 1,
    repository_id: 'OMA',
    run_id: runId,
    from_wave: wave,
    to_wave: 'OMA-W6',
    owner_boundary: `${wave} supplies authenticated inputs; OMA-W6 remains the sole composition owner.`,
    requests: [{
      request: 'package_wave_output',
      required_action: `Consume the signed ${wave} output without rewriting its owned path.`,
    }],
    acceptance: ['The release bundle preserves the authenticated wave output hash.'],
    validation_argv: ['npm', 'run', 'build'],
  } as const;
}

function writeW6Request(
  workspace: string,
  manifest: RunManifestV1,
  wave: WriterWave,
  bytes: Buffer,
): W6RequestBindingV1 {
  const requestPath = `.agy/artifacts/dual-parity/${manifest.run_key}/${wave}/w6-packaging-request.json`;
  const absolutePath = path.join(workspace, ...requestPath.split('/'));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes, { mode: 0o600 });
  fs.chmodSync(absolutePath, 0o600);
  return { path: requestPath, byte_length: bytes.length, sha256: sha256Hex(bytes) };
}

function manifestBinding(workspace: string, manifest: RunManifestV1) {
  const realWorkspace = fs.realpathSync(path.resolve(workspace));
  const location = locateRunManifest(workspace, manifest.run_id);
  return {
    repository_id: 'OMA' as const,
    run_id: manifest.run_id,
    run_key: manifest.run_key,
    run_manifest_path: path.relative(realWorkspace, location.manifest_path).split(path.sep).join('/'),
    run_manifest_revision: manifest.revision,
    run_manifest_hash: sha256Hex(canonicalBytesV1(manifest)),
    lease_generation: manifest.lease_generation,
    frozen_base_commit: manifest.frozen_base_commit,
    frozen_base_tree: manifest.frozen_base_tree,
    approved_branch: manifest.approved_branch,
    approved_remote: manifest.approved_remote,
    approved_remote_old_oid: manifest.approved_remote_old_oid,
    trust_root_path: manifest.trust_root_path,
    trust_root_hash: manifest.trust_root_hash,
    ownership_manifest_id: 'dual-parity-writers-v1' as const,
    ownership_manifest_hash: manifest.ownership_manifest_hash,
    normative_plan_hashes: { ...manifest.normative_plan_hashes },
    claimed_release_channels: ['github'] as const,
    claimed_registry_policy: [] as const,
  };
}

function signedEnvelope(target: string): SignedHandoffV1 {
  return JSON.parse(fs.readFileSync(target, 'utf8')) as SignedHandoffV1;
}

interface EmitOptions {
  arbitraryPath?: boolean;
  badInitialWave?: WriterWave;
  failingTestWave?: WriterWave;
  incompleteWave?: WriterWave;
}

function emitSixWaveChain(
  workspace: string,
  manifest: RunManifestV1,
  options: EmitOptions = {},
): { roots: RepositoryAggregateOwnerRootV1[]; products: Record<WriterWave, string>; request: string } {
  const envelopes = new Map<WriterWave, SignedHandoffV1>();
  const realWorkspace = fs.realpathSync(path.resolve(workspace));
  const roots: RepositoryAggregateOwnerRootV1[] = [];
  const products = {} as Record<WriterWave, string>;
  let request = '';
  for (let index = 0; index < WRITER_ROWS.length; index += 1) {
    const [wave, owner, relativeProduct] = WRITER_ROWS[index];
    const absoluteProduct = path.join(workspace, ...relativeProduct.split('/'));
    const initialBytes = fs.readFileSync(absoluteProduct);
    const productBytes = Buffer.from(`${wave} authenticated product\n`, 'utf8');
    fs.writeFileSync(absoluteProduct, productBytes);
    products[wave] = absoluteProduct;
    const proposalPath = options.incompleteWave === wave
      ? 'tests/hud/placeholder.spec.ts' : relativeProduct;
    const proposalInitialBytes = options.incompleteWave === wave
      ? fs.readFileSync(path.join(workspace, ...proposalPath.split('/'))) : initialBytes;
    const proposalFinalBytes = options.incompleteWave === wave
      ? proposalInitialBytes : productBytes;
    const proposal = createPathProposal({
      store_kind: 'dual_parity_path_proposal',
      schema_version: 1,
      repository_id: 'OMA',
      run_id: manifest.run_id,
      wave,
      owner,
      path: proposalPath,
      initial_sha256: options.badInitialWave === wave ? sha('f') : sha256Hex(proposalInitialBytes),
      final_sha256: sha256Hex(proposalFinalBytes),
      disposition: options.incompleteWave === wave ? 'no_change' : 'changed',
      reason: `Bind ${wave} current product bytes.`,
      targeted_tests: [{
        argv: ['npx', 'jest', '--runInBand', 'tests/contracts/run-manifest.spec.ts'],
        exit_code: options.failingTestWave === wave ? 1 : 0,
        stdout_sha256: sha(String(index + 1)),
        stderr_sha256: sha('0'),
      }],
    });
    const proposals = [proposal];
    if (wave === 'OMA-W0' && options.arbitraryPath) {
      const arbitrary = 'unowned-arbitrary-product.txt';
      const arbitraryBytes = Buffer.from('must be rejected by ownership oracle\n', 'utf8');
      writeRepositoryFile(workspace, arbitrary, arbitraryBytes);
      proposals.push(createPathProposal({
        store_kind: 'dual_parity_path_proposal',
        schema_version: 1,
        repository_id: 'OMA',
        run_id: manifest.run_id,
        wave,
        owner,
        path: arbitrary,
        initial_sha256: 'ABSENT',
        final_sha256: sha256Hex(arbitraryBytes),
        disposition: 'changed',
        reason: 'Negative arbitrary-path ownership case.',
        targeted_tests: [{
          argv: ['false'], exit_code: 0, stdout_sha256: sha('a'), stderr_sha256: sha('b'),
        }],
      }));
    }
    let requests: W6RequestBindingV1[] = [];
    if (wave === 'OMA-W1') {
      const bytes = canonicalBytesV1(w6RequestDocument(manifest.run_id, wave));
      const binding = writeW6Request(workspace, manifest, wave, bytes);
      request = path.join(workspace, ...binding.path.split('/'));
      requests = [binding];
    }
    const artifacts = writeWaveHandoffArtifacts({
      workspace_path: workspace,
      run_id: manifest.run_id,
      wave,
      owner,
      expected_manifest_revision: manifest.revision,
      proposals,
      w6_requests: requests,
      parent_handoffs: PARENTS[wave].map((parent) => envelopes.get(parent) as SignedHandoffV1),
      completed_at: `2026-07-22T00:00:${String(index + 10).padStart(2, '0')}.000Z`,
    });
    const envelope = signedEnvelope(artifacts.handoff_path);
    envelopes.set(wave, envelope);
    const proposalIndex = JSON.parse(fs.readFileSync(artifacts.proposal_index_path, 'utf8'));
    roots.push({
      wave,
      owner,
      key_id: envelope.signed_payload.key_id,
      proposal_index_path: path.relative(realWorkspace, artifacts.proposal_index_path).split(path.sep).join('/'),
      proposal_index_hash: artifacts.proposal_index_hash,
      proposal_count: proposalIndex.proposal_count,
      proposal_merkle_root: artifacts.proposal_merkle_root,
      handoff_path: path.relative(realWorkspace, artifacts.handoff_path).split(path.sep).join('/'),
      handoff_hash: handoffHash(envelope),
      signature: envelope.signature,
      parent_handoff_hashes: [...envelope.signed_payload.parent_handoff_hashes],
      w6_requests: proposalIndex.w6_requests,
    });
  }
  return { roots, products, request };
}

function inputAggregatePayload(
  workspace: string,
  manifest: RunManifestV1,
  roots: RepositoryAggregateOwnerRootV1[],
): RepositoryAggregateInputPayloadV1 {
  if (manifest.previous_manifest_hash === null) throw new Error('missing writers manifest hash');
  return {
    store_kind: 'repo_aggregate_input_payload',
    schema_version: 1,
    ...manifestBinding(workspace, manifest),
    writers_manifest_hash: manifest.previous_manifest_hash,
    ordered_owner_roots: roots,
    parent_handoff_hashes: roots.map((root) => root.handoff_hash),
    path_test_merkle_root: merkleRootV1(roots.map((root) => ({
      path: root.wave,
      hash: root.proposal_merkle_root,
    }))),
    accepted_w6_proposals: roots.flatMap((root) =>
      root.w6_requests.map((entry) => ({ wave: root.wave, ...entry }))),
    final_commit: null,
  };
}

function writeProof(
  workspace: string,
  manifest: RunManifestV1,
  kind: 'deterministic' | 'live' | 'code_review' | 'ultraqa',
  candidateCommit: string,
  candidateTree: string,
): string {
  const relative = `.agy/artifacts/dual-parity/${manifest.run_key}/OMA-W6/${kind.replace('_', '-')}-proof.json`;
  const target = path.join(workspace, ...relative.split('/'));
  const proof: Record<string, unknown> = {
    store_kind: 'oma_release_proof',
    schema_version: 1,
    repository_id: 'OMA',
    run_id: manifest.run_id,
    proof_kind: kind,
    candidate_commit: candidateCommit,
    candidate_tree: candidateTree,
    passed: true,
  };
  if (kind === 'code_review' || kind === 'ultraqa') {
    const testArgv = kind === 'code_review'
      ? ['npx', 'jest', '--config', 'jest.unit.config.js', '--runInBand']
      : ['npm', 'run', 'test:e2e'];
    const testResult = {
      exit_code: 0,
      stdout_sha256: sha(kind === 'code_review' ? 'c' : 'd'),
      stderr_sha256: sha('0'),
    };
    const evidenceRelative = `.agy/artifacts/dual-parity/${manifest.run_key}/OMA-W6/${kind.replace('_', '-')}-evidence.log`;
    const evidenceTarget = path.join(workspace, ...evidenceRelative.split('/'));
    const evidenceBytes = canonicalBytesV1({
      store_kind: 'oma_release_test_evidence',
      schema_version: 1,
      repository_id: 'OMA',
      run_id: manifest.run_id,
      proof_kind: kind,
      reviewer_id: manifest.aggregate_verifier_id,
      candidate_commit: candidateCommit,
      candidate_tree: candidateTree,
      test_argv: testArgv,
      test_result: testResult,
    });
    fs.mkdirSync(path.dirname(evidenceTarget), { recursive: true });
    fs.writeFileSync(evidenceTarget, evidenceBytes, { mode: 0o400 });
    fs.chmodSync(evidenceTarget, 0o400);
    Object.assign(proof, {
      reviewer_id: manifest.aggregate_verifier_id,
      reviewer_key_id: manifest.aggregate_key_id,
      test_argv: testArgv,
      test_result: testResult,
      evidence: {
        path: evidenceRelative,
        byte_length: evidenceBytes.length,
        sha256: sha256Hex(evidenceBytes),
      },
    });
    const aggregateKeyPath = path.join(
      workspace,
      '.agy',
      'artifacts',
      'dual-parity',
      manifest.run_key,
      'trust',
      'keys',
      'OMA-W6-aggregate.hmac',
    );
    proof.attestation_signature = crypto.createHmac('sha256', fs.readFileSync(aggregateKeyPath))
      .update('OMA_RELEASE_REVIEW_PROOF_V1', 'utf8')
      .update(Buffer.from([0]))
      .update(canonicalBytesV1(proof))
      .digest('hex');
  }
  const bytes = canonicalBytesV1(proof);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return sha256Hex(bytes);
}

function releaseToolchain() {
  const npmPath = fs.realpathSync(command(process.cwd(), ['which', 'npm']));
  return [
    {
      name: 'node',
      version: process.version,
      binary_sha256: sha256Hex(fs.readFileSync(fs.realpathSync(process.execPath))),
    },
    {
      name: 'npm',
      version: command(process.cwd(), [npmPath, '--version']),
      binary_sha256: sha256Hex(fs.readFileSync(npmPath)),
    },
  ];
}

function packEnvironment(epoch: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LANG: 'C',
    LC_ALL: 'C',
    SOURCE_DATE_EPOCH: epoch,
    TZ: 'UTC',
    npm_config_loglevel: 'silent',
  };
}

function normalizedPacklist(workspace: string, epoch: string) {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: workspace,
    encoding: 'utf8',
    env: packEnvironment(epoch),
  });
  if (result.status !== 0 || result.stderr !== '') {
    throw new Error(`npm pack dry-run failed (${result.status}): ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout)[0];
  return parsed.files.map((entry: { path: string; size: number; mode: number }) => ({
    path: entry.path,
    size: entry.size,
    mode: entry.mode,
  }));
}

function actualNpmPack(workspace: string, epoch: string): {
  archivePath: string;
  archiveBytes: Buffer;
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  packlist: Array<{ path: string; size: number; mode: number }>;
} {
  const packlist = normalizedPacklist(workspace, epoch);
  const result = spawnSync('npm', ['pack', '--ignore-scripts'], {
    cwd: workspace,
    encoding: null,
    env: packEnvironment(epoch),
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = result.stdout as Buffer;
  const stderr = result.stderr as Buffer;
  const exitCode = result.status ?? -1;
  if (exitCode !== 0) {
    throw new Error(`npm pack failed (${exitCode}): ${stderr.toString('utf8')}`);
  }
  const filename = stdout.toString('utf8').trim();
  const archivePath = path.join(workspace, filename);
  return {
    archivePath,
    archiveBytes: fs.readFileSync(archivePath),
    stdout,
    stderr,
    exitCode,
    packlist,
  };
}

function finalAggregatePayload(
  fixture: GitFixture,
  manifest: RunManifestV1,
  inputEnvelope: AggregateEnvelopeV1<RepositoryAggregateInputPayloadV1>,
): { payload: RepositoryAggregateFinalPayloadV1; bundlePath: string; archivePath: string } {
  git(fixture.workspace, 'add', ...WRITER_ROWS.map((row) => row[2]));
  git(fixture.workspace, 'commit', '-m', 'candidate composition', '--no-gpg-sign');
  const candidateCommit = git(fixture.workspace, 'rev-parse', 'HEAD^{commit}');
  const candidateTree = git(fixture.workspace, 'rev-parse', 'HEAD^{tree}');
  const previous = process.cwd();
  process.chdir(fixture.workspace);
  let completeDeltaRoot: string;
  try {
    const evidence = collectFinalTreeEvidence({
      base: manifest.frozen_base_commit,
      candidate: candidateCommit,
      remote: manifest.approved_remote,
      approvedBranch: manifest.approved_branch,
      approvedRemoteOldOid: manifest.approved_remote_old_oid,
    });
    completeDeltaRoot = sha256Hex(canonicalBytesV1(evidence.deltaRecords));
  } finally {
    process.chdir(previous);
  }
  const deterministicProofHash = writeProof(
    fixture.workspace, manifest, 'deterministic', candidateCommit, candidateTree,
  );
  const liveProofHash = writeProof(fixture.workspace, manifest, 'live', candidateCommit, candidateTree);
  const codeReviewProofHash = writeProof(
    fixture.workspace, manifest, 'code_review', candidateCommit, candidateTree,
  );
  const ultraqaProofHash = writeProof(fixture.workspace, manifest, 'ultraqa', candidateCommit, candidateTree);

  const semver = '0.3.0';
  const uploadOrder: [string, 'SHA256SUMS'] = [`iml1s-oh-my-agy-${semver}.tgz`, 'SHA256SUMS'];
  const bundleDirectory = `.agy/artifacts/dual-parity/${manifest.run_key}/OMA-W6/release-bundle`;
  const epoch = git(fixture.workspace, 'show', '-s', '--format=%ct', candidateCommit);
  const packed = actualNpmPack(fixture.workspace, epoch);
  const archive = packed.archiveBytes;
  const checksumBytes = `${sha256Hex(archive)}  ${uploadOrder[0]}\n`;
  const checksum = Buffer.from(checksumBytes, 'utf8');
  const assets = [
    {
      name: uploadOrder[0],
      relative_path: `${bundleDirectory}/${uploadOrder[0]}`,
      byte_length: archive.length,
      sha256: sha256Hex(archive),
      media_type: 'application/gzip',
    },
    {
      name: 'SHA256SUMS',
      relative_path: `${bundleDirectory}/SHA256SUMS`,
      byte_length: checksum.length,
      sha256: sha256Hex(checksum),
      media_type: 'text/plain',
    },
  ];
  const archivePath = path.join(fixture.workspace, ...assets[0].relative_path.split('/'));
  const checksumPath = path.join(fixture.workspace, ...assets[1].relative_path.split('/'));
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.renameSync(packed.archivePath, archivePath);
  fs.writeFileSync(checksumPath, checksum);
  const releaseAssetRoot = sha256Hex(canonicalBytesV1(assets.map((asset) => [
    asset.name, asset.relative_path, asset.byte_length, asset.sha256, asset.media_type,
  ])));
  const bundleRelative = `.agy/artifacts/dual-parity/${manifest.run_key}/OMA-W6/release-bundle-manifest.json`;
  const receiptMaterial = {
    argv: ['npm', 'pack', '--ignore-scripts'],
    cwd_realpath_hash: sha256Hex(Buffer.from(fs.realpathSync(fixture.workspace), 'utf8')),
    toolchain: releaseToolchain(),
    sanitized_environment: [
      ['LANG', 'C'],
      ['LC_ALL', 'C'],
      ['SOURCE_DATE_EPOCH', epoch],
      ['TZ', 'UTC'],
      ['npm_config_loglevel', 'silent'],
    ].map(([name, value]) => ({ name, value_hash: sha256Hex(Buffer.from(value, 'utf8')) })),
    source_date_epoch: epoch,
    locale: 'C',
    timezone: 'UTC',
    umask: process.umask().toString(8).padStart(3, '0'),
    exit_code: packed.exitCode,
    stdout_sha256: sha256Hex(packed.stdout),
    stderr_sha256: sha256Hex(packed.stderr),
    archive_sha256: sha256Hex(archive),
    packlist_sha256: sha256Hex(canonicalBytesV1(packed.packlist)),
  };
  const bundle = {
    store_kind: 'release_bundle_manifest',
    schema_version: 1,
    repository_id: 'OMA',
    run_id: manifest.run_id,
    owner: 'oma-final-composition-owner',
    candidate_commit: candidateCommit,
    candidate_tree: candidateTree,
    semver,
    bundle_directory: bundleDirectory,
    public_upload_order: uploadOrder,
    assets,
    checksum_bytes: checksumBytes,
    checksum_byte_length: checksum.length,
    checksum_sha256: sha256Hex(checksum),
    build_receipt: {
      ...receiptMaterial,
      receipt_hash: sha256Hex(canonicalBytesV1(receiptMaterial)),
    },
    registry_bindings: [],
    release_asset_root: releaseAssetRoot,
  };
  const bundleBytes = canonicalBytesV1(bundle);
  const bundlePath = path.join(fixture.workspace, ...bundleRelative.split('/'));
  fs.writeFileSync(bundlePath, bundleBytes, { mode: 0o600 });
  fs.chmodSync(bundlePath, 0o600);
  git(fixture.workspace, 'push', '--force', 'origin', `${candidateCommit}:refs/heads/main`);
  return {
    payload: {
      store_kind: 'repo_aggregate_final_payload',
      schema_version: 1,
      ...manifestBinding(fixture.workspace, manifest),
      input_envelope: inputEnvelope,
      input_aggregate_hash: inputEnvelope.payload_hash,
      candidate_commit: candidateCommit,
      candidate_tree: candidateTree,
      pushed_oid: candidateCommit,
      complete_delta_root: completeDeltaRoot,
      semver,
      deterministic_proof_hash: deterministicProofHash,
      live_proof_hash: liveProofHash,
      code_review_proof_hash: codeReviewProofHash,
      ultraqa_proof_hash: ultraqaProofHash,
      release_nonce: 'release-nonce-1',
      release_bundle_manifest_path: bundleRelative,
      release_bundle_manifest_sha256: sha256Hex(bundleBytes),
      release_bundle_manifest_schema: 'release_bundle_manifest/1',
      public_upload_order: uploadOrder,
      release_asset_root: releaseAssetRoot,
    },
    bundlePath,
    archivePath,
  };
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function next(
  workspace: string,
  manifest: RunManifestV1,
  nextState: RunManifestV1['state'],
): Promise<RunManifestV1> {
  return advanceRunManifest({
    workspace_path: workspace,
    run_id: manifest.run_id,
    expected_revision: manifest.revision,
    expected_previous_hash: sha256Hex(canonicalBytesV1(manifest)),
    expected_state: manifest.state,
    next_state: nextState,
    updated_at: `2026-07-22T00:00:${String(manifest.revision + 2).padStart(2, '0')}.000Z`,
  });
}

async function prepareAggregateInput(fixture: GitFixture, runId: string): Promise<{
  manifest: RunManifestV1;
  chain: ReturnType<typeof emitSixWaveChain>;
  payload: RepositoryAggregateInputPayloadV1;
}> {
  let manifest = (await initializeRunManifest(input(fixture, runId))).manifest;
  manifest = await next(fixture.workspace, manifest, 'writers_active');
  const chain = emitSixWaveChain(fixture.workspace, manifest);
  manifest = await next(fixture.workspace, manifest, 'inputs_verified');
  return { manifest, chain, payload: inputAggregatePayload(fixture.workspace, manifest, chain.roots) };
}

describe('OMA W0 dual_parity_run_manifest/1 engine', () => {
  test('initialization pins actual Git/frozen policy and creates only exact canonical 0600 authority', async () => {
    const fixture = createGitFixture('oma-run-init-');
    let fill = 1;
    try {
      const result = await initializeRunManifest(
        input(fixture),
        (size) => Buffer.alloc(size, fill++),
      );
      expect(result.manifest.state).toBe('initializing');
      expect(result.manifest.frozen_base_commit).toBe(fixture.baseCommit);
      expect(result.manifest.frozen_base_tree).toBe(fixture.baseTree);
      expect(result.manifest.claimed_release_channels).toEqual(['github']);
      expect(result.manifest.claimed_registry_policy).toEqual([]);
      expect(result.manifest.run_key).toMatch(/^[0-9a-f]{64}$/);
      expect(result.manifest_path).not.toContain('run/with raw unsafe value');
      expect(mode(result.manifest_path)).toBe(0o600);
      expect(mode(result.trust_root_path)).toBe(0o600);
      const manifestBytes = fs.readFileSync(result.manifest_path);
      expect(manifestBytes.at(-1)).not.toBe(0x0a);
      expect(canonicalBytesV1(JSON.parse(manifestBytes.toString('utf8')))).toEqual(manifestBytes);
      const keyDirectory = path.join(path.dirname(result.trust_root_path), 'keys');
      expect(fs.readdirSync(keyDirectory).sort()).toEqual([
        'OMA-W0.hmac', 'OMA-W1.hmac', 'OMA-W2.hmac', 'OMA-W3.hmac', 'OMA-W4.hmac',
        'OMA-W5.hmac', 'OMA-W6-aggregate.hmac',
      ]);
      for (const keyName of fs.readdirSync(keyDirectory)) {
        expect(mode(path.join(keyDirectory, keyName))).toBe(0o600);
      }
      expect(() => validateRunManifest({ ...result.manifest, writer_authority: 'coordinator' } as any))
        .toThrow('authority');
      await expect(initializeRunManifest({
        ...input(fixture, 'fake-base-run'),
        frozen_base_commit: '1'.repeat(40),
      })).rejects.toThrow('git');
      await expect(initializeRunManifest({
        ...input(fixture, 'fake-policy-run'),
        normative_plan_hashes: {
          ...FROZEN_OMA_NORMATIVE_PLAN_HASHES_V1,
          prd: sha('f'),
        },
      })).rejects.toThrow('frozen release contract');

      fs.chmodSync(result.manifest_path, 0o640);
      expect(() => readRunManifest(result.manifest_path)).toThrow('0600');
    } finally {
      cleanup(fixture);
    }
  });

  test('lifecycle cannot advance to closed without authenticated evidence and direct signing revocation is forbidden', async () => {
    const empty = createGitFixture('oma-run-empty-');
    try {
      let manifest = (await initializeRunManifest(input(empty, 'zero-evidence-run'))).manifest;
      manifest = await next(empty.workspace, manifest, 'writers_active');
      await expect(next(empty.workspace, manifest, 'inputs_verified')).rejects.toThrow('missing');
      await expect(next(empty.workspace, manifest, 'closed')).rejects.toThrow('not allowed');
    } finally {
      cleanup(empty);
    }

    const fixture = createGitFixture('oma-run-direct-revoke-');
    try {
      const prepared = await prepareAggregateInput(fixture, 'direct-revoke-run');
      const inputEnvelope = await signRepositoryAggregate({
        workspace_path: fixture.workspace,
        run_id: prepared.manifest.run_id,
        expected_manifest_revision: prepared.manifest.revision,
        expected_lease_generation: prepared.manifest.lease_generation,
        phase: 'input',
        payload: prepared.payload,
      });
      expect(inputEnvelope.payload_hash).toBe(sha256Hex(canonicalBytesV1(prepared.payload)));
      const composition = await next(fixture.workspace, prepared.manifest, 'composition_active');
      await expect(next(fixture.workspace, composition, 'signing_revoked')).rejects.toThrow('only through');
    } finally {
      cleanup(fixture);
    }
  });

  test('input owner union excludes W6 compositor paths while final candidate still binds them', async () => {
    const fixture = createGitFixture('oma-run-w6-union-');
    try {
      let manifest = (await initializeRunManifest(input(fixture, 'w6-union-run'))).manifest;
      manifest = await next(fixture.workspace, manifest, 'writers_active');
      const chain = emitSixWaveChain(fixture.workspace, manifest);
      const w6Path = 'package.json';
      writeRepositoryFile(fixture.workspace, w6Path, `${JSON.stringify({
        name: '@iml1s/oh-my-agy',
        version: '0.3.1',
        private: true,
      }, null, 2)}\n`);

      const signedPaths = chain.roots.flatMap((root) => {
        const index = JSON.parse(fs.readFileSync(
          path.join(fixture.workspace, ...root.proposal_index_path.split('/')),
          'utf8',
        ));
        return index.proposals.map((proposal: { path: string }) => proposal.path);
      });
      expect(signedPaths).not.toContain(w6Path);

      await expect(next(fixture.workspace, manifest, 'inputs_verified')).resolves.toMatchObject({
        state: 'inputs_verified',
      });

      git(fixture.workspace, 'add', ...WRITER_ROWS.map((row) => row[2]), w6Path);
      git(fixture.workspace, 'commit', '-m', 'candidate composition', '--no-gpg-sign');
      const candidateCommit = git(fixture.workspace, 'rev-parse', 'HEAD^{commit}');
      const previous = process.cwd();
      process.chdir(fixture.workspace);
      let evidence: ReturnType<typeof collectFinalTreeEvidence>;
      try {
        evidence = collectFinalTreeEvidence({
          base: fixture.baseCommit,
          candidate: candidateCommit,
          remote: 'origin',
          approvedBranch: 'main',
          approvedRemoteOldOid: fixture.baseCommit,
        });
      } finally {
        process.chdir(previous);
      }
      expect(evidence.deltaPaths).toContain(w6Path);
      expect(ownershipForPath(w6Path)).toEqual({
        wave: 'OMA-W6',
        owner: 'oma-final-composition-owner',
      });
    } finally {
      cleanup(fixture);
    }
  });

  test('inclusive ownership rejects arbitrary paths, wrong base hashes, and failed targeted tests', async () => {
    for (const [name, options, message] of [
      ['arbitrary', { arbitraryPath: true }, 'ownership'],
      ['initial', { badInitialWave: 'OMA-W2' as WriterWave }, 'frozen-base'],
      ['test', { failingTestWave: 'OMA-W4' as WriterWave }, 'targeted test'],
      ['incomplete', { incompleteWave: 'OMA-W5' as WriterWave }, 'differs from the inclusive'],
    ] as const) {
      const fixture = createGitFixture(`oma-run-${name}-`);
      try {
        let manifest = (await initializeRunManifest(input(fixture, `${name}-run`))).manifest;
        manifest = await next(fixture.workspace, manifest, 'writers_active');
        emitSixWaveChain(fixture.workspace, manifest, options);
        await expect(next(fixture.workspace, manifest, 'inputs_verified')).rejects.toThrow(message);
      } finally {
        cleanup(fixture);
      }
    }
  });

  test('W6 request documents require the exact schema, owner boundary, requests, acceptance, and argv', async () => {
    const fixture = createGitFixture('oma-run-request-');
    try {
      let manifest = (await initializeRunManifest(input(fixture, 'request-run'))).manifest;
      manifest = await next(fixture.workspace, manifest, 'writers_active');
      const [wave, owner, repositoryPath] = WRITER_ROWS[0];
      const initial = fs.readFileSync(path.join(fixture.workspace, repositoryPath));
      const final = Buffer.from('request test product\n', 'utf8');
      writeRepositoryFile(fixture.workspace, repositoryPath, final);
      const proposal = createPathProposal({
        store_kind: 'dual_parity_path_proposal', schema_version: 1, repository_id: 'OMA',
        run_id: manifest.run_id, wave, owner, path: repositoryPath,
        initial_sha256: sha256Hex(initial), final_sha256: sha256Hex(final), disposition: 'changed',
        reason: 'Validate the exact W6 request schema.', targeted_tests: [{
          argv: ['npm', 'test'], exit_code: 0, stdout_sha256: sha('1'), stderr_sha256: sha('0'),
        }],
      });
      const base = {
        workspace_path: fixture.workspace,
        run_id: manifest.run_id,
        wave,
        owner,
        expected_manifest_revision: manifest.revision,
        proposals: [proposal],
        parent_handoffs: [],
        completed_at: '2026-07-22T00:00:03.000Z',
      };
      const exact = w6RequestDocument(manifest.run_id, wave);
      const invalid = canonicalBytesV1({ ...exact, acceptance: [] });
      expect(() => writeWaveHandoffArtifacts({
        ...base,
        w6_requests: [writeW6Request(fixture.workspace, manifest, wave, invalid)],
      })).toThrow('non-empty');
      const extra = canonicalBytesV1({ ...exact, generic_summary: 'trust me' });
      expect(() => writeWaveHandoffArtifacts({
        ...base,
        w6_requests: [writeW6Request(fixture.workspace, manifest, wave, extra)],
      })).toThrow('keys');
      const bytes = canonicalBytesV1(exact);
      const binding = writeW6Request(fixture.workspace, manifest, wave, bytes);
      const artifacts = writeWaveHandoffArtifacts({ ...base, w6_requests: [binding] });
      expect(() => verifyWaveHandoffArtifacts({
        workspace_path: fixture.workspace,
        run_id: manifest.run_id,
        handoff_path: artifacts.handoff_path,
      })).not.toThrow();
      fs.chmodSync(path.join(fixture.workspace, ...binding.path.split('/')), 0o644);
      expect(() => verifyWaveHandoffArtifacts({
        workspace_path: fixture.workspace,
        run_id: manifest.run_id,
        handoff_path: artifacts.handoff_path,
      })).toThrow('0600');
    } finally {
      cleanup(fixture);
    }
  });

  test('input aggregate CAS is canonical, authenticated, mode-exact, and required before composition', async () => {
    const fixture = createGitFixture('oma-run-input-cas-');
    try {
      const prepared = await prepareAggregateInput(fixture, 'input-cas-run');
      const envelope = await signRepositoryAggregate({
        workspace_path: fixture.workspace,
        run_id: prepared.manifest.run_id,
        expected_manifest_revision: prepared.manifest.revision,
        expected_lease_generation: prepared.manifest.lease_generation,
        phase: 'input',
        payload: prepared.payload,
      });
      const aggregatePath = expectedRepositoryAggregatePath(fixture.workspace, prepared.manifest.run_id);
      const store = JSON.parse(fs.readFileSync(aggregatePath, 'utf8'));
      expect(mode(aggregatePath)).toBe(0o600);
      expect(store).toEqual(expect.objectContaining({
        store_kind: 'repo_aggregate_handoff', revision: 1,
        previous_aggregate_hash: null, input_envelope: envelope, final_envelope: null,
      }));
      const adopted = await signRepositoryAggregate({
        workspace_path: fixture.workspace,
        run_id: prepared.manifest.run_id,
        expected_manifest_revision: prepared.manifest.revision,
        expected_lease_generation: prepared.manifest.lease_generation,
        phase: 'input',
        payload: prepared.payload,
      });
      expect(adopted).toEqual(envelope);
      expect(() => verifyRepositoryAggregate({
        workspace_path: fixture.workspace,
        run_id: prepared.manifest.run_id,
        phase: 'input',
        envelope,
      })).not.toThrow();
      fs.chmodSync(aggregatePath, 0o644);
      await expect(next(fixture.workspace, prepared.manifest, 'composition_active')).rejects.toThrow('0600');
      fs.chmodSync(aggregatePath, 0o600);
      fs.rmSync(aggregatePath);
      await expect(next(fixture.workspace, prepared.manifest, 'composition_active')).rejects.toThrow('missing');
    } finally {
      cleanup(fixture);
    }
  });

  test('final aggregate authenticates real Git candidate/proofs/bundle and atomically revokes signing', async () => {
    const fixture = createGitFixture('oma-run-final-');
    try {
      const prepared = await prepareAggregateInput(fixture, 'final-run');
      const inputEnvelope = await signRepositoryAggregate({
        workspace_path: fixture.workspace,
        run_id: prepared.manifest.run_id,
        expected_manifest_revision: prepared.manifest.revision,
        expected_lease_generation: prepared.manifest.lease_generation,
        phase: 'input',
        payload: prepared.payload,
      });
      const composition = await next(fixture.workspace, prepared.manifest, 'composition_active');
      const built = finalAggregatePayload(fixture, composition, inputEnvelope);
      const signFinal = (payload: RepositoryAggregateFinalPayloadV1) => signRepositoryAggregate({
        workspace_path: fixture.workspace,
        run_id: composition.run_id,
        expected_manifest_revision: composition.revision,
        expected_lease_generation: composition.lease_generation,
        phase: 'final',
        payload,
      });

      await expect(signFinal({ ...built.payload, candidate_commit: '7'.repeat(40) }))
        .rejects.toThrow();
      await expect(signFinal({ ...built.payload, complete_delta_root: sha('9') }))
        .rejects.toThrow('complete_delta_root');
      await expect(signFinal({
        ...built.payload,
        semver: '9.9.9',
        public_upload_order: ['iml1s-oh-my-agy-9.9.9.tgz', 'SHA256SUMS'],
      }))
        .rejects.toThrow('package.json');
      await expect(signFinal({ ...built.payload, code_review_proof_hash: sha('8') }))
        .rejects.toThrow('code_review proof');
      const proofRoot = path.dirname(built.bundlePath);
      const codeReviewProofPath = path.join(proofRoot, 'code-review-proof.json');
      const codeReviewEvidencePath = path.join(proofRoot, 'code-review-evidence.log');
      const validCodeReviewProofBytes = fs.readFileSync(codeReviewProofPath);
      const validEvidenceBytes = fs.readFileSync(codeReviewEvidencePath);
      const codeReviewProof = JSON.parse(validCodeReviewProofBytes.toString('utf8'));
      const signerClaimBytes = canonicalBytesV1({
        ...codeReviewProof,
        reviewer_id: composition.aggregate_signer_id,
      });
      fs.writeFileSync(codeReviewProofPath, signerClaimBytes, { mode: 0o600 });
      await expect(signFinal({
        ...built.payload,
        code_review_proof_hash: sha256Hex(signerClaimBytes),
      })).rejects.toThrow('reviewer identity');
      const driftedTestArgv = ['true'];
      const driftedEvidenceBytes = canonicalBytesV1({
        store_kind: 'oma_release_test_evidence',
        schema_version: 1,
        repository_id: 'OMA',
        run_id: composition.run_id,
        proof_kind: 'code_review',
        reviewer_id: composition.aggregate_verifier_id,
        candidate_commit: built.payload.candidate_commit,
        candidate_tree: built.payload.candidate_tree,
        test_argv: driftedTestArgv,
        test_result: codeReviewProof.test_result,
      });
      fs.chmodSync(codeReviewEvidencePath, 0o600);
      fs.writeFileSync(codeReviewEvidencePath, driftedEvidenceBytes);
      fs.chmodSync(codeReviewEvidencePath, 0o400);
      const driftedCommandBytes = canonicalBytesV1({
        ...codeReviewProof,
        test_argv: driftedTestArgv,
        evidence: {
          ...codeReviewProof.evidence,
          byte_length: driftedEvidenceBytes.length,
          sha256: sha256Hex(driftedEvidenceBytes),
        },
      });
      fs.writeFileSync(codeReviewProofPath, driftedCommandBytes, { mode: 0o600 });
      await expect(signFinal({
        ...built.payload,
        code_review_proof_hash: sha256Hex(driftedCommandBytes),
      })).rejects.toThrow('signature');
      fs.writeFileSync(codeReviewProofPath, validCodeReviewProofBytes, { mode: 0o600 });
      fs.chmodSync(codeReviewProofPath, 0o600);
      fs.chmodSync(codeReviewEvidencePath, 0o600);
      fs.writeFileSync(codeReviewEvidencePath, validEvidenceBytes);
      fs.chmodSync(codeReviewEvidencePath, 0o400);

      fs.chmodSync(codeReviewEvidencePath, 0o600);
      fs.writeFileSync(codeReviewEvidencePath, Buffer.from('drifted evidence\n'));
      fs.chmodSync(codeReviewEvidencePath, 0o400);
      await expect(signFinal(built.payload)).rejects.toThrow('evidence drifted');
      fs.chmodSync(codeReviewEvidencePath, 0o600);
      fs.writeFileSync(codeReviewEvidencePath, validEvidenceBytes);
      fs.chmodSync(codeReviewEvidencePath, 0o400);

      const residualPath = path.join(fixture.workspace, 'tests', 'cli', 'residual.spec.ts');
      fs.mkdirSync(path.dirname(residualPath), { recursive: true });
      fs.writeFileSync(residualPath, 'uncommitted residual\n');
      await expect(signFinal(built.payload)).rejects.toThrow('Final-tree ownership proof failed');
      fs.rmSync(residualPath);

      git(fixture.workspace, 'push', '--force', 'origin', `${fixture.baseCommit}:refs/heads/main`);
      await expect(signFinal(built.payload)).rejects.toThrow('expected remote OID');
      git(fixture.workspace, 'push', '--force', 'origin', `${built.payload.candidate_commit}:refs/heads/main`);

      const bundleDirectory = path.dirname(built.archivePath);
      const extra = path.join(bundleDirectory, 'EXTRA');
      fs.writeFileSync(extra, 'unexpected');
      await expect(signFinal(built.payload)).rejects.toThrow('missing, extra');
      fs.rmSync(extra);

      const bundle = JSON.parse(fs.readFileSync(built.bundlePath, 'utf8'));
      const driftedReceipt = {
        ...bundle,
        build_receipt: { ...bundle.build_receipt, cwd_realpath_hash: sha('a') },
      };
      driftedReceipt.build_receipt.receipt_hash = sha256Hex(canonicalBytesV1(
        Object.fromEntries(Object.entries(driftedReceipt.build_receipt)
          .filter(([key]) => key !== 'receipt_hash')),
      ));
      const driftedBytes = canonicalBytesV1(driftedReceipt);
      fs.writeFileSync(built.bundlePath, driftedBytes, { mode: 0o600 });
      await expect(signFinal({
        ...built.payload,
        release_bundle_manifest_sha256: sha256Hex(driftedBytes),
      })).rejects.toThrow('actual argv/cwd');
      const validBundleBytes = canonicalBytesV1(bundle);
      fs.writeFileSync(built.bundlePath, validBundleBytes, { mode: 0o600 });
      fs.chmodSync(built.bundlePath, 0o600);

      const validArchiveBytes = fs.readFileSync(built.archivePath);
      const checksumPath = path.join(path.dirname(built.archivePath), 'SHA256SUMS');
      const validChecksumBytes = fs.readFileSync(checksumPath);
      const plaintextArchive = Buffer.from('self-described plaintext is not an npm package\n', 'utf8');
      const plaintextBundle = copy(bundle);
      plaintextBundle.assets[0].byte_length = plaintextArchive.length;
      plaintextBundle.assets[0].sha256 = sha256Hex(plaintextArchive);
      const plaintextChecksum = Buffer.from(
        `${plaintextBundle.assets[0].sha256}  ${plaintextBundle.assets[0].name}\n`,
        'utf8',
      );
      plaintextBundle.assets[1].byte_length = plaintextChecksum.length;
      plaintextBundle.assets[1].sha256 = sha256Hex(plaintextChecksum);
      plaintextBundle.checksum_bytes = plaintextChecksum.toString('utf8');
      plaintextBundle.checksum_byte_length = plaintextChecksum.length;
      plaintextBundle.checksum_sha256 = sha256Hex(plaintextChecksum);
      plaintextBundle.build_receipt.archive_sha256 = sha256Hex(plaintextArchive);
      const plaintextReceiptMaterial = { ...plaintextBundle.build_receipt };
      delete plaintextReceiptMaterial.receipt_hash;
      plaintextBundle.build_receipt.receipt_hash = sha256Hex(canonicalBytesV1(plaintextReceiptMaterial));
      plaintextBundle.release_asset_root = sha256Hex(canonicalBytesV1(
        plaintextBundle.assets.map((asset: Record<string, unknown>) => [
          asset.name, asset.relative_path, asset.byte_length, asset.sha256, asset.media_type,
        ]),
      ));
      fs.writeFileSync(built.archivePath, plaintextArchive);
      fs.writeFileSync(checksumPath, plaintextChecksum);
      const plaintextBundleBytes = canonicalBytesV1(plaintextBundle);
      fs.writeFileSync(built.bundlePath, plaintextBundleBytes, { mode: 0o600 });
      await expect(signFinal({
        ...built.payload,
        release_bundle_manifest_sha256: sha256Hex(plaintextBundleBytes),
        release_asset_root: plaintextBundle.release_asset_root,
      })).rejects.toThrow('not gzip');
      fs.writeFileSync(built.archivePath, validArchiveBytes);
      fs.writeFileSync(checksumPath, validChecksumBytes);
      fs.writeFileSync(built.bundlePath, validBundleBytes, { mode: 0o600 });
      fs.chmodSync(built.bundlePath, 0o600);

      const finalEnvelope = await signFinal(built.payload);
      const revoked = readRunManifest(locateRunManifest(fixture.workspace, composition.run_id).manifest_path);
      expect(revoked.state).toBe('signing_revoked');
      expect(revoked.revision).toBe(composition.revision + 1);
      const aggregatePath = expectedRepositoryAggregatePath(fixture.workspace, composition.run_id);
      const store = JSON.parse(fs.readFileSync(aggregatePath, 'utf8'));
      expect(store.revision).toBe(2);
      expect(store.previous_aggregate_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(store.final_envelope).toEqual(finalEnvelope);
      await expect(signFinal(built.payload)).resolves.toEqual(finalEnvelope);
      expect(() => verifyRepositoryAggregate({
        workspace_path: fixture.workspace,
        run_id: composition.run_id,
        phase: 'final',
        envelope: finalEnvelope,
      })).not.toThrow();

      git(fixture.workspace, 'push', '--force', 'origin', `${fixture.baseCommit}:refs/heads/main`);
      expect(() => verifyRepositoryAggregate({
        workspace_path: fixture.workspace,
        run_id: composition.run_id,
        phase: 'final',
        envelope: finalEnvelope,
      })).toThrow('expected remote OID');
      git(fixture.workspace, 'push', '--force', 'origin', `${built.payload.candidate_commit}:refs/heads/main`);

      const archiveBytes = fs.readFileSync(built.archivePath);
      fs.writeFileSync(built.archivePath, 'drifted archive');
      expect(() => verifyRepositoryAggregate({
        workspace_path: fixture.workspace,
        run_id: composition.run_id,
        phase: 'final',
        envelope: finalEnvelope,
      })).toThrow('bytes drifted');
      fs.writeFileSync(built.archivePath, archiveBytes);

      let lifecycle = await next(fixture.workspace, revoked, 'release_active');
      lifecycle = await next(fixture.workspace, lifecycle, 'closed');
      expect(lifecycle.state).toBe('closed');
    } finally {
      cleanup(fixture);
    }
  });

  test('signed finalization journal reconciles every write-boundary crash and exact retry', async () => {
    const fixture = createGitFixture('oma-run-final-crash-');
    try {
      const prepared = await prepareAggregateInput(fixture, 'final-crash-run');
      const inputEnvelope = await signRepositoryAggregate({
        workspace_path: fixture.workspace,
        run_id: prepared.manifest.run_id,
        expected_manifest_revision: prepared.manifest.revision,
        expected_lease_generation: prepared.manifest.lease_generation,
        phase: 'input',
        payload: prepared.payload,
      });
      const composition = await next(fixture.workspace, prepared.manifest, 'composition_active');
      const built = finalAggregatePayload(fixture, composition, inputEnvelope);
      const location = locateRunManifest(fixture.workspace, composition.run_id);
      const aggregatePath = expectedRepositoryAggregatePath(fixture.workspace, composition.run_id);
      const journalPath = expectedFinalSigningJournalPath(fixture.workspace, composition.run_id);
      const baseManifestBytes = fs.readFileSync(location.manifest_path);
      const baseAggregateBytes = fs.readFileSync(aggregatePath);
      const faultPoints: FinalSigningFaultPointV1[] = [
        'before_journal_write',
        'after_journal_write',
        'before_aggregate_write',
        'after_aggregate_write',
        'before_manifest_write',
        'after_manifest_write',
      ];
      let expectedEnvelope: AggregateEnvelopeV1<RepositoryAggregateFinalPayloadV1> | undefined;
      for (const point of faultPoints) {
        fs.writeFileSync(location.manifest_path, baseManifestBytes, { mode: 0o600 });
        fs.chmodSync(location.manifest_path, 0o600);
        fs.writeFileSync(aggregatePath, baseAggregateBytes, { mode: 0o600 });
        fs.chmodSync(aggregatePath, 0o600);
        if (fs.existsSync(journalPath)) fs.unlinkSync(journalPath);
        let injected = false;
        await expect(signRepositoryAggregate({
          workspace_path: fixture.workspace,
          run_id: composition.run_id,
          expected_manifest_revision: composition.revision,
          expected_lease_generation: composition.lease_generation,
          phase: 'final',
          payload: built.payload,
          fault_injection: (observed) => {
            if (!injected && observed === point) {
              injected = true;
              throw new Error(`simulated process exit at ${point}`);
            }
          },
        })).rejects.toThrow(`simulated process exit at ${point}`);
        expect(injected).toBe(true);
        expect(fs.existsSync(journalPath)).toBe(point !== 'before_journal_write');
        if (fs.existsSync(journalPath)) expect(mode(journalPath)).toBe(0o600);

        const recovered = await signRepositoryAggregate({
          workspace_path: fixture.workspace,
          run_id: composition.run_id,
          expected_manifest_revision: composition.revision,
          expected_lease_generation: composition.lease_generation,
          phase: 'final',
          payload: built.payload,
        });
        expectedEnvelope ??= recovered;
        expect(recovered).toEqual(expectedEnvelope);
        expect(fs.existsSync(journalPath)).toBe(false);
        expect(readRunManifest(location.manifest_path).state).toBe('signing_revoked');
        const store = JSON.parse(fs.readFileSync(aggregatePath, 'utf8'));
        expect(store.revision).toBe(2);
        expect(store.final_envelope).toEqual(expectedEnvelope);
        expect(mode(location.manifest_path)).toBe(0o600);
        expect(mode(aggregatePath)).toBe(0o600);
      }

      fs.writeFileSync(location.manifest_path, baseManifestBytes, { mode: 0o600 });
      fs.chmodSync(location.manifest_path, 0o600);
      fs.writeFileSync(aggregatePath, baseAggregateBytes, { mode: 0o600 });
      fs.chmodSync(aggregatePath, 0o600);
      if (fs.existsSync(journalPath)) fs.unlinkSync(journalPath);
      const crashInputPath = path.join(fixture.root, 'finalization-crash-input.json');
      fs.writeFileSync(crashInputPath, JSON.stringify({
        workspace_path: fixture.workspace,
        run_id: composition.run_id,
        expected_manifest_revision: composition.revision,
        expected_lease_generation: composition.lease_generation,
        phase: 'final',
        payload: built.payload,
      }));
      const childSource = `
        const fs = require('fs');
        const { signRepositoryAggregate } = require('./src/contracts');
        const options = JSON.parse(fs.readFileSync(process.env.OMA_CRASH_INPUT, 'utf8'));
        void signRepositoryAggregate({
          ...options,
          fault_injection(point) {
            if (point === 'after_aggregate_write') process.exit(73);
          },
        }).then(
          () => process.exit(74),
          (error) => {
            process.stderr.write(String(error && error.stack ? error.stack : error));
            process.exit(75);
          },
        );
      `;
      const crashed = spawnSync(
        process.execPath,
        ['-r', 'ts-node/register/transpile-only', '-e', childSource],
        {
          cwd: path.resolve(__dirname, '../..'),
          encoding: 'utf8',
          env: { ...process.env, OMA_CRASH_INPUT: crashInputPath },
          timeout: 120_000,
        },
      );
      expect(crashed.signal).toBeNull();
      expect({ status: crashed.status, stderr: crashed.stderr }).toEqual({ status: 73, stderr: '' });
      expect(fs.existsSync(journalPath)).toBe(true);
      expect(mode(journalPath)).toBe(0o600);
      expect(fs.existsSync(`${location.manifest_path}.lock`)).toBe(true);
      fs.chmodSync(aggregatePath, 0o644);

      const processExitRecovered = await signRepositoryAggregate({
        workspace_path: fixture.workspace,
        run_id: composition.run_id,
        expected_manifest_revision: composition.revision,
        expected_lease_generation: composition.lease_generation,
        phase: 'final',
        payload: built.payload,
      });
      expect(processExitRecovered).toEqual(expectedEnvelope);
      expect(fs.existsSync(journalPath)).toBe(false);
      expect(fs.existsSync(`${location.manifest_path}.lock`)).toBe(false);
      expect(mode(location.manifest_path)).toBe(0o600);
      expect(mode(aggregatePath)).toBe(0o600);
    } finally {
      cleanup(fixture);
    }
  });

  test('aggregate payloads reject omitted/extra fields, substituted evidence, and noncanonical release policy', async () => {
    const fixture = createGitFixture('oma-run-negative-');
    try {
      const prepared = await prepareAggregateInput(fixture, 'negative-run');
      const signInput = (payload: RepositoryAggregateInputPayloadV1) => signRepositoryAggregate({
        workspace_path: fixture.workspace,
        run_id: prepared.manifest.run_id,
        expected_manifest_revision: prepared.manifest.revision,
        expected_lease_generation: prepared.manifest.lease_generation,
        phase: 'input',
        payload,
      });
      const missing = copy(prepared.payload) as any;
      delete missing.path_test_merkle_root;
      await expect(signInput(missing)).rejects.toThrow('keys');
      await expect(signInput({ ...prepared.payload, generic_summary: 'trust me' } as any))
        .rejects.toThrow('keys');
      const substituted = copy(prepared.payload);
      substituted.ordered_owner_roots[0].signature = sha('f');
      await expect(signInput(substituted)).rejects.toThrow('authenticated current');
      await expect(signInput({
        ...prepared.payload,
        claimed_release_channels: ['github', 'npm'],
      } as any)).rejects.toThrow('GitHub Release-only');
    } finally {
      cleanup(fixture);
    }
  });

  test('CAS predecessor checks and blocked terminal behavior remain fail-closed', async () => {
    const fixture = createGitFixture('oma-run-cas-');
    try {
      const created = await initializeRunManifest(input(fixture, 'cas-run'));
      const before = fs.readFileSync(created.manifest_path);
      await expect(advanceRunManifest({
        workspace_path: fixture.workspace,
        run_id: created.manifest.run_id,
        expected_revision: 9,
        expected_previous_hash: sha256Hex(canonicalBytesV1(created.manifest)),
        expected_state: 'initializing',
        next_state: 'writers_active',
      })).rejects.toThrow('predecessor');
      expect(fs.readFileSync(created.manifest_path)).toEqual(before);
      const blocked = await advanceRunManifest({
        workspace_path: fixture.workspace,
        run_id: created.manifest.run_id,
        expected_revision: created.manifest.revision,
        expected_previous_hash: sha256Hex(canonicalBytesV1(created.manifest)),
        expected_state: 'initializing',
        next_state: 'blocked',
        updated_at: '2026-07-22T00:00:02.000Z',
      });
      await expect(next(fixture.workspace, blocked, 'writers_active')).rejects.toThrow('not allowed');
    } finally {
      cleanup(fixture);
    }
  });
});
