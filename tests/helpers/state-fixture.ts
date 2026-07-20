import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface StateFixture {
  root: string;
  path(...segments: string[]): string;
  readJson<T>(...segments: string[]): T;
  cleanup(): void;
}

export function createStateFixture(prefix = 'oma-state-'): StateFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  return {
    root,
    path: (...segments: string[]) => path.join(root, ...segments),
    readJson: <T>(...segments: string[]) => JSON.parse(
      fs.readFileSync(path.join(root, ...segments), 'utf8'),
    ) as T,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

