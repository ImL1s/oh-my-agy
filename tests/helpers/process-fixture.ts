import { spawn } from 'child_process';

export interface ProcessFixtureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function runProcessFixture(
  command: string,
  argv: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<ProcessFixtureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...argv], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export function runTypeScriptExpression(
  source: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessFixtureResult> {
  return runProcessFixture(
    process.execPath,
    ['-r', require.resolve('ts-node/register'), '-e', source],
    options,
  );
}
