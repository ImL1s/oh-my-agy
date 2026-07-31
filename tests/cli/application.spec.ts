import { runtimeError } from '../../src/runtime/errors';
import { ProcessOutcome } from '../../src/runtime/process';
import { ok, err } from '../../src/runtime/types';
import { CliServices, runCli } from '../../src/cli/application';

describe('CLI application wiring', () => {
  const outcome: ProcessOutcome = {
    code: 0,
    signal: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    processIdentity: null,
  };

  function fixture() {
    let stdout = '';
    let stderr = '';
    const services: jest.Mocked<CliServices> = {
      launchMode: jest.fn<
        ReturnType<CliServices['launchMode']>,
        Parameters<CliServices['launchMode']>
      >(async () => ok(outcome)),
      passThrough: jest.fn<
        ReturnType<CliServices['passThrough']>,
        Parameters<CliServices['passThrough']>
      >(async () => ok(outcome)),
      autopilotCommand: jest.fn<
        ReturnType<CliServices['autopilotCommand']>,
        Parameters<CliServices['autopilotCommand']>
      >(async () => 0),
      teamCommand: jest.fn<
        ReturnType<CliServices['teamCommand']>,
        Parameters<CliServices['teamCommand']>
      >(async () => 0),
      setupCommand: jest.fn<
        ReturnType<CliServices['setupCommand']>,
        Parameters<CliServices['setupCommand']>
      >(async () => 0),
      doctorCommand: jest.fn<
        ReturnType<CliServices['doctorCommand']>,
        Parameters<CliServices['doctorCommand']>
      >(async () => 0),
      skillCommand: jest.fn<
        ReturnType<CliServices['skillCommand']>,
        Parameters<CliServices['skillCommand']>
      >(async () => 0),
      nativeCommand: jest.fn<
        ReturnType<CliServices['nativeCommand']>,
        Parameters<CliServices['nativeCommand']>
      >(async () => 0),
      extendedCommand: jest.fn<
        ReturnType<CliServices['extendedCommand']>,
        Parameters<CliServices['extendedCommand']>
      >(async () => 0),
    };
    const io = {
      stdout: (value: string) => { stdout += value; },
      stderr: (value: string) => { stderr += value; },
    };
    return { services, io, output: () => ({ stdout, stderr }) };
  }

  test('wires team resolve-fork argv unchanged to C typed command surface', async () => {
    const { services, io } = fixture();
    const args = [
      'resolve-fork', '--team', 't1', '--fork', 'f1', '--winner-generation', '2',
      '--expected-revision', '9', '--evidence', '/tmp/selection.json',
    ];
    expect(await runCli(['team', ...args], services, io)).toBe(0);
    expect(services.teamCommand).toHaveBeenCalledWith(args);
    expect(services.launchMode).not.toHaveBeenCalled();
  });

  test('launches explicit modes but passes informational mentions through unchanged', async () => {
    const { services, io } = fixture();
    expect(await runCli(['search', '--', 'locate owner'], services, io)).toBe(0);
    expect(services.launchMode).toHaveBeenCalledWith('search', 'locate owner');

    const ordinary = ['-p', 'Explain how to use search'];
    expect(await runCli(ordinary, services, io)).toBe(0);
    expect(services.passThrough).toHaveBeenCalledWith(ordinary);
  });

  test('reports typed runtime errors and never turns a failed managed launch into pass-through', async () => {
    const { services, io, output } = fixture();
    services.launchMode.mockResolvedValue(err(runtimeError('E_PLUGIN_NOT_ACTIVE', 'plugin inactive')));
    expect(await runCli(['ralph', '--', 'task'], services, io)).toBe(1);
    expect(output().stderr).toContain('E_PLUGIN_NOT_ACTIVE: plugin inactive');
    expect(services.passThrough).not.toHaveBeenCalled();
  });

  test('help documents precise resume and fork resolution safety arguments', async () => {
    const { services, io, output } = fixture();
    expect(await runCli(['--help'], services, io)).toBe(0);
    expect(output().stdout).toContain('autopilot resume --session <id> --conversation <id> --expected-revision <n>');
    expect(output().stdout).toContain('oma doctor');
    expect(output().stdout).toContain('oma native capabilities [--json]');
    expect(output().stdout).toContain('oma native probe --live [--json]');
    expect(output().stdout).toContain('team resolve-fork --team <id> --fork <id> --winner-generation <n>');
  });

  test('routes public composition commands without passing them to agy', async () => {
    const { services, io } = fixture();
    expect(await runCli(['workflow', 'list'], services, io)).toBe(0);
    expect(services.extendedCommand).toHaveBeenCalledWith('workflow', ['list']);
    expect(services.passThrough).not.toHaveBeenCalled();
  });

  test('routes recognized nested native commands and preserves unknown forms', async () => {
    const { services, io } = fixture();
    expect(await runCli(['native', 'capabilities', '--json'], services, io)).toBe(0);
    expect(services.nativeCommand).toHaveBeenCalledWith('capabilities', ['--json']);
    expect(services.passThrough).not.toHaveBeenCalled();

    expect(await runCli(['native', 'future', '--json'], services, io)).toBe(0);
    expect(services.passThrough).toHaveBeenCalledWith(['native', 'future', '--json']);
  });
});
