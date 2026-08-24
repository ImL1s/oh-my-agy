import { spawnSync } from 'child_process';
import { canonicalJsonV1 } from '../src/contracts';

export const FROZEN_OMA_BASE_V1 = 'f8eeaae6f42ebbfc1c22be504277377332c0d8fe';

export const OWNERSHIP_ORACLE_ARGV_V1 = Object.freeze({
  cached: ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--find-renames=50%', '$BASE', '--'],
  worktree: ['diff', '--raw', '-z', '--no-abbrev', '--find-renames=50%', '--'],
  untracked: ['ls-files', '--others', '--exclude-standard', '-z'],
  cached_ignored: ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'],
  submodules: ['submodule', 'status', '--recursive'],
  submodule_status: ['-C', '$SUBMODULE', 'status', '--porcelain=v2', '-z', '--untracked-files=all'],
  final_tree: ['diff-tree', '-r', '--raw', '-z', '--no-abbrev', '--find-renames=50%', '$BASE^{tree}', '$CANDIDATE^{tree}', '--'],
  residual: ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
  parents: ['rev-list', '--parents', '-n', '1', '$CANDIDATE'],
  remote: ['ls-remote', '--exit-code', '$REMOTE', 'refs/heads/$APPROVED_BRANCH'],
});

export type OmaTrackedWave =
  | 'OMA-W0'
  | 'OMA-W1'
  | 'OMA-W2'
  | 'OMA-W3'
  | 'OMA-W4'
  | 'OMA-W5'
  | 'OMA-W6';

interface OwnershipRule {
  wave: OmaTrackedWave;
  owner: string;
  patterns: RegExp[];
}

const exact = (values: readonly string[]): RegExp => new RegExp(
  `^(?:${values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
);

export const OMA_OWNERSHIP_RULES_V1: readonly OwnershipRule[] = [
  {
    wave: 'OMA-W0',
    owner: 'oma-contract-owner',
    patterns: [
      exact([
        'src/contracts/index.ts', 'src/contracts/lifecycle.ts', 'src/contracts/path-key.ts',
        'src/contracts/state-schemas.ts', 'src/contracts/capability.ts', 'src/contracts/carrier.ts',
        'src/contracts/resume.ts', 'src/contracts/worker-envelope.ts', 'src/contracts/writer-chain.ts',
        'src/contracts/run-manifest.ts', 'src/contracts/release-transaction.ts',
        'src/contracts/repository-workflow.ts', 'docs/parity/oma-parity.json',
        'docs/parity/oma-traceability.json', 'scripts/check-parity.ts',
        'scripts/check-traceability.ts', 'scripts/check-writer-ownership.ts',
        'tests/contracts/parity.spec.ts', 'tests/contracts/traceability.spec.ts',
        'tests/contracts/path-key.spec.ts', 'tests/contracts/state-schemas.spec.ts',
        'tests/contracts/writer-ownership.spec.ts', 'tests/contracts/writer-chain.spec.ts',
        'tests/contracts/run-manifest.spec.ts', 'tests/contracts/release-transaction.spec.ts',
        'tests/contracts/carrier.spec.ts', 'tests/contracts/repository-workflow.spec.ts',
      ]),
      /^tests\/fixtures\/(?:carrier|recovery|capabilities|release|workflow)\/.+$/,
    ],
  },
  {
    wave: 'OMA-W1', owner: 'oma-install-owner', patterns: [
      /^src\/setup\/(?:plugin|doctor|doctor-fix|transaction|host-install|installed-identity|update|uninstall|receipt|dry-run)\.ts$/,
      /^scripts\/(?:install|smoke)\.sh$/, /^scripts\/(?:smoke-full-product|release-attest)\.ts$/,
      /^tests\/setup\/(?:doctor|doctor-next-action|host-install|plugin-preflight|setup-transaction|installed-identity|update|uninstall|release-install|dry-run|mcp-registration)\.spec\.ts$/,
      exact(['tests/package/plugin-surface.spec.ts']),
    ],
  },
  {
    wave: 'OMA-W2', owner: 'oma-state-owner', patterns: [
      /^src\/runtime\/(?:atomic|errors|error-catalog|lock|process|sandbox|state-root|state-store|types|tracker|capability-discovery|redaction|compaction)\.ts$/,
      /^src\/continuation\/(?:decision|event-identity|progress-oracle|session-aggregate|state|resume|recovery)\.ts$/,
      /^src\/hooks\/(?:common|debug-log|pre-invocation|stop|workspace|session-start|post-invocation)\.ts$/,
      /^tests\/(?:runtime|hooks|continuation)\/.+$/,
    ],
  },
  {
    wave: 'OMA-W3', owner: 'oma-team-owner', patterns: [
      /^src\/team\/.+$/, /^tests\/team\/.+$/,
      /^tests\/helpers\/(?:git-fixture|process-fixture|state-fixture|tmux-fixture)\.ts$/,
    ],
  },
  {
    wave: 'OMA-W4', owner: 'oma-native-surface-owner', patterns: [
      /^src\/(?:mcp|wiki)\/.+$/,
      /^src\/workflows\/(?:schema|registry|planner|runner|replay|permissions|review|authority|antigravity-adapter)\.ts$/,
      /^src\/modes\/(?:commands|directives|skill-loader|skill-protocol|skill-catalog|skill-frontmatter)\.ts$/,
      /^skills\/[^/]+\/SKILL\.md$/, /^agents\/.+$/, /^commands\/.+$/, /^\.agents\/workflows\/.+$/,
      /^tests\/(?:mcp|wiki|workflows)\/.+$/,
      exact([
        'tests/modes/skill-surface.spec.ts', 'tests/modes/skill-frontmatter.spec.ts',
        'tests/package/native-components.spec.ts',
        'scripts/generate-skill-catalog.ts', 'skills/AGENTS.md',
        'tests/package/skill-catalog.spec.ts',
      ]),
    ],
  },
  {
    wave: 'OMA-W5', owner: 'oma-adapter-owner', patterns: [
      /^src\/(?:hud|notify)\/.+$/,
      /^src\/native\/(?:antigravity-status|sidecar-status|lsp-status)\.ts$/,
      /^tests\/(?:hud|notify|native)\/.+$/,
      /^e2e\/(?:tier1|tier2|tier3|tier4|structured-cli)\.spec\.ts$/,
      exact(['e2e/helper.ts', 'e2e/mocks/agy']),
    ],
  },
  {
    wave: 'OMA-W6', owner: 'oma-final-composition-owner', patterns: [
      exact([
        'bin/oma.ts', 'src/cli/application.ts', 'src/cli/dangerous-launch.ts',
        'src/cli/host-launch.ts', 'src/cli/managed-invocation.ts', 'src/cli/parser.ts',
        'src/cli/runtime-adapter.ts', 'src/cli/cancel-command.ts', 'src/cli/explain-command.ts',
        'src/cli/ask-command.ts',
        'src/cli/services.ts', 'src/cli/skill-commands.ts', 'src/cli/session-commands.ts',
        'src/cli/hooks-commands.ts', 'src/autopilot/commands.ts',
        'src/autopilot/phases.ts', 'src/autopilot/runtime.ts', 'src/enforcer.ts', 'src/types.ts',
        'package.json', 'package-lock.json', 'plugin.json', 'hooks.json', '.agents/hooks.json',
        '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json',
        '.claude-plugin/.mcp.json', '.mcp.json',
        'rules/runtime.md', '.github/workflows/ci.yml', '.github/workflows/release.yml',
        'README.md', 'CHANGELOG.md', 'CLAUDE.md', 'DESIGN.md', 'PROJECT.md', 'TEST_INFRA.md',
        'TEST_READY.md', 'docs/npm-publishing.md', 'docs/RELEASE.md', 'docs/capabilities.md',
        'docs/security.md', 'docs/workflows.md', 'docs/error-codes.md', 'jest.config.js', 'jest.unit.config.js',
        'tsconfig.json', 'tests/package/release-readback.spec.ts',
      ]),
      /^tests\/(?:cli|autopilot)\/.+$/,
      /^src\/ask\/.+$/,
      /^src\/production\/.+$/,
      /^tests\/production\/.+$/,
    ],
  },
];

export interface OwnershipMatch {
  wave: OmaTrackedWave;
  owner: string;
}

export interface RawDiffRecordV1 {
  old_mode: string;
  new_mode: string;
  old_oid: string;
  new_oid: string;
  status: string;
  source_path: string;
  destination_path: string | null;
}

export interface FinalTreeEvidenceV1 {
  deltaRecords: RawDiffRecordV1[];
  deltaPaths: string[];
  residual: Buffer;
  parents: string;
  remote: string;
}

export function ownershipForPath(repositoryPath: string): OwnershipMatch {
  // 根目錄與各模組 AGENTS.md 仍為不可變貢獻者指引。
  // #36 明確授權 skills/AGENTS.md 作為 skill catalog 索引（OMX generate-catalog-docs）。
  if (repositoryPath.split('/').includes('AGENTS.md') && repositoryPath !== 'skills/AGENTS.md') {
    throw new Error(`Immutable contributor guidance changed: ${repositoryPath}`);
  }
  const matches = OMA_OWNERSHIP_RULES_V1.filter((rule) =>
    rule.patterns.some((pattern) => pattern.test(repositoryPath)));
  if (matches.length !== 1) {
    throw new Error(`${repositoryPath} maps to ${matches.length} ownership rows`);
  }
  return { wave: matches[0].wave, owner: matches[0].owner };
}

export function validateChangedPathOwnership(
  paths: readonly string[],
  expectedWave?: OmaTrackedWave,
): Record<OmaTrackedWave, string[]> {
  const result = {} as Record<OmaTrackedWave, string[]>;
  for (const rule of OMA_OWNERSHIP_RULES_V1) {
    result[rule.wave] = [];
  }
  for (const repositoryPath of [...new Set(paths)].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
    const owner = ownershipForPath(repositoryPath);
    if (expectedWave !== undefined && owner.wave !== expectedWave) {
      throw new Error(`${repositoryPath} belongs to ${owner.wave}, not ${expectedWave}`);
    }
    result[owner.wave].push(repositoryPath);
  }
  return result;
}

function runGit(args: readonly string[], encoding: BufferEncoding | 'buffer' = 'buffer'): Buffer | string {
  const result = spawnSync('git', args, {
    encoding: encoding === 'buffer' ? null : encoding,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout as Buffer | string;
}

function assertRawDiffPath(repositoryPath: string): void {
  if (repositoryPath === '' || repositoryPath.includes('\\')
    || repositoryPath.startsWith('/') || repositoryPath.split('/').includes('..')) {
    throw new Error('Malformed or unsafe raw-diff path');
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function validateRawDiffRecords(records: readonly RawDiffRecordV1[]): void {
  const seenPaths = new Set<string>();
  for (const record of records) {
    if (!/^[0-7]{6}$/.test(record.old_mode) || !/^[0-7]{6}$/.test(record.new_mode)
      || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(record.old_oid)
      || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(record.new_oid)
      || !/^(?:[ADMTUXB]|[RC](?:100|[1-9]?\d))$/.test(record.status)) {
      throw new Error('Malformed mode/OID/status raw-diff record');
    }
    const renameOrCopy = /^[RC]/.test(record.status);
    if (renameOrCopy !== (record.destination_path !== null)) {
      throw new Error('Malformed rename/copy raw-diff destination');
    }
    assertRawDiffPath(record.source_path);
    if (record.destination_path !== null) {
      assertRawDiffPath(record.destination_path);
      if (record.destination_path === record.source_path) {
        throw new Error('Malformed rename/copy with identical paths');
      }
    }
    for (const repositoryPath of [record.source_path, record.destination_path].filter(
      (value): value is string => value !== null,
    )) {
      if (seenPaths.has(repositoryPath)) throw new Error('Duplicate or ambiguous raw-diff path');
      seenPaths.add(repositoryPath);
    }
  }
}

export function parseRawDiffRecordsZ(bytes: Buffer): RawDiffRecordV1[] {
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) {
    throw new Error('Malformed non-UTF-8 git --raw -z output');
  }
  const tokens = decoded.split('\0');
  if (tokens.at(-1) !== '') throw new Error('Malformed unterminated git --raw -z output');
  const records: RawDiffRecordV1[] = [];
  let index = 0;
  while (index < tokens.length && tokens[index] !== '') {
    const header = tokens[index];
    index += 1;
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([ACDMRTUXB])(\d{1,3})?$/.exec(header);
    if (match === null || index >= tokens.length) {
      throw new Error('Malformed git --raw -z output');
    }
    const [, oldMode, newMode, oldOid, newOid, statusCode, score] = match;
    if ((statusCode === 'R' || statusCode === 'C') !== (score !== undefined)
      || (score !== undefined && Number(score) > 100)) {
      throw new Error('Malformed rename/copy raw-diff status');
    }
    const firstPath = tokens[index];
    index += 1;
    assertRawDiffPath(firstPath);
    if (statusCode === 'R' || statusCode === 'C') {
      const secondPath = tokens[index];
      index += 1;
      assertRawDiffPath(secondPath);
      if (secondPath === firstPath) throw new Error('Malformed rename/copy with identical paths');
      records.push({
        old_mode: oldMode,
        new_mode: newMode,
        old_oid: oldOid,
        new_oid: newOid,
        status: `${statusCode}${score}`,
        source_path: firstPath,
        destination_path: secondPath,
      });
    } else {
      records.push({
        old_mode: oldMode,
        new_mode: newMode,
        old_oid: oldOid,
        new_oid: newOid,
        status: statusCode,
        source_path: firstPath,
        destination_path: null,
      });
    }
  }
  if (index !== tokens.length - 1) throw new Error('Malformed trailing git --raw -z tokens');
  validateRawDiffRecords(records);
  return records.sort((left, right) => compareUtf8(left.source_path, right.source_path)
    || compareUtf8(left.status, right.status)
    || compareUtf8(left.destination_path ?? '', right.destination_path ?? ''));
}

export function parseRawDiffZ(bytes: Buffer): string[] {
  return parseRawDiffRecordsZ(bytes).flatMap((record) => [
    record.source_path,
    ...(record.destination_path === null ? [] : [record.destination_path]),
  ]);
}

function parseNulPaths(bytes: Buffer): string[] {
  return bytes.toString('utf8').split('\0').filter((value) => value !== '');
}

export function collectInclusiveDirtyPaths(base = FROZEN_OMA_BASE_V1): string[] {
  const paths = new Set<string>();
  for (const repositoryPath of parseRawDiffZ(runGit([
    'diff', '--cached', '--raw', '-z', '--no-abbrev', '--find-renames=50%', base, '--',
  ]) as Buffer)) paths.add(repositoryPath);
  for (const repositoryPath of parseRawDiffZ(runGit([
    'diff', '--raw', '-z', '--no-abbrev', '--find-renames=50%', '--',
  ]) as Buffer)) paths.add(repositoryPath);
  for (const repositoryPath of parseNulPaths(runGit([
    'ls-files', '--others', '--exclude-standard', '-z',
  ]) as Buffer)) paths.add(repositoryPath);

  const cachedIgnored = parseNulPaths(runGit([
    'ls-files', '--cached', '--ignored', '--exclude-standard', '-z',
  ]) as Buffer);
  for (const repositoryPath of cachedIgnored) {
    const existsAtBase = spawnSync('git', ['cat-file', '-e', `${base}:${repositoryPath}`], { encoding: 'utf8' });
    if (existsAtBase.status !== 0) paths.add(repositoryPath);
  }

  const submoduleOutput = runGit(['submodule', 'status', '--recursive'], 'utf8') as string;
  for (const line of submoduleOutput.split('\n').filter((value) => value.trim() !== '')) {
    const match = /^([ +\-U])([0-9a-f]+)\s+([^\s]+)(?:\s|$)/.exec(line);
    if (match === null) throw new Error('Malformed git submodule status output');
    const submodulePath = match[3];
    const dirty = runGit([
      '-C', submodulePath, 'status', '--porcelain=v2', '-z', '--untracked-files=all',
    ]) as Buffer;
    if (match[1] !== ' ' || dirty.length > 0) paths.add(submodulePath);
  }
  return [...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export function collectFinalTreeEvidence(input: {
  base: string;
  candidate: string;
  remote: string;
  approvedBranch: string;
  approvedRemoteOldOid?: string;
}): FinalTreeEvidenceV1 {
  validateFinalTreeInput(input);
  const deltaRecords = parseRawDiffRecordsZ(runGit([
    'diff-tree', '-r', '--raw', '-z', '--no-abbrev', '--find-renames=50%',
    `${input.base}^{tree}`, `${input.candidate}^{tree}`, '--',
  ]) as Buffer);
  const residual = runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all']) as Buffer;
  const parents = runGit(['rev-list', '--parents', '-n', '1', input.candidate], 'utf8') as string;
  const remote = runGit([
    'ls-remote', '--exit-code', input.remote, `refs/heads/${input.approvedBranch}`,
  ], 'utf8') as string;
  const evidence: FinalTreeEvidenceV1 = {
    deltaRecords,
    deltaPaths: deltaRecords.flatMap((record) => [
      record.source_path,
      ...(record.destination_path === null ? [] : [record.destination_path]),
    ]),
    residual,
    parents: parents.trim(),
    remote: remote.trim(),
  };
  validateFinalTreeEvidence(input, evidence);
  return evidence;
}

function validateFinalTreeInput(input: {
  base: string;
  candidate: string;
  remote: string;
  approvedBranch: string;
  approvedRemoteOldOid?: string;
}): asserts input is typeof input & { approvedRemoteOldOid: string } {
  const oid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
  if (!oid.test(input.base) || !oid.test(input.candidate)
    || input.approvedRemoteOldOid === undefined || !oid.test(input.approvedRemoteOldOid)) {
    throw new Error('Final-tree proof requires full valid base, candidate, and approved remote old OIDs');
  }
  if (input.base === input.candidate) throw new Error('Final-tree candidate must differ from frozen base');
  if (input.remote.trim() === '' || input.approvedBranch.trim() === ''
    || input.approvedBranch.includes('..') || input.approvedBranch.startsWith('-')) {
    throw new Error('Final-tree remote/branch identity is invalid');
  }
}

export function validateFinalTreeEvidence(
  input: {
    base: string;
    candidate: string;
    remote: string;
    approvedBranch: string;
    approvedRemoteOldOid?: string;
  },
  evidence: FinalTreeEvidenceV1,
): void {
  validateFinalTreeInput(input);
  if (evidence.residual.length !== 0) throw new Error('Final-tree residual workspace is not clean');
  if (evidence.deltaRecords.length === 0) throw new Error('Final-tree candidate has no frozen-base delta');
  validateRawDiffRecords(evidence.deltaRecords);
  const flattened = evidence.deltaRecords.flatMap((record) => [
    record.source_path,
    ...(record.destination_path === null ? [] : [record.destination_path]),
  ]);
  if (JSON.stringify(evidence.deltaPaths) !== JSON.stringify(flattened)) {
    throw new Error('Final-tree paths do not match mode/OID-preserving raw records');
  }
  validateChangedPathOwnership(flattened);
  const parentTokens = evidence.parents.split(/\s+/);
  if (parentTokens.length !== 2 || parentTokens[0] !== input.candidate || parentTokens[1] !== input.base) {
    throw new Error('Final-tree candidate must have exactly one frozen-base parent');
  }
  const expectedRemote = `${input.approvedRemoteOldOid}\trefs/heads/${input.approvedBranch}`;
  if (evidence.remote !== expectedRemote || evidence.remote.includes('\n')) {
    throw new Error('Approved remote old OID readback drifted or is ambiguous');
  }
}

if (require.main === module) {
  try {
    const paths = collectInclusiveDirtyPaths();
    const expected = process.env.OMA_EXPECTED_WAVE as OmaTrackedWave | undefined;
    const grouped = validateChangedPathOwnership(paths, expected);
    process.stdout.write(`${canonicalJsonV1({
      ok: true,
      changed_path_count: paths.length,
      changed_paths: paths,
      owners: grouped,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
