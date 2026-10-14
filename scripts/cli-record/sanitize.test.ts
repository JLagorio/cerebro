// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Machine } from './reduce';
import {
  ANSWER_DROP,
  CORPUS,
  corpusInput,
  EPOCH,
  HISTORY_RESET,
  INIT_DROP,
  INIT_KEEP,
  initSession,
  jsonl,
  leaks,
  LISTING_ATTACHMENTS,
  parseFlags,
  Refusal,
  pinResetClause,
  sanitizeHistoryLine,
  sanitizeRecording,
  writeHistoryLine,
  writeRecording,
  type RecordingInput,
  type SanitizeContext,
} from './sanitize';
import { SECRETS } from './scan';
import { SCENARIOS, SCRIPTED } from './spike';

const RECORD = '/var/folders/ab/T/cerebro-cli-record';
const MACHINE: Machine = {
  recordDir: RECORD,
  realRecordDir: `/private${RECORD}`,
  repo: '/Users/tester/dev/cerebro',
  home: '/Users/tester',
  user: 'tester',
  host: 'tester-mac.local',
  gitName: 'Test Er',
  gitEmail: 'tester@example.com',
};
const SESSION = '3ccaf8b0-f53e-4558-adeb-b8d982a145ea';

/** A secret's shape, assembled at run time, so this file holds no literal one. */
function shaped(...parts: string[]): string {
  return parts.join('');
}

const FAKES: Record<string, string> = {
  pem: shaped('-----BEGIN ', 'PRIVATE KEY-----\nMIIB', 'abc\n-----END ', 'PRIVATE KEY-----'),
  oauth: shaped('sk-ant-', 'oat01-', 'Xyz'.repeat(10)),
  anthropic: shaped('sk-ant-', 'api03-', 'Xyz'.repeat(10)),
  'api-key': shaped('sk-', 'proj-', 'Xyz'.repeat(8)),
  github: shaped('gh', 'o_', 'Xyz1'.repeat(9)),
  slack: shaped('xo', 'xp-', '1234-5678-', 'abcdEFGH'),
  aws: shaped('AS', 'IA', 'ABCDEFGH23456789'),
  google: shaped('AI', 'za', 'Sy', 'Z9y8X7w6'.repeat(4), '-'),
  jwt: shaped('ey', 'JhbGciOiJIUzI1', '.', 'ey', 'JzdWIiOiIxMjM0', '.', 'c2lnbmF0dXJl'),
  'url-credentials': shaped('https://', 'someone:', 'hunter2', '@'),
  bearer: shaped('Bear', 'er ', 'abc'),
  'mcp-bearer': 'z'.repeat(32),
};

function init(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    cwd: `/private${RECORD}/vault`,
    session_id: SESSION,
    tools: ['Bash', 'Read', 'mcp__probe__slow_echo', 'mcp__cerebro__get_note'],
    mcp_servers: [{ name: 'probe', status: 'connected', serverInfo: { name: 'probe' } }],
    model: 'claude-haiku-4-5-20251001',
    permissionMode: 'acceptEdits',
    slash_commands: ['my-own-command'],
    apiKeySource: 'none',
    claude_code_version: '2.1.250',
    output_style: 'default',
    agents: ['my-agent'],
    skills: ['my-skill'],
    plugins: [],
    uuid: 'dd7145f1-7da8-4f20-a07c-1d29ec5c7a8a',
    memory_paths: { auto: `/private${RECORD}/claude-config/projects/x/memory/` },
    messaging_socket_path: '/tmp/cc-socks/75963.sock',
    fast_mode_state: 'off',
    ...extra,
  };
}

function result(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    session_id: SESSION,
    uuid: 'd83ec0dd-8b94-4753-9538-3cedd4d614d8',
    ...extra,
  };
}

function input(lines: unknown[], session?: unknown[]): RecordingInput {
  return {
    stream: lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    session: session
      ? { name: `${SESSION}.jsonl`, text: session.map((l) => JSON.stringify(l)).join('\n') }
      : null,
  };
}

const CONTEXT: SanitizeContext = {
  name: 'toy-run',
  source: 'spike',
  proves: 'A toy run reaches its result.',
  machine: MACHINE,
};

function lines(text: string): Record<string, unknown>[] {
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('the init allowlist', () => {
  it('keeps INIT_KEEP and drops INIT_DROP, and servers to their name and status', () => {
    const out = sanitizeRecording(input([init(), result()]), CONTEXT);
    const [kept] = lines(out.stream);
    for (const key of Object.keys(INIT_DROP)) expect(kept).not.toHaveProperty(key);
    for (const key of Object.keys(kept)) expect(INIT_KEEP).toContain(key);
    expect(kept.mcp_servers).toEqual([{ name: 'probe', status: 'connected' }]);
    expect(kept.tools).toContain('mcp__cerebro__get_note');
    expect(kept.claude_code_version).toBe('2.1.250');
  });

  it('refuses a key it neither keeps nor drops, by name', () => {
    expect(() => sanitizeRecording(input([init({ newly_added: 1 }), result()]), CONTEXT)).toThrow(
      /carries "newly_added"/,
    );
  });

  it.each([
    ['a foreign server', { mcp_servers: [{ name: 'claude.ai Gmail', status: 'connected' }] }],
    ['a foreign tool', { tools: ['Read', 'mcp__gmail__send'] }],
  ])('refuses %s: never an owner connector', (_what, extra) => {
    expect(() => sanitizeRecording(input([init(extra), result()]), CONTEXT)).toThrow(
      /servers other than probe and cerebro/,
    );
  });

  it('refuses another CLI version and any API-key source but none', () => {
    expect(() =>
      sanitizeRecording(input([init({ claude_code_version: '2.1.251' }), result()]), CONTEXT),
    ).toThrow(/not Claude Code 2\.1\.250/);
    for (const apiKeySource of ['ANTHROPIC_API_KEY', undefined]) {
      expect(() => sanitizeRecording(input([init({ apiKeySource }), result()]), CONTEXT)).toThrow(
        /API-key source/,
      );
    }
  });

  it("drops the owner's own listings from the control protocol and the session file", () => {
    const answer = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req_1',
        response: {
          models: [{ value: 'haiku' }],
          account: { email: 'x' },
          commands: [],
          agents: [],
        },
      },
    };
    const listing = { type: 'attachment', attachment: { type: 'skill_listing', content: 'mine' } };
    const out = sanitizeRecording(
      input(
        [init(), answer, result()],
        [
          listing,
          { type: 'attachment', attachment: { type: 'agent_listing_delta', addedLines: ['x'] } },
        ],
      ),
      { ...CONTEXT, transport: 'stream-json-input' },
    );
    const response = (lines(out.stream)[1].response as { response: Record<string, unknown> })
      .response;
    expect(Object.keys(response)).toEqual(['models']);
    for (const key of Object.keys(ANSWER_DROP)) expect(response).not.toHaveProperty(key);
    expect(lines(out.session ?? '').map((line) => line.attachment)).toEqual(
      Object.keys(LISTING_ATTACHMENTS).map((type) => ({ type })),
    );
  });
});

describe('what the sanitizer replaces', () => {
  it('writes literal and slug placeholders for this machine', () => {
    const out = sanitizeRecording(
      input(
        [init(), result({ result: `read ${MACHINE.repo}/notes and ${MACHINE.home}/x as tester` })],
        [
          {
            type: 'user',
            cwd: `${RECORD}/vault`,
            path: `-private-var-folders-ab-T-cerebro-cli-record-vault`,
          },
        ],
      ),
      CONTEXT,
    );
    expect(lines(out.stream)[0].cwd).toBe('/RECORD/vault');
    expect(lines(out.stream)[1].result).toBe('read /REPO/notes and ~/x as USER');
    expect(lines(out.session ?? '')[0]).toMatchObject({
      cwd: '/RECORD/vault',
      path: '-RECORD-vault',
    });
  });

  it('maps ids the same way across the stream, the session file and its name', () => {
    const out = sanitizeRecording(
      input(
        [
          init(),
          {
            type: 'assistant',
            message: { id: 'msg_01AbC', content: [{ type: 'tool_use', id: 'toolu_01XyZ' }] },
            session_id: SESSION,
          },
          result(),
        ],
        [
          {
            type: 'assistant',
            sessionId: SESSION,
            message: { id: 'msg_01AbC' },
            requestId: 'req_011CUi',
          },
        ],
      ),
      CONTEXT,
    );
    const [first, assistant] = lines(out.stream);
    const [line] = lines(out.session ?? '');
    expect(first.session_id).toBe('00000000-0000-4000-8000-000000000001');
    expect(line.sessionId).toBe(first.session_id);
    expect(out.meta.session).toBe('00000000-0000-4000-8000-000000000001.jsonl');
    expect((assistant.message as { id: string }).id).toBe((line.message as { id: string }).id);
    expect(line.requestId).toBe('req_000000000000000000000001');
  });

  it('replaces signatures with sig-<n>, the same signature the same way', () => {
    const sig = 'EqQBCkYIBxgCKkB'.repeat(4);
    const out = sanitizeRecording(
      input([
        init(),
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'signature_delta', signature: sig },
          },
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'Hmm.', signature: sig },
              { type: 'redacted_thinking', data: 'opaque' },
            ],
          },
        },
        result(),
      ]),
      CONTEXT,
    );
    const [, delta, assistant] = lines(out.stream);
    expect(delta).toMatchObject({ event: { delta: { signature: 'sig-1' } } });
    expect(assistant).toMatchObject({
      message: { content: [{ thinking: 'Hmm.', signature: 'sig-1' }, { data: 'sig-2' }] },
    });
  });

  it.each(SECRETS.map(({ kind }) => kind))('replaces a %s with its stand-in', (kind) => {
    const secret = FAKES[kind];
    const out = sanitizeRecording(
      input([init(), result({ result: `one ${secret} and again ${secret}` })]),
      CONTEXT,
    );
    const text = lines(out.stream)[1].result as string;
    expect(text).toBe(`one redacted-${kind}-1 and again redacted-${kind}-1`);
    expect(out.report).toContain(`  ${kind}: 1`);
  });

  it('has a fake of every secret shape', () => {
    expect(Object.keys(FAKES).sort()).toEqual(SECRETS.map(({ kind }) => kind).sort());
  });

  it('shifts every timestamp so the first is the epoch, and keeps the gaps', () => {
    const out = sanitizeRecording(
      input(
        [
          init(),
          { type: 'assistant', timestamp: '2026-10-14T13:01:33.177Z', message: { content: [] } },
          result(),
        ],
        [
          { type: 'user', timestamp: '2026-10-14T13:01:33.128Z' },
          { type: 'last', timestamp: '2026-10-14T13:02:33.128Z' },
        ],
      ),
      CONTEXT,
    );
    expect(lines(out.stream)[1].timestamp).toBe('2026-01-01T00:00:00.049Z');
    expect(lines(out.session ?? '').map((line) => line.timestamp)).toEqual([
      EPOCH,
      '2026-01-01T00:01:00.000Z',
    ]);
  });

  it('writes DEL as an escape, one line per event', () => {
    const text = jsonl([{ text: `a${String.fromCharCode(0x7f)}b` }, { n: 1 }]);
    expect(text).toBe('{"text":"a\\u007fb"}\n{"n":1}\n');
    expect(JSON.parse(text.split('\n')[0]).text).toBe(`a${String.fromCharCode(0x7f)}b`);
  });
});

describe('what refuses', () => {
  it('names a line that does not parse by its number', () => {
    expect(() =>
      sanitizeRecording({ stream: `${JSON.stringify(init())}\n{not json\n` }, CONTEXT),
    ).toThrow(/stream line 2 is not JSON/);
  });

  it('wants an init, and a run with no result to say how it ended', () => {
    expect(() => sanitizeRecording(input([result()]), CONTEXT)).toThrow(/no init/);
    expect(() => sanitizeRecording(input([init()]), CONTEXT)).toThrow(/--ends/);
    expect(() => sanitizeRecording(input([init()]), { ...CONTEXT, ends: 'result' })).toThrow(
      /has none/,
    );
    expect(sanitizeRecording(input([init()]), { ...CONTEXT, ends: 'killed' }).meta.ends).toBe(
      'killed',
    );
  });

  it('wants a name, a source and a sentence', () => {
    expect(() =>
      sanitizeRecording(input([init(), result()]), { ...CONTEXT, name: 'Toy Run' }),
    ).toThrow(Refusal);
    expect(() => sanitizeRecording(input([init(), result()]), { ...CONTEXT, proves: ' ' })).toThrow(
      Refusal,
    );
  });
});

describe('writing a recording', () => {
  const root = mkdtempSync(join(tmpdir(), 'sanitize-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('writes the stream, the session file and the meta', async () => {
    const out = join(root, 'real');
    const recording = sanitizeRecording(input([init(), result()], [{ type: 'user' }]), {
      ...CONTEXT,
      derivedFrom: ['the 2.1.250 bundle'],
    });
    const written = await writeRecording(recording, MACHINE, out);
    expect(written.map((path) => path.slice(out.length + 1))).toEqual([
      'toy-run.stream.jsonl',
      'toy-run.session.jsonl',
      'toy-run.meta.json',
    ]);
    expect(JSON.parse(readFileSync(join(out, 'toy-run.meta.json'), 'utf8'))).toEqual({
      format: 1,
      cli_version: '2.1.250',
      source: 'spike',
      recorded: 'derived',
      derived_from: ['the 2.1.250 bundle'],
      transport: 'per-turn',
      scenario: 'toy-run',
      proves: 'A toy run reaches its result.',
      ends: 'result',
      session: '00000000-0000-4000-8000-000000000001.jsonl',
      sanitizer: 1,
    });

    // Written again with no session file, the old one goes.
    await writeRecording(sanitizeRecording(input([init(), result()]), CONTEXT), MACHINE, out);
    expect(existsSync(join(out, 'toy-run.session.jsonl'))).toBe(false);
    expect(JSON.parse(readFileSync(join(out, 'toy-run.meta.json'), 'utf8')).recorded).toBe('live');
  });

  it('writes nothing past a leftover @, or a machine string', async () => {
    const out = join(root, 'refused');
    const leaky = sanitizeRecording(
      input([init(), result({ result: 'mail someone@example.org' })]),
      CONTEXT,
    );
    await expect(writeRecording(leaky, MACHINE, out)).rejects.toThrow(
      /an email or other @-address \(1\)/,
    );
    expect(existsSync(out)).toBe(false);
    expect(leaks('built on Tester-Mac by TESTER', MACHINE)).toEqual([
      "this machine's user (2)",
      "this machine's host (1)",
    ]);
  });

  it('reports counts only, never a value', () => {
    const recording = sanitizeRecording(
      input([init(), result({ result: `token ${FAKES.github}` })], [{ type: 'user', cwd: '/x' }]),
      CONTEXT,
    );
    const report = recording.report.join('\n');
    for (const value of [SESSION, FAKES.github, 'redacted-github-1', RECORD, '/RECORD', 'token']) {
      expect(report).not.toContain(value);
    }
    for (const line of recording.report) {
      expect(line).toMatch(/: (\d+( [a-z]+)*( line\(s\))?|none)$/);
    }
  });
});

describe('the corpus', () => {
  const root = mkdtempSync(join(tmpdir(), 'sanitize-corpus-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('names at least eight recordings, each from a scenario the driver runs', () => {
    expect(Object.keys(CORPUS).length).toBeGreaterThanOrEqual(8);
    const runs: Record<string, { turns: unknown[]; stream?: unknown }> = {
      ...SCENARIOS,
      ...SCRIPTED,
    };
    for (const [name, entry] of Object.entries(CORPUS)) {
      expect(name.startsWith(`${entry.source}-`), name).toBe(true);
      const scenario = runs[entry.scenario];
      expect(scenario, name).toBeDefined();
      expect(entry.step, name).toBeLessThan(scenario.stream ? 1 : scenario.turns.length);
    }
  });

  it('reads a raw run and its session file from the record folder', () => {
    const step = join(root, 'raw', 'defer-resume', '0');
    mkdirSync(join(root, 'raw', 'defer-resume'), { recursive: true });
    expect(corpusInput(root, CORPUS['spike-defer'])).toBeNull();
    writeFileSync(`${step}.stdout.jsonl`, `${JSON.stringify(init())}\n`);
    writeFileSync(`${step}.session.json`, JSON.stringify({ file: `${SESSION}.jsonl` }));
    writeFileSync(`${step}.session.jsonl`, '{"type":"user"}\n');
    const found = corpusInput(root, CORPUS['spike-defer']);
    expect(found?.session).toEqual({ name: `${SESSION}.jsonl`, text: '{"type":"user"}\n' });
    expect(initSession(found?.stream ?? '')).toBe(SESSION);
    expect(initSession('not json\n{"type":"result"}')).toBeNull();
  });

  it('reads --flag value pairs, a repeated flag kept in order', () => {
    expect(parseFlags(['--name', 'a', '--x', '1', '--x', '2'])).toEqual(
      new Map([
        ['name', ['a']],
        ['x', ['1', '2']],
      ]),
    );
    expect(() => parseFlags(['--name'])).toThrow(Refusal);
    expect(() => parseFlags(['name', 'a'])).toThrow(Refusal);
  });
});

describe('one session-history line (M56.4)', () => {
  /** A usage-limit line in the shape a session file holds one, with every
   * field a real one carries that the fixture must not. */
  const raw = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      parentUuid: SESSION,
      isSidechain: false,
      type: 'assistant',
      uuid: '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      timestamp: '2026-09-30T14:02:11.120Z',
      cwd: `${MACHINE.home}/notes`,
      gitBranch: 'main',
      sessionId: SESSION,
      requestId: shaped('req', '_01', 'AbCdEf'),
      userType: 'external',
      perTurnEffort: 'high',
      upgradePaths: ['max'],
      isApiErrorMessage: true,
      error: 'rate_limit',
      apiErrorStatus: 429,
      quotaLimits: {
        status: 'rejected',
        resetsAt: 1790000000,
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
        isUsingOverage: false,
        unifiedRateLimitFallbackAvailable: false,
      },
      message: {
        id: 'b1d0e2f3-0000-4a00-8000-aaaaaaaaaaaa',
        role: 'assistant',
        model: '<synthetic>',
        stop_reason: 'stop_sequence',
        usage: { input_tokens: 0 },
        content: [
          { type: 'text', text: "You've hit your session limit · resets 4pm (Europe/Rome)" },
        ],
      },
      version: '2.1.290',
      entrypoint: 'claude-vscode',
      ...over,
    });

  it('keeps what the classifier reads and drops the rest', () => {
    const { recorded, line } = sanitizeHistoryLine(raw());
    expect(recorded).toEqual({
      cli: '2.1.290',
      entrypoint: 'claude-vscode',
      from: 'owner session history, sanitized',
    });
    expect(Object.keys(line).sort()).toEqual(
      [
        'apiErrorStatus',
        'entrypoint',
        'error',
        'isApiErrorMessage',
        'message',
        'quotaLimits',
        'type',
        'uuid',
        'version',
      ].sort(),
    );
    expect(line.uuid).toBe('00000000-0000-4000-8000-000000000001');
    expect(line.quotaLimits).toEqual({
      status: 'rejected',
      resetsAt: HISTORY_RESET,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      isUsingOverage: false,
    });
    expect(line.message).toEqual({
      role: 'assistant',
      model: '<synthetic>',
      stop_reason: 'stop_sequence',
      content: [
        { type: 'text', text: "You've hit your session limit · resets Thu, Jan 1, 12am (UTC)" },
      ],
    });
    const text = JSON.stringify(line);
    for (const gone of [SESSION, MACHINE.home, 'gitBranch', 'timestamp', 'perTurnEffort']) {
      expect(text).not.toContain(gone);
    }
  });

  it('pins the reset clause wherever it sits', () => {
    expect(pinResetClause('limit reached · resets Oct 3, 9am (UTC) · upgrade')).toBe(
      'limit reached · resets Thu, Jan 1, 12am (UTC) · upgrade',
    );
    expect(pinResetClause('no clause here')).toBe('no clause here');
  });

  it('refuses a line that is not an API-error reply, or names no version', () => {
    expect(() => sanitizeHistoryLine(raw({ isApiErrorMessage: false }))).toThrow(Refusal);
    expect(() => sanitizeHistoryLine(raw({ type: 'user' }))).toThrow(Refusal);
    expect(() => sanitizeHistoryLine(raw({ version: undefined }))).toThrow(Refusal);
    expect(() => sanitizeHistoryLine('not json')).toThrow(Refusal);
  });

  it('writes nothing when what it would write leaks', async () => {
    const out = mkdtempSync(join(tmpdir(), 'history-line-'));
    try {
      const clean = sanitizeHistoryLine(raw());
      const path = await writeHistoryLine('usage-limit-5h', clean, MACHINE, out);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(clean);
      const leaky = {
        ...clean,
        line: { ...clean.line, message: { content: [{ type: 'text', text: MACHINE.gitEmail }] } },
      };
      await expect(writeHistoryLine('leaky', leaky, MACHINE, out)).rejects.toThrow(Refusal);
      expect(existsSync(join(out, 'leaky.json'))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
