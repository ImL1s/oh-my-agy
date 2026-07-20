import { spawnSync } from 'child_process';
import * as crypto from 'crypto';

export interface TmuxCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export class TmuxFixture {
  readonly prefix: string;
  private readonly sessions = new Set<string>();

  constructor() {
    this.prefix = `oma-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  }

  static available(): boolean {
    return spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
  }

  session(suffix: string): string {
    const name = `${this.prefix}-${suffix}`;
    this.sessions.add(name);
    return name;
  }

  run(args: readonly string[], expectedExit = 0): TmuxCommandResult {
    const result = spawnSync('tmux', [...args], { encoding: 'utf8' });
    const status = result.status ?? 1;
    if (status !== expectedExit) {
      throw new Error(`tmux ${args.join(' ')} exited ${status}: ${result.stderr}`);
    }
    return { status, stdout: result.stdout, stderr: result.stderr };
  }

  hasSession(name: string): boolean {
    return spawnSync('tmux', ['has-session', '-t', name], { encoding: 'utf8' }).status === 0;
  }

  cleanup(): void {
    for (const session of this.sessions) {
      if (this.hasSession(session)) {
        spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' });
      }
    }
  }

  assertClean(): void {
    const result = spawnSync('tmux', ['list-sessions', '-F', '#S'], { encoding: 'utf8' });
    if (result.status !== 0) return;
    const leaked = result.stdout.split('\n').filter((name) => name.startsWith(this.prefix));
    if (leaked.length > 0) throw new Error(`Leaked tmux sessions: ${leaked.join(', ')}`);
  }
}

