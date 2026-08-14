/**
 * No tracked source file is a binary blob.
 *
 * `.gitattributes` marks every source extension `text` so that a file git
 * still classifies as binary "shows up as a loud anomaly in review". That
 * works — but only if somebody reads the diffstat closely enough to notice
 * `Bin 14518 -> 18013 bytes` among a dozen ordinary line counts. Nobody did:
 * `src/lib/policy/table.ts` carried two RAW NUL bytes from M24.1 to M26.3, so
 * for three milestones the policy loader had no diff, no blame, and no grep.
 * It was found by accident.
 *
 * This is the same failure the M14 audit recorded — 197 lines of production
 * code merged with a zero-line diff — so the anomaly gets an assertion rather
 * than a convention. AGENTS.md states the rule this enforces: write control
 * characters as ESCAPES, never as raw bytes.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '../..');

/** The extensions `.gitattributes` pins to `text`. */
const TEXT = new Set([
  '.ts',
  '.tsx',
  '.rs',
  '.md',
  '.yml',
  '.yaml',
  '.json',
  '.html',
  '.css',
  '.sh',
  '.toml',
]);

/**
 * Control bytes that have no business in source. Tab, LF, and CR are excluded
 * because they are ordinary whitespace; everything else in C0 plus DEL is
 * what makes git call a file binary.
 */
function controlBytes(bytes: Buffer): number[] {
  const found: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b === 0x7f) found.push(i);
  }
  return found;
}

describe('every tracked source file is text', () => {
  it('contains no raw control bytes', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'buffer' })
      .toString('utf8')
      .split('\0')
      .filter((path) => path !== '' && TEXT.has(extname(path)));
    expect(tracked.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const path of tracked) {
      const at = controlBytes(readFileSync(join(REPO, path)));
      if (at.length > 0) offenders.push(`${path} (${at.length} at byte ${at[0]})`);
    }
    expect(offenders, 'write control characters as escapes, never as raw bytes').toEqual([]);
  });
});
