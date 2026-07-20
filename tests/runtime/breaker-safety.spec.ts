import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { checkContinuation } from '../../src/enforcer';
import { createStateFixture } from '../helpers/state-fixture';

function git(cwd: string, argv: string[]): string {
  const result = spawnSync('git', argv, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${argv.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe('non-destructive circuit breaker regression', () => {
  test('tripping preserves tracked edits and untracked files byte-for-byte', async () => {
    const fixture = createStateFixture('oma-breaker-');
    const repo = fixture.path('repo');
    fs.mkdirSync(repo);

    try {
      git(repo, ['init', '-q']);
      git(repo, ['config', 'user.name', 'OMA Test']);
      git(repo, ['config', 'user.email', 'oma@example.invalid']);
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'committed\n');
      git(repo, ['add', 'tracked.txt']);
      git(repo, ['commit', '-qm', 'fixture']);
      const head = git(repo, ['rev-parse', 'HEAD']);

      const trackedBytes = Buffer.from('user edit\n');
      const untrackedBytes = Buffer.from('do not delete\n');
      fs.writeFileSync(path.join(repo, 'tracked.txt'), trackedBytes);
      fs.writeFileSync(path.join(repo, 'untracked.txt'), untrackedBytes);
      const todoPath = path.join(repo, '.agy', 'todo.json');
      fs.mkdirSync(path.dirname(todoPath), { recursive: true });
      fs.writeFileSync(todoPath, JSON.stringify({
        status: 'idle',
        remainingRetries: 1,
        stableCommit: head,
        tasks: [{ id: 'unfinished', completed: false }],
      }));

      const exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code ?? 0})`);
      }) as never);
      await expect(checkContinuation(todoPath, 0, true)).rejects.toThrow('process.exit(1)');
      exit.mockRestore();

      expect(fs.readFileSync(path.join(repo, 'tracked.txt'))).toEqual(trackedBytes);
      expect(fs.readFileSync(path.join(repo, 'untracked.txt'))).toEqual(untrackedBytes);
      expect(JSON.parse(fs.readFileSync(todoPath, 'utf8'))).toEqual(expect.objectContaining({
        status: 'tripped',
        remainingRetries: 0,
      }));
    } finally {
      fixture.cleanup();
    }
  });
});
