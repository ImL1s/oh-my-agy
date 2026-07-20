import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TmuxController } from '../../src/team/tmux';
import { TmuxFixture } from '../helpers/tmux-fixture';

const maybeTest = TmuxFixture.available() ? test : test.skip;

describe('real tmux ownership lifecycle', () => {
  const fixture = new TmuxFixture();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-team-tmux-'));

  afterAll(() => {
    fixture.cleanup();
    fixture.assertClean();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  maybeTest('TEAM-03/11 creates a real owned pane and refuses a mismatched owner kill', () => {
    const descriptor = path.join(tempRoot, 'worker.json');
    const worker = path.join(tempRoot, 'worker.js');
    fs.writeFileSync(descriptor, '{}\n');
    fs.writeFileSync(worker, 'setInterval(() => {}, 1000);\n');
    const controller = new TmuxController();
    const sessionName = fixture.session('owned');
    const started = controller.startWorker({
      sessionName,
      cwd: tempRoot,
      executablePath: process.execPath,
      descriptorPath: descriptor,
      bootstrapArgv: [worker],
      ownerNonce: 'owner-a',
      workerNonce: 'worker-a',
    });
    expect(started.ok).toBe(true);
    expect(fixture.hasSession(sessionName)).toBe(true);
    const mismatch = controller.killOwnedSession(sessionName, 'owner-b');
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe('E_TMUX_OWNER_MISMATCH');
    expect(fixture.hasSession(sessionName)).toBe(true);
    expect(controller.killOwnedSession(sessionName, 'owner-a').ok).toBe(true);
    expect(fixture.hasSession(sessionName)).toBe(false);
  });
});

