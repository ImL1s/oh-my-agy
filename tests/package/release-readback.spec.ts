import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = path.resolve(__dirname, '../..');

describe('0.3.0 release readback', () => {
  test('all public manifests and the workflow skill inventory agree', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const plugin = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
    const slash = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(pkg.version).toBe('0.3.0');
    expect(plugin.version).toBe(pkg.version);
    expect(slash.version).toBe(pkg.version);
    expect(pkg.exports).toEqual({
      '.': './dist/bin/oma.js',
      './package.json': './package.json',
    });
    expect(slash.skills).toContain('./skills/discovery-proof/');
    expect(slash.skills).toContain('./skills/workflow/');
    expect(pkg.files).toEqual(expect.arrayContaining([
      '.mcp.json',
      '.agents/workflows',
      'scripts/install.sh',
      'tests/fixtures/workflow',
      'docs/RELEASE.md',
      'docs/capabilities.md',
      'docs/security.md',
      'docs/workflows.md',
      'docs/npm-publishing.md',
      'dist/scripts/check-writer-ownership.js',
    ]));
  });

  test('packed consumers cannot import internal workflow authority or evidence modules', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-packed-consumer-'));
    try {
      const packed = spawnSync(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect(packed.status).toBe(0);
      const report = JSON.parse(packed.stdout) as Array<{ filename: string }>;
      const tarball = path.join(temporary, report[0].filename);
      fs.writeFileSync(
        path.join(temporary, 'package.json'),
        JSON.stringify({ name: 'oma-consumer-test', private: true }),
      );
      const installed = spawnSync(
        'npm',
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
        {
          cwd: temporary,
          encoding: 'utf8',
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect(installed.status).toBe(0);
      const consumer = spawnSync(process.execPath, ['-e', `
        const path = require('path');
        for (const moduleName of [
          '@iml1s/oh-my-agy/dist/src/workflows/runner',
          '@iml1s/oh-my-agy/dist/src/production/evidence',
        ]) {
          try {
            require.resolve(moduleName);
            process.exit(10);
          } catch (error) {
            if (!error || error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') process.exit(11);
          }
        }
        const packageRoot = path.dirname(require.resolve('@iml1s/oh-my-agy/package.json'));
        const workflowRoot = path.join(packageRoot, 'dist/src/workflows');
        const exportAllowlists = {
          'antigravity-adapter.js': [
            'ANTIGRAVITY_WORKFLOW_SURFACES_V1',
            'assertAntigravitySavedWorkflowIsThin',
            'renderAntigravitySavedWorkflow',
          ],
          'authority.js': [
            'assertRepositoryExternalAuthorityRoot',
            'validateWorkflowProductAuthority',
            'workflowAuthorityDigest',
            'workflowVerdictOutputSchema',
          ],
          'permissions.js': [
            'assertWorkflowEnvelopeMatchesStage',
            'compileWorkflowPermissions',
            'workflowPermissionDigest',
          ],
          'planner.js': ['planRepositoryWorkflow', 'readyWorkflowTasks'],
          'registry.js': ['RepositoryWorkflowRegistryV1', 'loadWorkflowRegistryFromDirectory'],
          'replay.js': [
            'MAX_WORKFLOW_JOURNAL_EVENTS_V1',
            'MAX_WORKFLOW_JOURNAL_LINE_BYTES_V1',
            'appendWorkflowJournalEvent',
            'initializeWorkflowRun',
            'readWorkflowJournal',
            'replayWorkflowEvents',
          ],
          'review.js': ['evaluateWorkflowReview'],
          'runner.js': [
            'WORKFLOW_PRODUCT_AUTHORITY_ERROR',
            'executeRepositoryWorkflow',
            'freshWorkflowRun',
          ],
          'schema.js': [
            'WORKFLOW_JOURNAL_SCHEMA_V1',
            'WORKFLOW_RUN_SCHEMA_V1',
            'createWorkflowJournalEvent',
            'dependencyResultsFromReceipts',
            'workflowEnvelopeDigest',
            'workflowJournalEventHash',
            'workflowPlanDigest',
          ],
        };
        const emitted = require('fs').readdirSync(workflowRoot)
          .filter((entry) => entry.endsWith('.js')).sort();
        if (JSON.stringify(emitted) !== JSON.stringify(Object.keys(exportAllowlists).sort())) {
          process.exit(12);
        }
        for (const [filename, allowed] of Object.entries(exportAllowlists)) {
          const actual = Object.keys(require(path.join(workflowRoot, filename))).sort();
          if (JSON.stringify(actual) !== JSON.stringify([...allowed].sort())) process.exit(13);
        }
        const evidence = require(path.join(packageRoot, 'dist/src/production/evidence.js'));
        const evidenceAllowlist = [
          'captureProductionReview',
          'prepareWorkflowProductionProbeFromCli',
          'productionCandidateOid',
          'productionEvidenceRunRoot',
          'recordPreparedWorkflowProductionProbe',
          'resolveProductionRunId',
          'resolveProductionStateRoot',
          'runCoreProductionProbe',
          'verifyAllProductionEvidence',
          'verifyProductionEvidence',
          'writeProductionEvidence',
        ];
        if (JSON.stringify(Object.keys(evidence).sort())
          !== JSON.stringify(evidenceAllowlist.sort())) process.exit(14);
        if ('runWorkflowProductionProbeFromCli' in evidence) process.exit(15);
      `], {
        cwd: temporary,
        encoding: 'utf8',
        timeout: 10_000,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(consumer.status).toBe(0);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  test('packed readback contains install, MCP, workflow, prompt, and all plugin skills', () => {
    const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(packed.status).toBe(0);
    const report = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
    const files = report[0].files.map((entry) => entry.path);
    for (const required of [
      '.mcp.json',
      '.agents/workflows/production-safety-review.md',
      'scripts/install.sh',
      'skills/discovery-proof/SKILL.md',
      'skills/workflow/SKILL.md',
      'tests/fixtures/workflow/production-safety-review-v1.json',
      'docs/RELEASE.md',
      'docs/capabilities.md',
      'docs/security.md',
      'docs/workflows.md',
      'docs/npm-publishing.md',
      'dist/bin/oma.js',
      'dist/scripts/check-writer-ownership.js',
      'dist/src/mcp/server.js',
      'dist/src/workflows/runner.js',
    ]) expect(files).toContain(required);
    const slash = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    for (const skill of slash.skills as string[]) {
      expect(files).toContain(`${skill.replace(/^\.\//u, '')}SKILL.md`);
    }
  });

  test('release workflow is read-only verification and contains no publisher', () => {
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('packages: read');
    expect(workflow).not.toMatch(/(?:contents|packages|id-token):\s*write/u);
    expect(workflow).not.toMatch(/npm\s+publish|action-gh-release|gh\s+release|dist-tag/u);
  });
});
