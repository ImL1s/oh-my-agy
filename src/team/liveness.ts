/**
 * 設計概念映射：Team supervisor 用 pane/process liveness 探測，對齊 reclaim fence 輸入。
 */
import { spawnSync } from 'child_process';
import { ProcessLiveness } from '../runtime/lock';

export function probeProcessPid(pid: number): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

export function probeTmuxSession(sessionName: string): ProcessLiveness {
  if (sessionName.trim() === '') return 'unknown';
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], { encoding: 'utf8' });
  if (result.status === 0) return 'alive';
  if (result.status === 1) return 'dead';
  return 'unknown';
}
