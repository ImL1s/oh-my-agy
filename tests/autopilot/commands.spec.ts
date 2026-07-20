import { parseAutopilotCommand } from '../../src/autopilot/commands';

describe('Autopilot command parser', () => {
  test('parses start goal as literal task text', () => {
    expect(parseAutopilotCommand(['start', '--', 'ship', '$(touch /tmp/no)', '安全'])).toEqual({
      ok: true,
      value: { kind: 'start', goal: 'ship $(touch /tmp/no) 安全' },
    });
  });

  test.each([
    ['status', ['--session', 's1'], { kind: 'status', sessionId: 's1' }],
    ['doctor', ['--session', 's1'], { kind: 'doctor', sessionId: 's1' }],
    ['reset-breaker', ['--session', 's1', '--expected-revision', '9'], {
      kind: 'reset-breaker', sessionId: 's1', expectedRevision: 9,
    }],
    ['resume', [
      '--session', 's1', '--conversation', 'c1', '--expected-revision', '9',
    ], { kind: 'resume', sessionId: 's1', conversationId: 'c1', expectedRevision: 9 }],
    ['drive', [
      '--session', 's1', '--conversation', 'c1', '--expected-revision', '9',
    ], { kind: 'drive', sessionId: 's1', conversationId: 'c1', expectedRevision: 9 }],
    ['cancel', [
      '--session', 's1', '--expected-revision', '9', '--reason', 'operator stop',
    ], { kind: 'cancel', sessionId: 's1', expectedRevision: 9, reason: 'operator stop' }],
    ['checkpoint', [
      '--session', 's1', '--expected-revision', '9', '--evidence', 'evidence.json',
    ], { kind: 'checkpoint', sessionId: 's1', expectedRevision: 9, evidencePath: 'evidence.json' }],
    ['review', [
      '--session', 's1', '--expected-revision', '9', '--evidence', 'review.json',
    ], { kind: 'review', sessionId: 's1', expectedRevision: 9, evidencePath: 'review.json' }],
    ['qa', [
      '--session', 's1', '--expected-revision', '9', '--evidence', 'qa.json',
    ], { kind: 'qa', sessionId: 's1', expectedRevision: 9, evidencePath: 'qa.json' }],
  ] as const)('parses %s with strict typed flags', (subcommand, args, expected) => {
    expect(parseAutopilotCommand([subcommand, ...args])).toEqual({ ok: true, value: expected });
  });

  test.each([
    ['start', '--'],
    ['resume', '--session', 's1', '--expected-revision', '1'],
    ['status', '--session', 's1', '--session', 's2'],
    ['checkpoint', '--session', 's1', '--expected-revision', '-1', '--evidence', 'x'],
    ['qa', '--session', 's1', '--expected-revision', '1', '--evidence', 'x', '--passed', 'true'],
  ])('rejects malformed or forgeable argv: %j', (...argv: string[]) => {
    const result = parseAutopilotCommand(argv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_VALIDATOR_REJECTED');
  });
});
