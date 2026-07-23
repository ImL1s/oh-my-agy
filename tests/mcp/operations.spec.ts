import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { recoverTranscript } from '../../src/continuation/recovery';
import {
  FROZEN_OMA_NORMATIVE_PLAN_HASHES_V1,
  FROZEN_OMA_OWNERSHIP_MANIFEST_HASH_V1,
  canonicalBytesV1,
  initializeRunManifest,
} from '../../src/contracts';
import {
  MCP_OPERATION_NAMES_V1,
  invokeMcpOperation,
  listMcpTools,
} from '../../src/mcp/operations';
import { handleMcpJsonRpc, startMcpNdjsonServer } from '../../src/mcp/server';
import { sha256 } from '../../src/runtime/atomic';
import { TeamStateStore } from '../../src/team/state';
import { CanonicalTeamManifestV1, WorkerAuthorityBindingV1 } from '../../src/team/types';

const sha = (character: string): string => character.repeat(64);

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

function createGitFixture(prefix: string) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(fixtureRoot, 'workspace');
  const remote = path.join(fixtureRoot, 'remote.git');
  fs.mkdirSync(root);
  git(fixtureRoot, 'init', '--bare', remote);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'OMA MCP Test');
  git(root, 'config', 'user.email', 'oma-mcp@example.invalid');
  fs.writeFileSync(path.join(root, '.gitignore'), '.agy/\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'frozen base', '--no-gpg-sign');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  return {
    fixtureRoot,
    root,
    baseCommit: git(root, 'rev-parse', 'HEAD^{commit}'),
    baseTree: git(root, 'rev-parse', 'HEAD^{tree}'),
  };
}

function context(root: string) {
  return { repositoryRoot: root, stateRoot: path.join(root, '.agy', 'state') };
}

describe('exact hermetic OMA MCP surface', () => {
  test('invalid JSON-RPC is isolated per line and a following ping still succeeds', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-mcp-invalid-'));
    const input = new PassThrough();
    const output = new PassThrough();
    let bytes = '';
    output.setEncoding('utf8');
    output.on('data', (chunk) => { bytes += chunk; });
    try {
      const invalid = await handleMcpJsonRpc({}, context(root));
      expect(invalid).toEqual({
        jsonrpc: '2.0', id: null,
        error: { code: -32600, message: 'Invalid JSON-RPC request' },
      });

      startMcpNdjsonServer(context(root), input, output);
      input.end([JSON.stringify({ jsonrpc: '2.0', id: 1 }), JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'ping',
      })].join('\n') + '\n');
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(bytes.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        { error: { code: -32600, message: 'Invalid JSON-RPC request' }, id: null, jsonrpc: '2.0' },
        { id: 2, jsonrpc: '2.0', result: {} },
      ]);
    } finally {
      input.destroy();
      output.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('registry and JSON-RPC tools/list expose exactly six non-LSP operations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-mcp-list-'));
    try {
      expect(MCP_OPERATION_NAMES_V1).toEqual([
        'run_status.read', 'recovery_manifest.read', 'wiki.search',
        'team_status.read', 'mailbox.list', 'proposal.create',
      ]);
      expect(listMcpTools().map((tool) => tool.name)).toEqual(MCP_OPERATION_NAMES_V1);
      expect(listMcpTools().some((tool) => /lsp|memory|ast/i.test(tool.name))).toBe(false);
      const response = await handleMcpJsonRpc(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        context(root),
      );
      expect((response?.result as any).tools.map((tool: any) => tool.name)).toEqual(MCP_OPERATION_NAMES_V1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('run_status.read verifies the authoritative bound run manifest', async () => {
    const fixture = createGitFixture('oma-mcp-run-');
    const { root } = fixture;
    try {
      let fill = 1;
      await initializeRunManifest({
        workspace_path: root,
        run_id: 'mcp-run',
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
      }, (size) => Buffer.alloc(size, fill++));
      const result = await invokeMcpOperation('run_status.read', { run_id: 'mcp-run' }, context(root)) as any;
      expect(result).toEqual(expect.objectContaining({
        run_id: 'mcp-run', revision: 0, state: 'initializing', writer_authority: 'oma_cli',
      }));
      expect(result.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally { fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true }); }
  });

  test('recovery_manifest.read verifies the immutable 0400 transcript copy', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-mcp-recovery-'));
    try {
      const source = path.join(root, 'source.jsonl');
      fs.writeFileSync(source, [
        { store_kind: 'transcript_record', schema_version: 1, type: 'turn', event_id: '1', parent_event_id: null, turn_id: 't', role: 'user', complete: true, payload: { text: 'hello' } },
        { store_kind: 'transcript_record', schema_version: 1, type: 'turn', event_id: '2', parent_event_id: '1', turn_id: 't', role: 'assistant', complete: true, payload: { text: 'world' } },
      ].map((record) => JSON.stringify(record)).join('\n') + '\n');
      const recovered = recoverTranscript({
        sourcePath: source, recoveryRoot: path.join(root, '.agy', 'recovery'),
      });
      const manifestPath = path.join(root, '.agy', 'recovery-manifests', 'latest.json');
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, canonicalBytesV1(recovered.manifest));
      const result = await invokeMcpOperation('recovery_manifest.read', {
        manifest_path: '.agy/recovery-manifests/latest.json',
      }, context(root)) as any;
      expect(result.immutable_copy_verified).toBe(true);
      expect(result.manifest.counters.complete_turns_retained).toBe(1);
      fs.chmodSync(recovered.immutableCopyPath, 0o600);
      await expect(invokeMcpOperation('recovery_manifest.read', {
        manifest_path: '.agy/recovery-manifests/latest.json',
      }, context(root))).rejects.toThrow('0400');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('wiki.search returns deterministic decision provenance', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-mcp-wiki-'));
    try {
      fs.mkdirSync(path.join(root, 'docs', 'decisions'), { recursive: true });
      fs.writeFileSync(path.join(root, 'docs', 'decisions', 'ADR-0002.md'), '# ADR-0002 Release\nRequire proof.');
      const result = await invokeMcpOperation('wiki.search', { query: 'release' }, context(root)) as any;
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual(expect.objectContaining({ kind: 'decision', decision_id: 'adr-0002' }));
      expect(result.results[0].provenance[0].source_path).toBe('docs/decisions/ADR-0002.md');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('team_status.read redacts claims while reporting authoritative task state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-mcp-team-'));
    try {
      const { store } = await createClaimedTeam(root);
      const result = await invokeMcpOperation('team_status.read', {
        team_id: 'team', repo_key: 'repo', workspace_key: 'workspace',
      }, context(root)) as any;
      expect(result.tasks[0]).toEqual(expect.objectContaining({ task_id: 'task', status: 'in_progress', generation: 1 }));
      expect(JSON.stringify(result)).not.toContain('claim-secret');
      expect(store.read().ok).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('mailbox.list is claim/generation/cursor fenced and returns digest metadata only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-mcp-mailbox-'));
    try {
      const { store, revision } = await createClaimedTeam(root);
      const sent = await store.sendOrderedMailbox(revision, 'task', 1, {
        schemaVersion: 1, id: 'm1', sender: 'leader', bodyDigest: sha256('body'), createdAtMs: 20,
      });
      expect(sent.ok).toBe(true);
      const result = await invokeMcpOperation('mailbox.list', {
        team_id: 'team', repo_key: 'repo', workspace_key: 'workspace', task_id: 'task',
        claim_token: 'claim-secret', generation: 1, after_cursor: 0,
      }, context(root)) as any;
      expect(result.messages).toEqual([expect.objectContaining({ id: 'm1', sequence: 1, body_digest: sha256('body') })]);
      await expect(invokeMcpOperation('mailbox.list', {
        team_id: 'team', repo_key: 'repo', workspace_key: 'workspace', task_id: 'task',
        claim_token: 'stale', generation: 1, after_cursor: 0,
      }, context(root))).rejects.toThrow('stale');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('proposal.create writes only an idempotent immutable proposal artifact', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-mcp-proposal-'));
    try {
      const args = { run_id: 'run', category: 'workflow-gap', title: 'Wire CLI', body: 'Add the W6 route.' };
      const first = await invokeMcpOperation('proposal.create', args, context(root)) as any;
      const second = await invokeMcpOperation('proposal.create', args, context(root)) as any;
      expect(second).toEqual(first);
      const target = path.join(root, first.proposal_path);
      expect(fs.statSync(target).mode & 0o777).toBe(0o400);
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(expect.objectContaining({ authority: 'proposal_only' }));
      expect(fs.existsSync(path.join(root, '.agy', 'state'))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

async function createClaimedTeam(root: string) {
  const stateRoot = path.join(root, '.agy', 'state');
  const manifest: CanonicalTeamManifestV1 = {
    schema: 'oma.team-manifest/v1', teamId: 'team', revision: 1, repoRoot: root,
    tasks: [{
      id: 'task', dependencies: [], mode: 'headless', write_scope: [{ kind: 'dir', path: 'src' }],
      verification: { version: 1, commands: [], requiredArtifacts: [] },
    }],
  };
  const store = new TeamStateStore(stateRoot, 'repo', 'workspace', 'team');
  const created = await store.create(manifest, 'owner');
  if (!created.ok) throw new Error(created.error.message);
  const claimed = await store.claimTask('task', 'worker', created.value.revision, 10, 100, 'claim-secret');
  if (!claimed.ok) throw new Error(claimed.error.message);
  const binding: WorkerAuthorityBindingV1 = {
    schemaVersion: 1, taskId: 'task', claimTokenDigest: sha256('claim-secret'), generation: 1,
    provider: 'agy_headless', providerReceiptHash: sha256('provider'),
    process: { pid: 123, startMarker: 'start' }, state: 'claimed', transitionSequence: 0, boundAtMs: 10,
  };
  const bound = await store.bindWorkerAuthority(claimed.value.revision, 'claim-secret', binding);
  if (!bound.ok) throw new Error(bound.error.message);
  return { store, revision: bound.value.revision };
}
