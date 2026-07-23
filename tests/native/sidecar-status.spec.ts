import * as fs from 'fs';
import * as path from 'path';
import { inspectPrivateSidecarStatus } from '../../src/native/sidecar-status';

describe('private Antigravity sidecar policy', () => {
  test('is an explicit T0 non-probe and opens no network surface', () => {
    expect(inspectPrivateSidecarStatus()).toEqual({
      store_kind: 'oma_private_sidecar_status', schema_version: 1, repository_id: 'OMA',
      status: 'forbidden_unprobed', enabled: false, attempted: false,
      evidence_tier: 'T0', detail_code: 'PRIVATE_SIDECAR_FORBIDDEN',
    });
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/native/sidecar-status.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"](?:net|http|https|dns)['"]/u);
    expect(source).not.toMatch(/(?:connect|request|listen|localhost|127\.0\.0\.1|:\d{2,5})\s*\(/u);
  });
});
