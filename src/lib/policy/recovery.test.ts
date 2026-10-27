import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sha256Hex } from '../sha256';
import { RECOVERY_RAW } from './recovery';
it('hashes to the digest the Rust recovery loader also asserts', () => {
  const root = join(__dirname, '../../..');
  // Regenerate only through the native ignored write_recovery_digest test.
  const digest = readFileSync(join(root, 'shared/policy/recovery.v1.sha256'), 'utf8').trim();
  expect(sha256Hex(RECOVERY_RAW)).toBe(digest);
  expect(RECOVERY_RAW).toBe(readFileSync(join(root, 'shared/policy/recovery.v1.json'), 'utf8'));
});
