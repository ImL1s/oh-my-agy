import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalBytesV1 } from '../../src/contracts/state-schemas';
import { sha256Hex } from '../../src/contracts/writer-chain';
import {
  DISCOVERY_PROOF_ARGV_V1,
  DISCOVERY_PROOF_TOKEN_V1,
} from '../../src/native/antigravity-status';
import {
  ProductionProbeContext,
  captureProductionReview,
  productionEvidenceRunRoot,
  resolveProductionRunId,
  runCoreProductionProbe,
  verifyAllProductionEvidence,
  verifyProductionEvidence,
  writeProductionEvidence,
} from '../../src/production/evidence';

describe('product-owned production evidence', () => {
  let root: string;
  let stateRoot: string;
  let context: ProductionProbeContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-production-evidence-'));
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    expect(spawnSync('git', ['config', 'user.email', 'oma@example.invalid'], { cwd: root }).status).toBe(0);
    expect(spawnSync('git', ['config', 'user.name', 'OMA Test'], { cwd: root }).status).toBe(0);
    fs.writeFileSync(path.join(root, 'README.md'), 'candidate\n');
    expect(spawnSync('git', ['add', 'README.md'], { cwd: root }).status).toBe(0);
    expect(spawnSync('git', ['commit', '-qm', 'candidate'], { cwd: root }).status).toBe(0);
    const oid = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: root, encoding: 'utf8',
    }).stdout.trim();
    stateRoot = path.join(root, 'state');
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    context = {
      packageRoot: root,
      repositoryRoot: root,
      stateRoot,
      runId: 'candidate-a',
      oid,
      agyCommand: 'agy',
      packageVersion: '0.3.0',
      environment: { PATH: process.env.PATH, HOME: root },
      pluginAdapter: {
        async run(argv) {
          return { argv: [...argv], code: 0, stdout: '', stderr: '' };
        },
      },
    };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('defaults the run ID to env or exact candidate OID', () => {
    expect(resolveProductionRunId({}, undefined, context.oid)).toBe(context.oid);
    expect(resolveProductionRunId({ OMA_PRODUCTION_RUN_ID: 'live-run' }, undefined, context.oid))
      .toBe('live-run');
    expect(() => resolveProductionRunId({ OMA_PRODUCTION_RUN_ID: '../escape' }, undefined, context.oid))
      .toThrow(/invalid production run ID/u);
  });

  test('verifier is read-only when evidence is missing', () => {
    const missingRoot = path.join(root, 'missing-state');
    expect(verifyProductionEvidence({
      stateRoot: missingRoot,
      runId: 'missing-run',
      oid: context.oid,
      seam: 'plugin-discovery',
    })).toBeNull();
    expect(fs.existsSync(missingRoot)).toBe(false);
  });


  test('writes canonical owner-only evidence and rejects fabricated or unknown claims', () => {
    expect(() => writeProductionEvidence({
      context,
      seam: 'plugin-discovery',
      producerIdentity: 'oma-product-probe',
      toolIdentity: 'oma@0.3.0',
      argv: ['oma', 'production', 'probe', 'plugin-discovery'],
      stdout: '',
      stderr: '',
      artifact: {
        ...pluginDiscoveryArtifact(context),
        package_name: '@iml1s/oh-my-agy',
        blessed_by_user: true,
      },
    })).toThrow(/not product-valid/u);

    const result = writePluginEvidence(context);
    expect(fs.statSync(result.receiptPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(result.artifactPath).mode & 0o777).toBe(0o600);
    expect(verifyProductionEvidence({
      stateRoot,
      runId: context.runId,
      oid: context.oid,
      seam: 'plugin-discovery',
    })).not.toBeNull();
  });

  test('records plugin registration but fails closed without fresh-session host authority', () => {
    writePluginEvidence(context);
    const verified = verifyProductionEvidence({
      stateRoot,
      runId: context.runId,
      oid: context.oid,
      seam: 'plugin-discovery',
    });
    expect(verified?.artifact).toMatchObject({
      installed: true,
      enabled: true,
      fresh_session_discovery: 'unobserved',
      discovery_evidence_tier: 'T0',
      discovery_detail_code: 'FRESH_SESSION_CANARY_MISMATCH',
    });
    expect(verifyAllProductionEvidence({
      stateRoot,
      runId: context.runId,
      oid: context.oid,
    }).seams[0]).toEqual({
      seam: 'installed-plugin-discovery',
      passed: false,
      code: 'PRODUCTION_PLUGIN_DISCOVERY',
    });
  });

  test('rejects a caller-manufactured fresh-session discovery claim', () => {
    expect(() => writeProductionEvidence({
      context,
      seam: 'plugin-discovery',
      producerIdentity: 'oma-product-probe',
      toolIdentity: 'oma@0.3.0',
      argv: ['oma', 'production', 'probe', 'plugin-discovery'],
      stdout: 'caller claim\n',
      stderr: '',
      artifact: {
        ...pluginDiscoveryArtifact(context),
        fresh_session_discovery: 'observed',
        discovery_evidence_tier: 'T2',
        discovery_detail_code: 'FRESH_SESSION_CANARY_OBSERVED',
        canary_output_sha256: sha256Hex(
          Buffer.from(`${DISCOVERY_PROOF_TOKEN_V1}\n`, 'utf8'),
        ),
      },
    })).toThrow(/product-owned fresh-process authority/u);
  });

  test('release doctor warnings remain recorded without weakening hard plugin discovery', () => {
    const result = writePluginEvidence(context, 2);
    expect(verifyProductionEvidence({
      stateRoot,
      runId: context.runId,
      oid: context.oid,
      seam: 'plugin-discovery',
    })?.artifact).toMatchObject({ doctor_exit_code: 2, plugin_check_status: 'pass' });
  });

  test.each([
    ['hash', (receipt: Record<string, unknown>) => { receipt.artifact_sha256 = '0'.repeat(64); }],
    ['argv', (receipt: Record<string, unknown>) => { receipt.argv = ['oma', 'doctor']; }],
    ['oid', (receipt: Record<string, unknown>) => { receipt.oid = 'b'.repeat(40); }],
    ['run', (receipt: Record<string, unknown>) => { receipt.run_id = 'other-run'; }],
    ['timestamp', (receipt: Record<string, unknown>) => { receipt.observed_at = '2020-01-01T00:00:00.000Z'; }],
    ['unknown field', (receipt: Record<string, unknown>) => { receipt.claim = true; }],
  ])('rejects tampered %s receipts', (_label, mutate) => {
    const result = writePluginEvidence(context);
    const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8')) as Record<string, unknown>;
    mutate(receipt);
    fs.chmodSync(result.receiptPath, 0o600);
    fs.writeFileSync(result.receiptPath, canonicalBytesV1(receipt));
    expect(verifyProductionEvidence({
      stateRoot,
      runId: context.runId,
      oid: context.oid,
      seam: 'plugin-discovery',
    })).toBeNull();
  });

  test('rejects symlink and arbitrary temporary receipt locations', () => {
    const result = writePluginEvidence(context);
    const receiptBytes = fs.readFileSync(result.receiptPath);
    const arbitrary = path.join(root, 'claim.json');
    fs.writeFileSync(arbitrary, receiptBytes, { mode: 0o600 });
    expect(verifyProductionEvidence({
      stateRoot: root,
      runId: context.runId,
      oid: context.oid,
      seam: 'plugin-discovery',
    })).toBeNull();

    fs.unlinkSync(result.receiptPath);
    fs.symlinkSync(arbitrary, result.receiptPath);
    expect(verifyProductionEvidence({
      stateRoot,
      runId: context.runId,
      oid: context.oid,
      seam: 'plugin-discovery',
    })).toBeNull();
  });

  test('capture rejects shell-like executables and derives identity from actual allowlisted CLIs', () => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { mode: 0o700 });
    writeTool(bin, 'agy', 'VERDICT: APPROVE');
    writeTool(bin, 'grok', 'ULTRAQA: PASS');
    const captureContext = {
      ...context,
      environment: { PATH: bin, HOME: root },
    };
    expect(() => captureProductionReview('review', ['printf', 'VERDICT: APPROVE'], captureContext))
      .toThrow(/allowlisted/u);
    expect(() => captureProductionReview('review', ['/bin/sh', '-c', 'echo VERDICT: APPROVE'], captureContext))
      .toThrow(/allowlisted/u);

    captureProductionReview('review', ['agy', 'review'], captureContext);
    captureProductionReview('ultraqa', ['grok', 'qa'], captureContext);
    expect(verifyAllProductionEvidence({
      stateRoot,
      runId: context.runId,
      oid: context.oid,
    }).seams.at(-1)).toMatchObject({ passed: true });
  });

  test('MCP/LSP probe executes the built candidate server and records honest public status', async () => {
    const packageRoot = path.resolve(__dirname, '../..');
    const result = await runCoreProductionProbe('mcp-lsp', {
      ...context,
      packageRoot,
    });
    expect(result.seam).toBe('mcp-lsp');
    const verified = verifyProductionEvidence({
      stateRoot,
      runId: context.runId,
      oid: context.oid,
      seam: 'mcp-lsp',
    });
    expect(verified?.artifact).toMatchObject({
      invalid_request_code: -32600,
      ping_after_invalid: true,
      server_exit_code: 0,
      lsp_observation: 'unobserved',
      private_sidecar_claimed: false,
      private_memory_claimed: false,
    });
  });

  test('public evidence writer cannot mint workflow authority', () => {
    expect(() => writeProductionEvidence({
      context,
      seam: 'workflow',
      producerIdentity: 'caller',
      toolIdentity: 'caller',
      argv: ['oma', 'production', 'probe', 'workflow'],
      stdout: '',
      stderr: '',
      artifact: {},
    })).toThrow('product-owned probe authority');
  });

  test('review and UltraQA require distinct tool and reviewer identities', () => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { mode: 0o700 });
    writeTool(bin, 'agy', process.env.OMA_TEST_CAPTURE_MARKER ?? 'VERDICT: APPROVE');
    const captureContext = { ...context, environment: { PATH: bin, HOME: root } };
    captureProductionReview('review', ['agy', 'review'], captureContext);
    fs.writeFileSync(path.join(bin, 'agy'), toolScript('ULTRAQA: PASS'), { mode: 0o700 });
    captureProductionReview('ultraqa', ['agy', 'qa'], captureContext);
    expect(verifyAllProductionEvidence({
      stateRoot,
      runId: context.runId,
      oid: context.oid,
    }).seams.at(-1)).toMatchObject({ passed: false });
  });

  test('rejects owner-readable evidence with broader file mode', () => {
    const result = writePluginEvidence(context);
    fs.chmodSync(result.artifactPath, 0o644);
    expect(verifyProductionEvidence({
      stateRoot,
      runId: context.runId,
      oid: context.oid,
      seam: 'plugin-discovery',
    })).toBeNull();
  });

  test('run root helper does not create on read and rejects symlink components', () => {
    const absent = path.join(root, 'absent');
    expect(productionEvidenceRunRoot(absent, 'read-only', false))
      .toBe(path.join(absent, 'production-evidence', 'read-only'));
    expect(fs.existsSync(absent)).toBe(false);

    const unsafe = path.join(root, 'unsafe');
    fs.mkdirSync(unsafe, { mode: 0o700 });
    fs.symlinkSync(root, path.join(unsafe, 'production-evidence'));
    expect(() => productionEvidenceRunRoot(unsafe, 'run', true)).toThrow(/unsafe/u);
  });
});

function writePluginEvidence(context: ProductionProbeContext, doctorExitCode = 0) {
  return writeProductionEvidence({
    context,
    seam: 'plugin-discovery',
    producerIdentity: 'oma-product-probe',
    toolIdentity: 'oma@0.3.0',
    argv: ['oma', 'production', 'probe', 'plugin-discovery'],
    stdout: 'near miss\n',
    stderr: '',
    artifact: {
      ...pluginDiscoveryArtifact(context),
      doctor_exit_code: doctorExitCode,
    },
  });
}

function pluginDiscoveryArtifact(context: ProductionProbeContext): Record<string, unknown> {
  return {
    package_name: '@iml1s/oh-my-agy',
    plugin_name: 'oh-my-agy',
    doctor_exit_code: 0,
    plugin_check_status: 'pass',
    public_cli_status: 'public_cli_observed',
    public_cli_version: '1.1.6',
    installed: true,
    enabled: true,
    fresh_session_discovery: 'unobserved',
    discovery_evidence_tier: 'T0',
    discovery_detail_code: 'FRESH_SESSION_CANARY_MISMATCH',
    command_argv: [...DISCOVERY_PROOF_ARGV_V1],
    agy_realpath_sha256: '1'.repeat(64),
    agy_version_sha256: sha256Hex(Buffer.from('1.1.6', 'utf8')),
    candidate_oid: context.oid,
    package_digest: '2'.repeat(64),
    installed_digest: '2'.repeat(64),
    installed_realpath_sha256: '3'.repeat(64),
    installed_version: '1.1.6',
    registry_list_sha256: '4'.repeat(64),
    isolated_cwd_sha256: '5'.repeat(64),
    fresh_process_pid: 4242,
    process_exit_code: 0,
    process_signal: null,
    timed_out: false,
    output_overflow: false,
    canary_output_sha256: sha256Hex(Buffer.from('near miss\n', 'utf8')),
    canary_stderr_sha256: sha256Hex(Buffer.alloc(0)),
  };
}

function writeTool(bin: string, name: string, marker: string): void {
  fs.writeFileSync(path.join(bin, name), toolScript(marker), { mode: 0o700 });
}

function toolScript(marker: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "controlled-tool 1.0.0"
  exit 0
fi
echo "${marker}"
`;
}
