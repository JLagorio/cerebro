import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scan } from './cli-record/scan';

/**
 * Stream fixtures stay sanitized (M54.5). The repo is public, and every file
 * under src-tauri/fixtures/cli-stream/ has the shape of a Claude Code run, so
 * each one is reduced before it lands, by hand or by
 * scripts/cli-record/reduce.ts (M56.1): placeholder paths, synthetic ids,
 * nobody's address and no credential. This guard reads every file there, in
 * every subfolder, and fails on anything scripts/cli-record/scan.ts forbids.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STREAMS = join(ROOT, 'src-tauri/fixtures/cli-stream');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const fixtures = filesUnder(STREAMS).map((path) => [relative(STREAMS, path), path] as const);

describe('cli-stream fixtures', () => {
  it('include the init and first-turn streams, and the spike folder', () => {
    expect(fixtures.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'init-connected.json',
        'init-pending.json',
        'init-failed.json',
        'first-turn-read-core.json',
        join('spike', 'not-signed-in.json'),
      ]),
    );
  });

  it.each(fixtures)('%s holds no user path, address, credential or real id', (_name, path) => {
    expect(scan(readFileSync(path, 'utf8'))).toEqual([]);
  });
});

describe('the fixture guard', () => {
  it.each([
    ['a macOS home path', '{ "cwd": "/Users/someone/vault" }'],
    ['a Linux home path', '{ "cwd": "/home/someone/vault" }'],
    ['an email or other @-address', '{ "text": "write to someone@example.com" }'],
    ['a real UUID', '{ "session_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427" }'],
    ['a real message, tool or request id', '{ "id": "toolu_01AbCdEfGhIjKlMnOp" }'],
    ['a bearer token', '{ "Authorization": "Bearer abcdefghijklmnopqrstuvwxyzabcdef" }'],
  ])('catches %s', (what, text) => {
    expect(scan(text).filter((leak) => leak.startsWith(`${what}: `))).toHaveLength(1);
  });

  it('passes the synthetic ids and placeholder paths the fixtures use', () => {
    const synthetic = JSON.stringify({
      session_id: '00000000-0000-4000-8000-0000000000aa',
      message: { id: 'msg_00000000000000000000000001' },
      tool_use_id: 'toolu_00000000000000000000000002',
      cwd: '/vault',
    });
    expect(scan(synthetic)).toEqual([]);
  });
});
