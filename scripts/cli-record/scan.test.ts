// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FORBIDDEN, scan, SECRETS } from './scan';

/**
 * A secret's shape, assembled at run time from harmless pieces, so this file
 * holds no literal a secret scanner would stop at the door.
 */
function shaped(...parts: string[]): string {
  return parts.join('');
}

/** One fake of each secret shape, by its kind, built at run time. */
const SECRET_CASES: Record<string, string> = {
  pem: shaped('-----BEGIN ', 'PRIVATE KEY-----\nMIIB', 'abc\n-----END ', 'PRIVATE KEY-----'),
  oauth: shaped('sk-ant-', 'oat01-', 'Abc'.repeat(10)),
  anthropic: shaped('sk-ant-', 'api03-', 'Abc'.repeat(10)),
  'api-key': shaped('sk-', 'proj-', 'Abc'.repeat(8)),
  github: shaped('gh', 'p_', 'Abc1'.repeat(9)),
  slack: shaped('xo', 'xb-', '1234-5678-', 'abcdEFGH'),
  aws: shaped('AK', 'IA', 'ABCDEFGH23456789'),
  google: shaped('AI', 'za', 'Sy', 'A1b2C3d4'.repeat(4), '-'),
  jwt: shaped('ey', 'JhbGciOiJIUzI1', '.', 'ey', 'JzdWIiOiIxMjM0', '.', 'c2lnbmF0dXJl'),
  'url-credentials': shaped('https://', 'someone:', 'hunter2', '@example.com/'),
  bearer: shaped('Bear', 'er ', 'abc'),
  'mcp-bearer': 'q'.repeat(32),
};

/** One case per pattern: what the scan must find, as a raw recording would carry it. */
const CASES: [string, string][] = [
  ['a macOS home path', '{ "cwd": "/Users/someone/vault" }'],
  ['a Linux home path', '{ "cwd": "/home/someone/vault" }'],
  ['a macOS temporary folder', '{ "cwd": "/var/folders/ab/cdef/T/cerebro-cli-record" }'],
  ["macOS's private /var", '{ "cwd": "/private/var/db/record" }'],
  ["macOS's private /tmp", '{ "file_path": "/private/tmp/claude-501/x/scratchpad/notes/a.md" }'],
  ['a /tmp path', '{ "cwd": "/tmp/cerebro-cli-record/vault" }'],
  ['an email or other @-address', '{ "text": "write to someone@example.com" }'],
  ['a real UUID', '{ "session_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427" }'],
  ['a real message, tool or request id', '{ "id": "toolu_01AbCdEfGhIjKlMnOp" }'],
  ...SECRETS.map(({ what, kind }): [string, string] => [
    what,
    JSON.stringify({ value: SECRET_CASES[kind] }),
  ]),
];

describe('scan', () => {
  it('has a case for every pattern', () => {
    expect(CASES.map(([what]) => what)).toEqual(FORBIDDEN.map(({ what }) => what));
  });

  it.each(CASES)('finds %s', (what, text) => {
    expect(scan(text).filter((hit) => hit.startsWith(`${what}: `))).toHaveLength(1);
  });

  it.each([
    ['message', 'msg_01XFDUDYJgAACzvnptvVoYEL'],
    ['request', 'req_011CUiAbCdEf'],
    ['server tool', 'srvtoolu_01AbCdEf'],
  ])('finds a real %s id', (_kind, id) => {
    expect(scan(`{ "id": "${id}" }`)).toEqual([`a real message, tool or request id: ${id}`]);
  });

  it('misses the placeholders and the synthetic ids the reducer writes', () => {
    const clean = JSON.stringify({
      config: '/RECORD/claude-config',
      transcript: '/RECORD/claude-config/projects/-RECORD-vault/x.jsonl',
      repo: '/REPO/scripts/cli-record/probe.ts',
      home: '~/notes',
      slugs: ['-REPO', '-HOME', 'GIT-NAME', 'GIT-EMAIL'],
      names: ['USER', 'HOST', 'GIT_NAME', 'GIT_EMAIL'],
      session_id: '00000000-0000-4000-8000-00000000000a',
      message: 'msg_000000000000000000000001',
      tool: 'toolu_000000000000000000000002',
      request: 'req_000000000000000000000003',
      server: 'srvtoolu_000000000000000000000004',
    });
    expect(scan(clean)).toEqual([]);
  });

  it('has a fake of every secret shape', () => {
    expect(Object.keys(SECRET_CASES).sort()).toEqual(SECRETS.map(({ kind }) => kind).sort());
  });

  it.each(SECRETS.map(({ kind }) => kind))('misses the stand-in for %s', (kind) => {
    for (const n of [1, 2, 12]) {
      expect(scan(JSON.stringify({ value: `redacted-${kind}-${n}` }))).toEqual([]);
    }
  });

  it('misses words and ids that only look long', () => {
    const clean = JSON.stringify({
      text: 'a task-list of desk-risk items, and an incomprehensibilities word',
      words: 'q'.repeat(31) + ' ' + 'q'.repeat(33),
      tool: 'mcp__cerebro__search_notes',
    });
    expect(scan(clean)).toEqual([]);
  });

  it('names a /private/tmp path once, as the private one', () => {
    expect(scan('/private/tmp/x and /tmp/y')).toEqual([
      "macOS's private /tmp: /private/tmp/",
      'a /tmp path: /tmp/',
    ]);
  });

  it('names the pattern and the text of every hit', () => {
    expect(scan('/Users/a and /Users/b')).toEqual([
      'a macOS home path: /Users/',
      'a macOS home path: /Users/',
    ]);
  });
});
