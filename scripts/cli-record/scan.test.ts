// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FORBIDDEN, scan } from './scan';

/** One case per pattern: what the scan must find, as a raw recording would carry it. */
const CASES: [string, string][] = [
  ['a macOS home path', '{ "cwd": "/Users/someone/vault" }'],
  ['a Linux home path', '{ "cwd": "/home/someone/vault" }'],
  ['a macOS temporary folder', '{ "cwd": "/var/folders/ab/cdef/T/cerebro-cli-record" }'],
  ["macOS's private /var", '{ "cwd": "/private/var/db/record" }'],
  ['an email or other @-address', '{ "text": "write to someone@example.com" }'],
  ['a real UUID', '{ "session_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427" }'],
  ['a real message, tool or request id', '{ "id": "toolu_01AbCdEfGhIjKlMnOp" }'],
  ['a bearer token', '{ "Authorization": "Bearer abc" }'],
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

  it('names the pattern and the text of every hit', () => {
    expect(scan('/Users/a and /Users/b')).toEqual([
      'a macOS home path: /Users/',
      'a macOS home path: /Users/',
    ]);
  });
});
