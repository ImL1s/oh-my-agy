import { parseCliArguments } from '../../src/cli/parser';

describe('CLI parser', () => {
  test.each(['ralph', 'ultrawork', 'search'] as const)('parses explicit %s mode and preserves task bytes', (mode) => {
    expect(parseCliArguments([mode, '--', 'one', '--flag', 'two\n三'])).toEqual({
      kind: 'mode',
      mode,
      task: 'one --flag two\n三',
    });
  });

  test('routes complete team resolve-fork argv without interpreting C-owned semantics', () => {
    const args = [
      'resolve-fork', '--team', 'team-1', '--fork', 'fork-2', '--winner-generation', '3',
      '--expected-revision', '8', '--evidence', '/tmp/evidence.json',
    ];
    expect(parseCliArguments(['team', ...args])).toEqual({ kind: 'team', args });
  });

  test.each([
    ['autopilot', 'start', '--', 'ship safely'],
    ['autopilot', 'status', '--session', 's1'],
    ['autopilot', 'resume', '--session', 's1', '--expected-revision', '4'],
    ['autopilot', 'cancel', '--session', 's1', '--expected-revision', '4', '--reason', 'operator'],
    ['autopilot', 'doctor', '--session', 's1'],
  ])('routes autopilot argv unchanged: %j', (...args: string[]) => {
    expect(parseCliArguments(args)).toEqual({ kind: 'autopilot', args: args.slice(1) });
  });

  test('ordinary agy invocations fail open, including informational mode words and code blocks', () => {
    const args = ['-p', 'Explain how to use ralph and `search`'];
    expect(parseCliArguments(args)).toEqual({ kind: 'passthrough', args });
  });

  test('rejects an empty managed task rather than launching a marker-only prompt', () => {
    expect(parseCliArguments(['ralph', '--'])).toEqual(expect.objectContaining({
      kind: 'invalid',
      code: 'E_DIRECTIVE_INVALID',
    }));
  });

  test('rejects tokens between mode and -- (no silent drop)', () => {
    const result = parseCliArguments(['ralph', '--madmax', '--', 'ship']);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.code).toBe('E_DIRECTIVE_INVALID');
      expect(result.message).toMatch(/unexpected token/);
    }
  });

  test('allows clean managed form with --', () => {
    expect(parseCliArguments(['ralph', '--', 'ship'])).toEqual({
      kind: 'mode',
      mode: 'ralph',
      task: 'ship',
    });
  });

  test.each([
    ['workflow', ['list']],
    ['mcp-server', []],
    ['wiki', ['search', 'release']],
    ['hooks', ['status', '--json']],
    ['session', ['list', '--json']],
    ['cancel', ['--json']],
    ['native-status', []],
    ['resume', ['--session', 's1']],
    ['production', ['verify']],
    ['explain', ['E_PLUGIN_NOT_ACTIVE', '--json']],
    ['ask', ['codex', 'second opinion', '--dry-run']],
  ])('routes public composition command %s without agy pass-through', (command, args) => {
    expect(parseCliArguments([command, ...args])).toEqual({
      kind: 'extended',
      command,
      args,
    });
  });

  test.each([
    [['native', 'capabilities'], { kind: 'native', command: 'capabilities', args: [] }],
    [['native', 'capabilities', '--json'], { kind: 'native', command: 'capabilities', args: ['--json'] }],
    [['native', 'probe', '--live'], { kind: 'native', command: 'probe', args: ['--live'] }],
  ])('reserves only recognized nested native form %j', (argv, expected) => {
    expect(parseCliArguments(argv)).toEqual(expected);
  });

  test.each([
    ['native'],
    ['native', 'unknown'],
    ['native', '--help'],
  ])('preserves unrecognized native argv as agy passthrough: %j', (...argv: string[]) => {
    expect(parseCliArguments(argv)).toEqual({ kind: 'passthrough', args: argv });
  });
});
