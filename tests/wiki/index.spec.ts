import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildWikiIndex,
  indexRepositoryWiki,
  searchWikiIndex,
} from '../../src/wiki';

describe('deterministic wiki, decision, and provenance index', () => {
  test('input order and CRLF do not change canonical records or digest', () => {
    const first = buildWikiIndex([
      { path: 'docs/guide.md', content: '# Guide\r\nDeploy safely.\r\n' },
      { path: 'docs/decisions/ADR-0001.md', content: '# ADR-0001 Safety\nUse receipts.\n' },
    ]);
    const second = buildWikiIndex([
      { path: 'docs/decisions/ADR-0001.md', content: '# ADR-0001 Safety\nUse receipts.\n' },
      { path: 'docs/guide.md', content: '# Guide\nDeploy safely.\n' },
    ]);
    expect(second).toEqual(first);
    expect(first.records.map((record) => record.path)).toEqual([
      'docs/decisions/ADR-0001.md', 'docs/guide.md',
    ]);
    expect(first.records[0]).toEqual(expect.objectContaining({
      kind: 'decision', decision_id: 'adr-0001', title: 'ADR-0001 Safety',
    }));
    expect(first.records[0].provenance).toEqual([{
      source_path: first.records[0].path,
      source_sha256: first.records[0].content_sha256,
    }]);
  });

  test('search ranking, result bounds, snippets, and provenance are stable', () => {
    const index = buildWikiIndex([
      { path: 'docs/b.md', content: '# Deploy Notes\nDeploy with a receipt.' },
      { path: 'docs/a.md', content: '# General\nA deploy checklist.' },
    ]);
    const response = searchWikiIndex(index, 'deploy', 2);
    expect(response.index_digest).toBe(index.index_digest);
    expect(response.results.map((result) => result.path)).toEqual(['docs/b.md', 'docs/a.md']);
    expect(response.results[0].snippet).toContain('Deploy');
    expect(response.results[0].provenance[0].source_path).toBe('docs/b.md');
    expect(() => searchWikiIndex(index, 'deploy', 51)).toThrow('limit');
  });

  test('repository scan ignores symlinks and rejects traversal roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-wiki-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-wiki-outside-'));
    try {
      fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'docs', 'page.md'), '# Page\nInside');
      fs.writeFileSync(path.join(outside, 'secret.md'), '# Secret\nOutside');
      fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'docs', 'secret.md'));
      const index = indexRepositoryWiki({ repositoryRoot: root });
      expect(index.records.map((record) => record.path)).toEqual(['docs/page.md']);
      expect(() => indexRepositoryWiki({ repositoryRoot: root, roots: ['../outside'] }))
        .toThrow('escapes');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
