import { runProcessFixture, ProcessFixtureResult } from './process-fixture';

export interface HookFixtureResult extends ProcessFixtureResult {
  json: unknown;
}

export async function runHookFixture(
  entrypoint: string,
  event: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookFixtureResult> {
  const result = await runProcessFixture(
    process.execPath,
    [entrypoint],
    { env, input: JSON.stringify(event) },
  );

  return {
    ...result,
    json: result.stdout.trim() === '' ? undefined : JSON.parse(result.stdout),
  };
}

