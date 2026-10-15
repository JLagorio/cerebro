import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FILE_CAP, FOLDER_CAP } from './cli-record/sanitize';
import { scan } from './cli-record/scan';

/**
 * Stream fixtures stay sanitized (M54.5, CV-26). The repo is public, and every
 * file under src-tauri/fixtures/cli-stream/ has the shape of a Claude Code
 * run. Hand-shaped fixtures and the spike's (spike/) are reduced before they
 * land, by hand or by scripts/cli-record/reduce.ts (M56.1); real recordings
 * (real/) keep the CLI's whole framing and land only through
 * scripts/cli-record/sanitize.ts (M56.2). Either way: placeholder paths,
 * synthetic ids, nobody's address and no credential. This guard reads every
 * file there, in every subfolder and of every extension, and fails on
 * anything scripts/cli-record/scan.ts forbids; real/ also stays under its
 * size caps. The transcript goldens under conformance/transcript/ (M56.3)
 * and the failure golden under conformance/failure/ (M56.4) repeat the
 * fixtures' text, so they are scanned too. The session-history lines under
 * jsonl/ (M56.4) name the CLI and entrypoint that wrote them.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STREAMS = join(ROOT, 'src-tauri/fixtures/cli-stream');

function filesUnder(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const fixtures = filesUnder(STREAMS).map((path) => [relative(STREAMS, path), path] as const);
/** The transcript goldens fold.rs writes from those fixtures (M56.3): what
 * they carry is the fixtures' text again, so the same list guards them. */
const GOLDENS = join(ROOT, 'conformance/transcript');
const goldens = filesUnder(GOLDENS).map((path) => [relative(GOLDENS, path), path] as const);
/** The failure golden failure.rs writes (M56.4): each fixture's notice. */
const FAILURES = join(ROOT, 'conformance/failure');
const failureGoldens = filesUnder(FAILURES).map(
  (path) => [relative(FAILURES, path), path] as const,
);
/** Session-file lines, each `{recorded: {cli, entrypoint, from}, line}` (M56.4). */
const HISTORY = join(STREAMS, 'jsonl');
const historyLines = filesUnder(HISTORY).map((path) => [relative(HISTORY, path), path] as const);
const REAL = join(STREAMS, 'real');
const recordings = filesUnder(REAL);

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

describe('the transcript goldens (M56.3)', () => {
  it('are walked', () => {
    expect(goldens.map(([name]) => name)).toEqual(
      expect.arrayContaining(['two-turns.json', 'interrupted.json', 'api-error.json']),
    );
  });

  it.each(goldens)('%s holds no user path, address, credential or real id', (_name, path) => {
    expect(scan(readFileSync(path, 'utf8'))).toEqual([]);
  });

  it('catches what a golden would carry from a leaky fixture', () => {
    const leaky = JSON.stringify({
      case: 'leaky',
      session: {
        events: [
          {
            kind: 'Text',
            message_id: 'msg_000000000000000000000001',
            text: 'saved to /Users/someone/x',
          },
        ],
      },
    });
    expect(scan(leaky)).toEqual(['a macOS home path: /Users/']);
  });
});

describe('the failure golden and its history lines (M56.4)', () => {
  it('are walked', () => {
    expect(failureGoldens.map(([name]) => name)).toEqual(['notices.json']);
    expect(historyLines.map(([name]) => name)).toEqual(
      expect.arrayContaining(['usage-limit-5h.json', 'usage-limit-weekly.json']),
    );
  });

  it.each(failureGoldens)('%s holds no user path, address, credential or real id', (_n, path) => {
    expect(scan(readFileSync(path, 'utf8'))).toEqual([]);
  });

  it.each(historyLines)('%s names the CLI, entrypoint and source that wrote it', (_n, path) => {
    const { recorded, line } = JSON.parse(readFileSync(path, 'utf8')) as {
      recorded: { cli: string; entrypoint: string; from: string };
      line: { version?: string; entrypoint?: string };
    };
    expect(recorded.cli).toMatch(/^\d+\.\d+\.\d+$/);
    expect(recorded.entrypoint).not.toBe('');
    expect(recorded.from).not.toBe('');
    // A history line records its own version, which need not be the pin.
    expect(line.version).toBe(recorded.cli);
    expect(line.entrypoint).toBe(recorded.entrypoint);
  });
});

describe('the real recordings (M56.2)', () => {
  it('are walked, every .jsonl with its meta', () => {
    const names = fixtures.map(([name]) => name);
    const streams = names.filter((name) => name.endsWith('.stream.jsonl'));
    expect(streams.length).toBeGreaterThanOrEqual(8);
    for (const stream of streams) {
      expect(names).toContain(stream.replace(/\.stream\.jsonl$/, '.meta.json'));
    }
    expect(names).toContain(join('real', 'spike-not-signed-in.session.jsonl'));
  });

  it.each(recordings)(`%s is at most ${FILE_CAP} bytes`, (path) => {
    expect(statSync(path).size).toBeLessThanOrEqual(FILE_CAP);
  });

  it(`hold at most ${FOLDER_CAP} bytes in all`, () => {
    const total = recordings.reduce((sum, path) => sum + statSync(path).size, 0);
    expect(total).toBeLessThanOrEqual(FOLDER_CAP);
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
    ["macOS's private /var", `{ "cwd": "/private/var/folders/ab/T/cerebro-cli-record" }`],
    // Built at run time, so this file holds no key a secret scanner stops at.
    ['an Anthropic API key', `{ "key": "${['sk', 'ant', 'api03', 'Q'.repeat(24)].join('-')}" }`],
  ])('catches %s', (what, text) => {
    expect(scan(text).filter((leak) => leak.startsWith(`${what}: `))).toHaveLength(1);
  });

  it('walks a nested folder of .json history lines like any other', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixture-guard-'));
    try {
      mkdirSync(join(dir, 'jsonl'));
      const leaky = JSON.stringify({ recorded: {}, line: { cwd: '/Users/someone/vault' } });
      writeFileSync(join(dir, 'jsonl', 'leaky.json'), leaky);
      expect(filesUnder(dir).map((path) => scan(readFileSync(path, 'utf8')))).toEqual([
        ['a macOS home path: /Users/'],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('walks into subfolders and reads a .jsonl like any other file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixture-guard-'));
    try {
      mkdirSync(join(dir, 'real'));
      const line = JSON.stringify({ type: 'system', subtype: 'init', cwd: '/Users/someone/vault' });
      writeFileSync(join(dir, 'real', 'leaky.stream.jsonl'), `${line}\n`);
      writeFileSync(join(dir, 'clean.json'), '{}');
      const hits = filesUnder(dir).map((path) => [
        relative(dir, path),
        scan(readFileSync(path, 'utf8')),
      ]);
      expect(hits).toEqual([
        ['clean.json', []],
        [join('real', 'leaky.stream.jsonl'), ['a macOS home path: /Users/']],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('Notion capture fixtures (M69.5)', () => {
  it('contain only toy text and synthetic ids, never a fabricated live recording', () => {
    const raw = readFileSync(join(ROOT, 'src-tauri/fixtures/notion-cases.json'), 'utf8');
    expect(scan(raw)).toEqual([]);
    const fixture = JSON.parse(raw) as { about: string; cases: { page: string }[] };
    expect(fixture.about).toContain('not a live recording');
    for (const row of fixture.cases) expect(row.page).toMatch(/^([0-9])\1{31}$/);
  });

  it('refuses a credential, home path or address in a captured page', () => {
    for (const text of [
      'Bearer ' + 'q'.repeat(32),
      '/Users/someone/page',
      'someone@example.test',
    ]) {
      expect(scan(JSON.stringify({ capture: text }))).not.toEqual([]);
    }
  });
});
