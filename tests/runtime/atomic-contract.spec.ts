import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalBytesV1 } from '../../src/contracts/state-schemas';
import {
  appendJsonLineDurable,
  atomicWriteContractBytes,
  writeImmutableFile,
} from '../../src/runtime/atomic';

describe('contract-safe atomic storage', () => {
  test('canonical contract bytes have no trailing LF and immutable copies are 0400', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-atomic-contract-'));
    try {
      const target = path.join(root, 'state.json');
      atomicWriteContractBytes(target, canonicalBytesV1({ schema_version: 1, store_kind: 'sample' }));
      expect(fs.readFileSync(target, 'utf8')).toBe('{"schema_version":1,"store_kind":"sample"}');
      const immutable = path.join(root, 'recovery', 'copy.jsonl');
      writeImmutableFile(immutable, Buffer.from('immutable\n'));
      expect(fs.statSync(immutable).mode & 0o777).toBe(0o400);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('immutable copy refuses a symlink target instead of following it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-immutable-link-'));
    try {
      const outside = path.join(root, 'outside');
      const link = path.join(root, 'copy');
      fs.writeFileSync(outside, 'keep');
      fs.symlinkSync(outside, link);
      expect(() => writeImmutableFile(link, Buffer.from('replace'))).toThrow(/symbolic-link/);
      expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('JSONL appends exactly one complete canonical line under a stream lock', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-jsonl-'));
    try {
      const target = path.join(root, 'events.jsonl');
      appendJsonLineDurable(target, { sequence: 1, value: 'a' });
      appendJsonLineDurable(target, { sequence: 2, value: 'b' });
      expect(fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))).toEqual([
        { sequence: 1, value: 'a' },
        { sequence: 2, value: 'b' },
      ]);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
