/**
 * 設計概念映射：Team supervisor 用 pane/process liveness 探測，對齊 reclaim fence 輸入。
 */
import { spawnSync } from 'child_process';
import { defaultProcessLiveness, ProcessLiveness } from '../runtime/lock';
import { ProcessMarkerV1 } from './types';

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

/** PID-reuse-safe：pid + startMarker（ps lstart）必須同時相符。 */
export function probeProcessMarker(marker: Readonly<ProcessMarkerV1>): ProcessLiveness {
  if (!Number.isSafeInteger(marker.pid) || marker.pid <= 0 || marker.startMarker.trim() === '') {
    return 'unknown';
  }
  return defaultProcessLiveness({
    schemaVersion: 1,
    ownerToken: 'team-probe',
    pid: marker.pid,
    pidStartMarker: marker.startMarker,
    createdAtMs: 0,
  });
}

export function probeTmuxSession(sessionName: string): ProcessLiveness {
  if (sessionName.trim() === '') return 'unknown';
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], { encoding: 'utf8', shell: false });
  if (result.status === 0) return 'alive';
  if (result.status === 1) return 'dead';
  return 'unknown';
}

/**
 * 舊心跳 `startMarker = tmux:<session>` 無法做 start-time 比對，只探 PID。
 * 新標記含 ps lstart，走 PID-reuse-safe probe。
 */
export function probeRecordedWorkerProcess(marker: Readonly<ProcessMarkerV1>): ProcessLiveness {
  if (marker.startMarker.startsWith('tmux:')) return probeProcessPid(marker.pid);
  return probeProcessMarker(marker);
}
