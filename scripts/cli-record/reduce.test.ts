// @vitest-environment node
import { join } from 'node:path';
import { check, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';
import {
  applyPlaceholders,
  formatJson,
  IdMap,
  keepProbeEntry,
  keepSessionLine,
  keepStdinLine,
  keepStreamLine,
  placeholders,
  reduceScenario,
  slug,
  TEXT_LIMIT,
  type Machine,
  type RawScenario,
  type RawStep,
  type ReduceContext,
} from './reduce';
import { scan } from './scan';

const MACHINE: Machine = {
  recordDir: '/var/folders/ab/xyz/T/cerebro-cli-record',
  realRecordDir: '/private/var/folders/ab/xyz/T/cerebro-cli-record',
  repo: '/Users/someone/dev/cerebro',
  home: '/Users/someone',
  user: 'someone',
  host: 'Somebodys-Mac.local',
  gitName: 'Some One',
  gitEmail: 'some.one@example.com',
};

const context = (): ReduceContext => ({ ids: new IdMap(), sent: new Map() });
const UUID_A = '1B4E28BA-2FA1-41D2-883F-0016D3CCA427';
const UUID_B = '6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';

describe('IdMap', () => {
  it('gives each UUID one synthetic stand-in, whatever its case, numbered in hex', () => {
    const ids = new IdMap();
    expect(ids.id(UUID_A)).toBe('00000000-0000-4000-8000-000000000001');
    expect(ids.id(UUID_A.toLowerCase())).toBe('00000000-0000-4000-8000-000000000001');
    for (let n = 0; n < 9; n++) ids.id(`${UUID_B.slice(0, -1)}${n}`);
    expect(ids.id(UUID_B)).toBe('00000000-0000-4000-8000-00000000000b');
  });

  it('counts each id prefix on its own, zero-padded', () => {
    const ids = new IdMap();
    expect(ids.id('msg_01AbC')).toBe('msg_000000000000000000000001');
    expect(ids.id('toolu_01AbC')).toBe('toolu_000000000000000000000001');
    expect(ids.id('msg_01XyZ')).toBe('msg_000000000000000000000002');
    expect(ids.id('srvtoolu_01AbC')).toBe('srvtoolu_000000000000000000000001');
    expect(ids.id('req_011CU')).toBe('req_000000000000000000000001');
  });

  it('leaves its own stand-ins alone, so scrubbing twice changes nothing', () => {
    const ids = new IdMap();
    const once = ids.replaceIn(`${UUID_A} msg_01AbC in ${UUID_A}.jsonl`);
    expect(once).toBe(
      '00000000-0000-4000-8000-000000000001 msg_000000000000000000000001 in 00000000-0000-4000-8000-000000000001.jsonl',
    );
    expect(ids.replaceIn(once)).toBe(once);
  });

  it('turns any control request id into a req_ counter, and passes non-strings through', () => {
    const ids = new IdMap();
    expect(ids.request('abc123')).toBe('req_000000000000000000000001');
    expect(ids.request('abc123')).toBe('req_000000000000000000000001');
    expect(ids.request('req_000000000000000000000001')).toBe('req_000000000000000000000001');
    expect(ids.request(undefined)).toBeUndefined();
  });
});

describe('placeholders', () => {
  const pairs = placeholders(MACHINE);
  const scrub = (text: string) => applyPlaceholders(text, pairs);

  it('replaces the record folder, as given and as its realpath, and their slug forms', () => {
    expect(scrub(`${MACHINE.recordDir}/vault`)).toBe('/RECORD/vault');
    expect(scrub(`${MACHINE.realRecordDir}/vault/notes`)).toBe('/RECORD/vault/notes');
    expect(scrub(`projects/${slug(`${MACHINE.realRecordDir}/vault`)}/x.jsonl`)).toBe(
      'projects/-RECORD-vault/x.jsonl',
    );
  });

  it('replaces the repo, $HOME, the user, the host and git name and email, slugs included', () => {
    expect(scrub('/Users/someone/dev/cerebro/scripts/cli-record/probe.ts')).toBe(
      '/REPO/scripts/cli-record/probe.ts',
    );
    expect(scrub('-Users-someone-dev-cerebro')).toBe('-REPO');
    expect(scrub('/Users/someone/.claude')).toBe('~/.claude');
    expect(scrub('-Users-someone-x')).toBe('-HOME-x');
    expect(scrub('signed in as someone on Somebodys-Mac.local')).toBe('signed in as USER on HOST');
    expect(scrub('Somebodys-Mac and Somebodys-Mac-local')).toBe('HOST and HOST');
    expect(scrub('Some One <some.one@example.com>')).toBe('GIT_NAME <GIT_EMAIL>');
    expect(scrub('Some-One some-one-example-com')).toBe('GIT-NAME GIT-EMAIL');
  });

  it('replaces only where the value stands alone, longest first', () => {
    expect(scrub('someones and nosomeone stay')).toBe('someones and nosomeone stay');
    const lengths = pairs.map(([from]) => from.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  it('leaves a value under three characters alone', () => {
    expect(placeholders({ ...MACHINE, user: 'jo' }).some(([from]) => from === 'jo')).toBe(false);
  });
});

describe('the allowlist', () => {
  it('keeps init to its model, mode, version, key source, tools and servers', () => {
    const init = {
      type: 'system',
      subtype: 'init',
      uuid: 'u',
      session_id: 's',
      cwd: '/RECORD/vault',
      model: 'claude-haiku-4-5-20251001',
      permissionMode: 'acceptEdits',
      claude_code_version: '2.1.250',
      apiKeySource: 'none',
      tools: ['Read'],
      mcp_servers: [{ name: 'probe', status: 'connected', extra: 'x' }],
      slash_commands: ['compact'],
      memory_paths: { user: '~/.claude/CLAUDE.md' },
      plugins: [],
    };
    expect(keepStreamLine(init, context())).toEqual({
      type: 'system',
      subtype: 'init',
      uuid: 'u',
      session_id: 's',
      model: 'claude-haiku-4-5-20251001',
      permissionMode: 'acceptEdits',
      claude_code_version: '2.1.250',
      apiKeySource: 'none',
      tools: ['Read'],
      mcp_servers: [{ name: 'probe', status: 'connected' }],
    });
  });

  it('drops stream_event lines, thinking text and signatures', () => {
    expect(keepStreamLine({ type: 'stream_event', event: {} }, context())).toBeNull();
    const line = keepStreamLine(
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          model: 'm',
          stop_reason: null,
          container: null,
          content: [{ type: 'thinking', thinking: 'secret plan', signature: 'sig' }],
        },
      },
      context(),
    );
    expect(line).toEqual({
      type: 'assistant',
      message: { id: 'msg_1', model: 'm', stop_reason: null, content: [{ type: 'thinking' }] },
    });
  });

  it(`cuts every text at ${TEXT_LIMIT} characters, tool inputs and results included`, () => {
    const long = 'x'.repeat(TEXT_LIMIT + 50);
    const line = keepStreamLine(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: long },
            { type: 'tool_result', tool_use_id: 't', is_error: true, content: long },
            { type: 'tool_use', id: 't', name: 'Write', input: { content: long } },
          ],
        },
      },
      context(),
    );
    const content = (line?.message as { content: Record<string, unknown>[] }).content;
    expect(content[0].text).toHaveLength(TEXT_LIMIT);
    expect(content[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 't',
      is_error: true,
      content: 'x'.repeat(TEXT_LIMIT),
    });
    expect((content[2].input as { content: string }).content).toHaveLength(TEXT_LIMIT);
  });

  it('keeps a result to its counts, reasons, usage numbers and denials', () => {
    const result = keepStreamLine(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 812,
        num_turns: 1,
        result: 'ok',
        stop_reason: 'tool_deferred',
        terminal_reason: 'tool_deferred',
        deferred_tool_use: { id: 't', name: 'n', input: {}, extra: 1 },
        permission_denials: [{ tool_name: 'Write', tool_use_id: 't', tool_input: {}, x: 1 }],
        usage: {
          input_tokens: 3,
          service_tier: 'standard',
          cache_creation: { ephemeral_1h_input_tokens: 9 },
        },
        modelUsage: { haiku: { inputTokens: 3, costUSD: 0.1, name: 'x' } },
        fast_mode_state: 'off',
        subagent_stats: { spawned: 0 },
      },
      context(),
    );
    expect(result).toEqual({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      result: 'ok',
      stop_reason: 'tool_deferred',
      terminal_reason: 'tool_deferred',
      deferred_tool_use: { id: 't', name: 'n', input: {} },
      permission_denials: [{ tool_name: 'Write', tool_use_id: 't', tool_input: {} }],
      usage: { input_tokens: 3, cache_creation: { ephemeral_1h_input_tokens: 9 } },
      modelUsage: { haiku: { inputTokens: 3, costUSD: 0.1 } },
    });
  });

  it('keeps the control protocol to subtypes and payloads, and drops account fields', () => {
    const ctx = context();
    expect(
      keepStdinLine(
        {
          type: 'control_request',
          request_id: 'req_1',
          request: { subtype: 'initialize', hooks: {} },
        },
        ctx,
      ),
    ).toEqual({
      type: 'control_request',
      request_id: 'req_000000000000000000000001',
      request: { subtype: 'initialize' },
    });
    const answer = keepStreamLine(
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req_1',
          response: {
            commands: [{ name: 'compact', description: 'd', argumentHint: '' }],
            agents: [{ name: 'Explore', description: 'd' }],
            models: [
              {
                value: 'sonnet',
                displayName: 'Sonnet',
                description: 'd',
                supportedEffortLevels: ['low'],
              },
            ],
            account: { email: 'someone@example.com', subscriptionType: 'max' },
            current_model: 'claude-haiku-4-5-20251001',
            pid: 4242,
          },
        },
      },
      ctx,
    );
    expect(answer).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req_000000000000000000000001',
        response: {
          current_model: 'claude-haiku-4-5-20251001',
          commands: ['compact'],
          agents: ['Explore'],
          models: [{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['low'] }],
        },
      },
    });
    const ask = keepStreamLine(
      {
        type: 'control_request',
        request_id: 'odd-id',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Write',
          input: { file_path: 'a' },
          tool_use_id: 't',
          permission_suggestions: [{ rules: ['/RECORD'] }],
          blocked_path: '/RECORD/x',
        },
      },
      ctx,
    );
    expect(ask).toEqual({
      type: 'control_request',
      request_id: 'req_000000000000000000000002',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Write',
        input: { file_path: 'a' },
        tool_use_id: 't',
      },
    });
  });

  it('keeps mcp_status, interrupt and other answers to their plain fields', () => {
    const ctx = context();
    const send = (subtype: string, id: string) =>
      keepStdinLine({ type: 'control_request', request_id: id, request: { subtype } }, ctx);
    send('mcp_status', 'req_1');
    send('interrupt', 'req_2');
    send('set_model', 'req_3');
    const answer = (id: string, response: unknown) =>
      (
        keepStreamLine(
          { type: 'control_response', response: { subtype: 'success', request_id: id, response } },
          ctx,
        )?.response as { response: unknown }
      ).response;
    expect(
      answer('req_1', { mcpServers: [{ name: 'probe', status: 'connected', serverInfo: {} }] }),
    ).toEqual({
      mcpServers: [{ name: 'probe', status: 'connected' }],
    });
    expect(answer('req_2', { still_queued: [], other: 1 })).toEqual({ still_queued: [] });
    expect(answer('req_3', { model: 'sonnet', nested: { a: 1 } })).toEqual({ model: 'sonnet' });
  });

  it('keeps a rate-limit event to its status, and any other line to its kind', () => {
    expect(
      keepStreamLine(
        {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1 },
        },
        context(),
      ),
    ).toEqual({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' },
    });
    expect(keepStreamLine({ type: 'prompt_suggestion', suggestion: 'x' }, context())).toEqual({
      type: 'prompt_suggestion',
    });
    expect(keepStreamLine(null, context())).toEqual({ unparsed: true });
  });

  it('keeps a session line to its ids, kinds, entrypoint, version, effort and message', () => {
    const line = keepSessionLine({
      type: 'assistant',
      uuid: 'u',
      parentUuid: null,
      sessionId: 's',
      cwd: '/RECORD/vault',
      gitBranch: 'main',
      timestamp: '2026-10-14T06:01:00.000Z',
      userType: 'external',
      entrypoint: 'sdk-cli',
      version: '2.1.250',
      effort: 'low',
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        id: 'm',
        model: 'x',
        content: [{ type: 'text', text: 'hi' }],
        usage: { output_tokens: 1 },
      },
    });
    expect(line).toEqual({
      type: 'assistant',
      uuid: 'u',
      parentUuid: null,
      sessionId: 's',
      isApiErrorMessage: true,
      entrypoint: 'sdk-cli',
      version: '2.1.250',
      effort: 'low',
      message: {
        role: 'assistant',
        id: 'm',
        model: 'x',
        content: [{ type: 'text', text: 'hi' }],
        usage: { output_tokens: 1 },
      },
    });
    expect(
      keepSessionLine({ type: 'attachment', attachment: { type: 'skill_listing', content: 'x' } }),
    ).toEqual({
      type: 'attachment',
      attachment: { type: 'skill_listing' },
    });
  });

  it("keeps the probe's log to what it was asked and said, without paths", () => {
    expect(
      keepProbeEntry({
        mode: 'hook',
        input: {
          hook_event_name: 'PreToolUse',
          tool_name: 't',
          tool_use_id: 'x',
          transcript_path: '/RECORD/a',
          cwd: '/RECORD',
        },
        answer: { hookSpecificOutput: { permissionDecision: 'defer' } },
      }),
    ).toEqual({
      mode: 'hook',
      input: { hook_event_name: 'PreToolUse', tool_name: 't', tool_use_id: 'x' },
      answer: { hookSpecificOutput: { permissionDecision: 'defer' } },
    });
  });

  it("keeps the gate's log to the call the hook handed it and its answer (M57.1)", () => {
    expect(
      keepProbeEntry({
        mode: 'gate',
        arguments: {
          session_id: 's',
          tool_use_id: 'toolu_1',
          tool_name: 'mcp__probe__slow_echo',
          tool_input: '{"text":"alpha"}',
          agent_id: '',
          transcript_path: '/RECORD/a',
        },
        answer: { content: [{ type: 'text', text: '{}' }] },
      }),
    ).toEqual({
      mode: 'gate',
      arguments: {
        session_id: 's',
        tool_use_id: 'toolu_1',
        tool_name: 'mcp__probe__slow_echo',
        tool_input: '{"text":"alpha"}',
        agent_id: '',
      },
      answer: { content: [{ type: 'text', text: '{}' }] },
    });
  });
});

function rawStep(overrides: Partial<RawStep> = {}): RawStep {
  return {
    argv: [],
    stdout: [],
    stdin: [],
    stderr: '',
    exit: { code: 0, signal: null },
    session: { file: null, files: [], lines: [] },
    probe: [],
    ...overrides,
  };
}

const INIT = (session: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: session,
    claude_code_version: '2.1.250',
    apiKeySource: 'none',
    mcp_servers: [{ name: 'probe', status: 'connected' }],
    ...extra,
  });

describe('reduceScenario', () => {
  const session = UUID_B;
  const raw: RawScenario = {
    cli_version: '2.1.250',
    scenario: 'demo',
    steps: [
      rawStep({
        argv: [
          '-p',
          'hi',
          '--mcp-config',
          `${MACHINE.recordDir}/probe/mcp-config.json`,
          '--session-id',
          session,
        ],
        stdout: [
          INIT(session),
          JSON.stringify({
            type: 'assistant',
            session_id: session,
            message: {
              id: 'msg_01AbC',
              content: [{ type: 'tool_use', id: 'toolu_01Xy', name: 'n', input: {} }],
            },
          }),
        ],
        stderr: `warning in ${MACHINE.realRecordDir}/claude-config`,
        session: {
          file: `${session}.jsonl`,
          files: [`${session}.jsonl`],
          lines: [
            JSON.stringify({
              type: 'user',
              sessionId: session,
              cwd: `${MACHINE.realRecordDir}/vault`,
            }),
          ],
        },
        probe: [
          JSON.stringify({
            mode: 'hook',
            input: {
              session_id: session,
              tool_use_id: 'toolu_01Xy',
              transcript_path: `${MACHINE.recordDir}/x/${session}.jsonl`,
            },
            answer: {},
          }),
        ],
      }),
    ],
  };

  it('maps one id the same in argv, stream, session file, its name and the probe log', () => {
    const [step] = reduceScenario(raw, MACHINE).steps;
    const id = '00000000-0000-4000-8000-000000000001';
    expect(step.argv.at(-1)).toBe(id);
    expect(step.stream[0].session_id).toBe(id);
    expect(step.session.file).toBe(`${id}.jsonl`);
    expect(step.session.lines[0].sessionId).toBe(id);
    expect((step.probe[0].input as { session_id: string }).session_id).toBe(id);
    const call = (step.stream[1].message as { content: { id: string }[] }).content[0].id;
    expect(call).toBe('toolu_000000000000000000000001');
    expect((step.probe[0].input as { tool_use_id: string }).tool_use_id).toBe(call);
  });

  it('writes placeholders for every machine path, and says it was recorded', async () => {
    const fixture = reduceScenario(raw, MACHINE);
    expect(fixture.source).toBe('recorded');
    expect(fixture.steps[0].argv[3]).toBe('/RECORD/probe/mcp-config.json');
    expect(fixture.steps[0].stderr).toBe('warning in /RECORD/claude-config');
    expect(scan(await formatJson(fixture))).toEqual([]);
  });

  it('writes the placeholder for a record folder whose path holds an id, and keeps the ids in order', async () => {
    const scratch = `/private/tmp/claude-501/-Users-someone/${UUID_A}/scratchpad/msg_01Ab/rec`;
    const machine: Machine = { ...MACHINE, recordDir: scratch, realRecordDir: undefined };
    const inScratch: RawScenario = {
      ...raw,
      steps: [
        rawStep({
          argv: [
            '-p',
            'hi',
            '--mcp-config',
            `${scratch}/probe/mcp-config.json`,
            '--session-id',
            session,
          ],
          stdout: [
            INIT(session),
            JSON.stringify({
              type: 'assistant',
              session_id: session,
              message: {
                id: 'msg_01AbC',
                content: [
                  {
                    type: 'tool_use',
                    id: 'toolu_01Xy',
                    name: 'Write',
                    input: { file_path: `${scratch}/vault/notes/gamma.md` },
                  },
                ],
              },
            }),
          ],
          stderr: `warning in ${scratch}/claude-config`,
        }),
      ],
    };
    const fixture = reduceScenario(inScratch, machine);
    const [step] = fixture.steps;
    expect(step.argv[3]).toBe('/RECORD/probe/mcp-config.json');
    expect(step.argv.at(-1)).toBe('00000000-0000-4000-8000-000000000001');
    expect(step.stderr).toBe('warning in /RECORD/claude-config');
    const [call] = (step.stream[1].message as { content: { input: { file_path: string } }[] })
      .content;
    expect(call.input.file_path).toBe('/RECORD/vault/notes/gamma.md');
    expect((step.stream[1].message as { id: string }).id).toBe('msg_000000000000000000000001');
    expect(scan(await formatJson(fixture))).toEqual([]);
  });

  it('leaves the scan a hit to refuse when kept text still carries one', async () => {
    const leaky: RawScenario = {
      ...raw,
      steps: [
        rawStep({
          stdout: [
            INIT(session),
            JSON.stringify({
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'mail me at a@b.example' }] },
            }),
          ],
        }),
      ],
    };
    expect(scan(await formatJson(reduceScenario(leaky, MACHINE)))).toEqual([
      expect.stringMatching(/^an email or other @-address: a@b\.example/),
    ]);
  });

  it.each([
    ['another CLI version', { ...raw, cli_version: '2.1.251' }],
    [
      'an init from another CLI version',
      { ...raw, steps: [rawStep({ stdout: [INIT(session, { claude_code_version: '2.1.249' })] })] },
    ],
    [
      'an API-key source',
      {
        ...raw,
        steps: [rawStep({ stdout: [INIT(session, { apiKeySource: 'ANTHROPIC_API_KEY' })] })],
      },
    ],
    [
      'a server other than the toys',
      {
        ...raw,
        steps: [
          rawStep({
            stdout: [INIT(session, { mcp_servers: [{ name: 'gmail', status: 'connected' }] })],
          }),
        ],
      },
    ],
  ])('refuses a recording with %s', (_what, scenario) => {
    expect(() => reduceScenario(scenario as RawScenario, MACHINE)).toThrow(
      /Refusing to reduce demo/,
    );
  });
});

describe('formatJson', () => {
  it("is prettier's own output under the repo config", async () => {
    const text = await formatJson({ a: [1, 2], b: { c: 'd' }, e: [{ f: null }] });
    const filepath = join(__dirname, '../../src-tauri/fixtures/cli-stream/spike/x.json');
    const config = (await resolveConfig(filepath)) ?? {};
    expect(await check(text, { ...config, filepath, parser: 'json' })).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
  });
});
