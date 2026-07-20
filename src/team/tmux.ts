import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { TmuxPaneIdentityV1 } from './types';

export interface StartTmuxWorkerInput {
  sessionName: string;
  cwd: string;
  executablePath: string;
  descriptorPath: string;
  bootstrapArgv?: readonly string[];
  ownerNonce: string;
  workerNonce: string;
}

export class TmuxController {
  startWorker(input: Readonly<StartTmuxWorkerInput>): Result<TmuxPaneIdentityV1> {
    if (!validSessionName(input.sessionName) || !validNonce(input.ownerNonce) || !validNonce(input.workerNonce)) {
      return err(runtimeError('E_CORRUPT_STATE', 'Invalid tmux worker identity'));
    }
    const cwd = safeRealpath(input.cwd);
    const executable = safeRealpath(input.executablePath);
    const descriptor = safeRealpath(input.descriptorPath);
    if (cwd === null || executable === null || descriptor === null || !fs.statSync(descriptor).isFile()) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Tmux bootstrap paths must exist and resolve canonically'));
    }
    const bootstrap = input.bootstrapArgv ?? [];
    if (bootstrap.some((entry) => typeof entry !== 'string' || entry.includes('\0') || entry.includes('\n'))) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Tmux bootstrap arguments are invalid'));
    }
    if (this.hasSession(input.sessionName)) {
      return err(runtimeError('E_TMUX_OWNER_MISMATCH', 'Tmux session already exists and is not reusable without owner readback', {
        sessionName: input.sessionName,
      }));
    }
    const shellCommand = [executable, ...bootstrap, descriptor].map(shellQuote).join(' ');
    const created = tmux(['new-session', '-d', '-s', input.sessionName, '-c', cwd, shellCommand]);
    if (!created.ok) return created;
    const pane = tmux(['display-message', '-p', '-t', `${input.sessionName}:0.0`, '#{pane_id}']);
    if (!pane.ok || pane.value.stdout.trim() === '') {
      this.killUnconditionally(input.sessionName);
      return err(runtimeError('E_RETRYABLE_BLOCKER', 'Unable to resolve the tmux worker pane'));
    }
    const paneId = pane.value.stdout.trim();
    const ownerSet = tmux(['set-option', '-t', input.sessionName, '@oma_owner_nonce', input.ownerNonce]);
    const workerSet = tmux(['set-option', '-p', '-t', paneId, '@oma_worker_nonce', input.workerNonce]);
    if (!ownerSet.ok || !workerSet.ok) {
      this.killUnconditionally(input.sessionName);
      return err(runtimeError('E_RETRYABLE_BLOCKER', 'Unable to persist tmux owner options'));
    }
    return ok({
      sessionName: input.sessionName,
      paneId,
      ownerNonce: input.ownerNonce,
      workerNonce: input.workerNonce,
    });
  }

  inspectOwnedPane(sessionName: string): Result<TmuxPaneIdentityV1> {
    if (!validSessionName(sessionName) || !this.hasSession(sessionName)) {
      return err(runtimeError('E_NOT_FOUND', 'Tmux session does not exist', { sessionName }));
    }
    const pane = tmux(['display-message', '-p', '-t', `${sessionName}:0.0`, '#{pane_id}']);
    const owner = tmux(['show-options', '-v', '-t', sessionName, '@oma_owner_nonce']);
    if (!pane.ok || !owner.ok) return err(runtimeError('E_TMUX_OWNER_MISMATCH', 'Tmux owner options cannot be read'));
    const paneId = pane.value.stdout.trim();
    const worker = tmux(['show-options', '-p', '-v', '-t', paneId, '@oma_worker_nonce']);
    if (!worker.ok || owner.value.stdout.trim() === '' || worker.value.stdout.trim() === '') {
      return err(runtimeError('E_TMUX_OWNER_MISMATCH', 'Tmux owner options are missing'));
    }
    return ok({
      sessionName,
      paneId,
      ownerNonce: owner.value.stdout.trim(),
      workerNonce: worker.value.stdout.trim(),
    });
  }

  killOwnedSession(sessionName: string, ownerNonce: string): Result<void> {
    const identity = this.inspectOwnedPane(sessionName);
    if (!identity.ok || identity.value.ownerNonce !== ownerNonce) {
      return err(runtimeError('E_TMUX_OWNER_MISMATCH', 'Refusing to kill a tmux session with a different owner nonce', {
        sessionName,
      }));
    }
    const killed = tmux(['kill-session', '-t', sessionName]);
    return killed.ok ? ok(undefined) : killed;
  }

  hasSession(sessionName: string): boolean {
    return spawnSync('tmux', ['has-session', '-t', sessionName], { encoding: 'utf8' }).status === 0;
  }

  private killUnconditionally(sessionName: string): void {
    spawnSync('tmux', ['kill-session', '-t', sessionName], { encoding: 'utf8' });
  }
}

interface TmuxOutput {
  stdout: string;
  stderr: string;
}

function tmux(argv: readonly string[]): Result<TmuxOutput> {
  const result = spawnSync('tmux', [...argv], { encoding: 'utf8' });
  if (result.status !== 0) {
    return err(runtimeError('E_RETRYABLE_BLOCKER', 'tmux command failed', {
      argv,
      exitCode: result.status,
      stderr: result.stderr,
    }));
  }
  return ok({ stdout: result.stdout, stderr: result.stderr });
}

function validSessionName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

function validNonce(value: string): boolean {
  return value !== '' && !value.includes('\0') && !value.includes('\n');
}

function safeRealpath(target: string): string | null {
  try { return fs.realpathSync(path.resolve(target)); } catch (_) { return null; }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

