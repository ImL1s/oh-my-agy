import * as fs from 'fs';
import * as path from 'path';
import { MCP_OPERATION_NAMES_V1 } from '../../src/mcp/operations';
import { ANTIGRAVITY_WORKFLOW_SURFACES_V1 } from '../../src/workflows/antigravity-adapter';

const root = path.resolve(__dirname, '../..');

describe('OMA native component package surface', () => {
  test('compiled package roots carry MCP/wiki/workflows while skill packaging carries workflow UX', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.files).toEqual(expect.arrayContaining(['dist/src', 'skills']));
    expect(fs.existsSync(path.join(root, 'src', 'mcp', 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src', 'wiki', 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src', 'workflows', 'runner.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'skills', 'workflow', 'SKILL.md'))).toBe(true);
  });

  test('public MCP surface is exactly six and contains no semantic LSP or private-memory operation', () => {
    expect(MCP_OPERATION_NAMES_V1).toHaveLength(6);
    expect(MCP_OPERATION_NAMES_V1.some((name) => /lsp|memory|ast/i.test(name))).toBe(false);
  });

  test('generated saved prompt is source-only T1 until W6 package/CLI composition', () => {
    const prompt = fs.readFileSync(
      path.join(root, '.agents', 'workflows', 'production-safety-review.md'), 'utf8',
    );
    expect(prompt).toContain('oma workflow run production-safety-review');
    expect(prompt).not.toMatch(/spawn_subagent|capability_mode\s*[:=]/i);
    expect(ANTIGRAVITY_WORKFLOW_SURFACES_V1.find((entry) => entry.surface === 'native_workflow_runtime'))
      .toEqual(expect.objectContaining({ classification: 'optional_unclaimed', maximum_claimed_tier: 'T0' }));
  });
});
