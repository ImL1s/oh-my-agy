import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface GitCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export class GitFixture {
  readonly root: string;
  readonly repo: string;
  readonly stateRoot: string;
  readonly managedWorktreesRoot: string;

  private constructor(root: string) {
    this.root = root;
    this.repo = path.join(root, 'leader');
    this.stateRoot = path.join(root, 'state');
    this.managedWorktreesRoot = path.join(root, 'managed-worktrees');
  }

  static create(): GitFixture {
    const fixture = new GitFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'oma-team-git-')));
    fs.mkdirSync(fixture.repo, { recursive: true });
    fixture.git(['init', '-b', 'main'], fixture.repo);
    fixture.git(['config', 'user.name', 'OMA Test'], fixture.repo);
    fixture.git(['config', 'user.email', 'oma-test@example.invalid'], fixture.repo);
    fs.writeFileSync(path.join(fixture.repo, 'README.md'), 'base\n', 'utf8');
    fixture.git(['add', 'README.md'], fixture.repo);
    fixture.git(['commit', '-m', 'initial'], fixture.repo);
    fs.mkdirSync(fixture.stateRoot, { recursive: true });
    fs.mkdirSync(fixture.managedWorktreesRoot, { recursive: true });
    return fixture;
  }

  git(args: readonly string[], cwd: string = this.repo, expectedExit = 0): GitCommandResult {
    const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
    const status = result.status ?? 1;
    if (status !== expectedExit) {
      throw new Error(`git ${args.join(' ')} exited ${status}: ${result.stderr}`);
    }
    return { status, stdout: result.stdout, stderr: result.stderr };
  }

  head(cwd: string = this.repo): string {
    return this.git(['rev-parse', 'HEAD'], cwd).stdout.trim();
  }

  symbolicHead(cwd: string = this.repo): string {
    return this.git(['symbolic-ref', '-q', 'HEAD'], cwd).stdout.trim();
  }

  commitFile(relativePath: string, content: string, message: string, cwd: string = this.repo): string {
    const target = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    this.git(['add', '--', relativePath], cwd);
    this.git(['commit', '-m', message], cwd);
    return this.head(cwd);
  }

  cleanup(): void {
    try {
      if (fs.existsSync(this.repo)) {
        const worktrees = this.git(['worktree', 'list', '--porcelain'], this.repo).stdout
          .split('\n')
          .filter((line) => line.startsWith('worktree '))
          .map((line) => line.slice('worktree '.length))
          .filter((entry) => entry !== this.repo && entry.startsWith(`${this.root}${path.sep}`));
        for (const worktree of worktrees) {
          spawnSync('git', ['worktree', 'remove', '--force', worktree], {
            cwd: this.repo,
            encoding: 'utf8',
          });
        }
      }
    } finally {
      fs.rmSync(this.root, { recursive: true, force: true });
    }
  }
}

