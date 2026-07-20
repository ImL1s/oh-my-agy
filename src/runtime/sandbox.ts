/**
 * 設計概念映射：planning/search 唯讀沙盒包裝（ADR-0001 Option B）。
 * Fail-closed when OMA_REQUIRE_SANDBOX=1 and tool missing.
 */
import { spawnSync } from 'child_process';
import { RuntimeError, runtimeError } from './errors';
import { Result, err, ok } from './types';

export interface SandboxWrapInput {
  command: string;
  argv: readonly string[];
  cwd: string;
  writablePaths: readonly string[];
  requireSandbox?: boolean;
}

export interface SandboxedCommand {
  command: string;
  argv: string[];
  sandbox: 'bwrap' | 'sandbox-exec' | 'none';
}

export function sandboxAvailable(): 'bwrap' | 'sandbox-exec' | null {
  if (spawnSync('bwrap', ['--version'], { encoding: 'utf8' }).status === 0) return 'bwrap';
  if (process.platform === 'darwin'
    && spawnSync('sandbox-exec', ['-n', 'true'], { encoding: 'utf8' }).status === 0) {
    return 'sandbox-exec';
  }
  return null;
}

/**
 * 將 command/argv 包進 OS sandbox。writablePaths 為允許寫入的絕對路徑。
 */
export function wrapWithReadOnlySandbox(
  input: Readonly<SandboxWrapInput>,
): Result<SandboxedCommand, RuntimeError> {
  const requireSandbox = input.requireSandbox
    ?? process.env.OMA_REQUIRE_SANDBOX === '1';
  const available = sandboxAvailable();
  if (available === null) {
    if (requireSandbox) {
      return err(runtimeError(
        'E_RETRYABLE_BLOCKER',
        'Sandbox required (OMA_REQUIRE_SANDBOX=1) but bwrap/sandbox-exec is unavailable',
      ));
    }
    return ok({
      command: input.command,
      argv: [...input.argv],
      sandbox: 'none',
    });
  }

  if (available === 'bwrap') {
    const argv = [
      '--die-with-parent',
      '--ro-bind', '/', '/',
      '--tmpfs', '/tmp',
      '--dev', '/dev',
      '--proc', '/proc',
      '--chdir', input.cwd,
    ];
    for (const writable of input.writablePaths) {
      argv.push('--bind', writable, writable);
    }
    argv.push('--', input.command, ...input.argv);
    return ok({ command: 'bwrap', argv, sandbox: 'bwrap' });
  }

  // sandbox-exec: minimal restrictive profile allowing writes only under listed paths is complex;
  // for ADR-0001 ship a fail-closed presence check + pass-through when not required.
  // When required on macOS without a profile path, fail closed for safety of false confidence.
  if (requireSandbox) {
    return err(runtimeError(
      'E_RETRYABLE_BLOCKER',
      'sandbox-exec is present but no sealed write-allow profile is configured; refuse launch under requireSandbox',
    ));
  }
  return ok({
    command: input.command,
    argv: [...input.argv],
    sandbox: 'none',
  });
}

/** managed search mode helper: require sandbox when env set */
export function wrapManagedSearchLaunch(
  command: string,
  argv: readonly string[],
  cwd: string,
  plansDir: string,
): Result<SandboxedCommand, RuntimeError> {
  return wrapWithReadOnlySandbox({
    command,
    argv,
    cwd,
    writablePaths: [plansDir],
    requireSandbox: process.env.OMA_REQUIRE_SANDBOX === '1',
  });
}
