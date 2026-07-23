import {
  AGY_DEFAULT_HEADLESS_TIMEOUT,
  buildAgy115Argv,
  parseGoDurationMs,
  validateAgy115Help,
} from '../../src/team/agy-argv';

describe('Antigravity 1.1.5 frozen worker argv', () => {
  const prompt = 'Review the owned task safely';

  test.each([
    ['headless', 'read-only', undefined, ['--print', prompt, '--print-timeout', '5m0s', '--mode', 'plan', '--sandbox']],
    ['headless', 'read-write', undefined, ['--print', prompt, '--print-timeout', '5m0s', '--mode', 'accept-edits']],
    ['interactive', 'read-only', undefined, ['--prompt-interactive', prompt, '--mode', 'plan', '--sandbox']],
    ['interactive', 'read-write', undefined, ['--prompt-interactive', prompt, '--mode', 'accept-edits']],
    ['headless', 'read-only', 'conversation-1', ['--conversation', 'conversation-1', '--print', prompt, '--print-timeout', '5m0s', '--mode', 'plan', '--sandbox']],
    ['headless', 'read-write', 'conversation-1', ['--conversation', 'conversation-1', '--print', prompt, '--print-timeout', '5m0s', '--mode', 'accept-edits']],
    ['interactive', 'read-only', 'conversation-1', ['--conversation', 'conversation-1', '--prompt-interactive', prompt, '--mode', 'plan', '--sandbox']],
    ['interactive', 'read-write', 'conversation-1', ['--conversation', 'conversation-1', '--prompt-interactive', prompt, '--mode', 'accept-edits']],
  ] as const)('%s %s conversation=%s', (launchMode, capabilityMode, conversationId, expected) => {
    const result = buildAgy115Argv({ launchMode, capabilityMode, prompt, conversationId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(expected);
    const promptIndex = result.value.indexOf(prompt);
    expect(['--print', '--prompt-interactive']).toContain(result.value[promptIndex - 1]);
    expect(result.value.filter((entry) => entry === prompt)).toHaveLength(1);
    expect(result.value).not.toContain('--dangerously-skip-permissions');
  });

  test('bounded headless timeout defaults to 5m0s and policy may only lower it', () => {
    expect(AGY_DEFAULT_HEADLESS_TIMEOUT).toBe('5m0s');
    expect(parseGoDurationMs('5m0s')).toBe(300_000);
    expect(parseGoDurationMs('2m30s')).toBe(150_000);
    expect(buildAgy115Argv({
      launchMode: 'headless', capabilityMode: 'read-only', prompt, boundedDuration: '5m1s',
    }).ok).toBe(false);
    expect(buildAgy115Argv({
      launchMode: 'headless', capabilityMode: 'read-only', prompt: '--dangerously-skip-permissions',
    }).ok).toBe(false);
  });

  test('version/help table requires every documented 1.1.5 flag', () => {
    const help = [
      '--conversation', '--mode', '--print', '--print-timeout', '--prompt-interactive', '--sandbox',
    ].join('\n');
    expect(validateAgy115Help('1.1.5\n', help).ok).toBe(true);
    expect(validateAgy115Help('1.1.4\n', help).ok).toBe(false);
    expect(validateAgy115Help('1.1.5\n', help.replace('--sandbox', '')).ok).toBe(false);
  });
});
