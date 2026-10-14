// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, handleRpc, hookAnswer, TOOLS, type ProbeIo } from './probe';

const PROBE = join(__dirname, 'probe.ts');

function fakeIo(decisions: Record<string, unknown> = {}) {
  const logged: Record<string, unknown>[] = [];
  const slept: number[] = [];
  const io: ProbeIo = {
    decisions: () => decisions,
    log: (entry) => void logged.push(entry),
    sleep: async (ms) => void slept.push(ms),
  };
  return { io, logged, slept };
}

const call = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, arguments: args },
});

function textOf(reply: unknown): string {
  const result = (reply as { result: { content: { text: string }[] } }).result;
  return result.content[0].text;
}

describe('handleRpc', () => {
  it('echoes the protocol version on initialize, as the server named probe', async () => {
    const reply = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      fakeIo().io,
    );
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '1.0.0' },
      },
    });
  });

  it('answers ping, and gives a notification no reply', async () => {
    const { io } = fakeIo();
    expect(await handleRpc({ jsonrpc: '2.0', id: 2, method: 'ping' }, io)).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: {},
    });
    expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, io)).toBeNull();
  });

  it('lists slow_echo and approve, both loaded with the run', async () => {
    const reply = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, fakeIo().io);
    const tools = (reply?.result as { tools: typeof TOOLS }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(['slow_echo', 'approve']);
    for (const tool of tools) expect(tool._meta).toEqual({ 'anthropic/alwaysLoad': true });
  });

  it('returns slow_echo text after waiting its seconds', async () => {
    const { io, slept } = fakeIo();
    expect(textOf(await handleRpc(call('slow_echo', { text: 'hi', seconds: 0 }), io))).toBe('hi');
    await handleRpc(call('slow_echo', { text: 'later', seconds: 2 }), io);
    expect(slept).toEqual([0, 2000]);
  });

  it('refuses a slow_echo past 60 seconds or without a text', async () => {
    const { io, slept } = fakeIo();
    for (const args of [{ text: 'x', seconds: 61 }, { seconds: 1 }]) {
      const reply = await handleRpc(call('slow_echo', args), io);
      expect((reply?.result as { isError?: boolean }).isError).toBe(true);
    }
    expect(slept).toEqual([]);
  });

  it("logs what approve was asked and answers that tool's decision, deny by default", async () => {
    const { io, logged } = fakeIo({ Write: { behavior: 'deny', message: 'Not now.' } });
    const asked = { tool_name: 'Write', input: { file_path: 'a.md' }, tool_use_id: 'toolu_1' };
    const denied = JSON.parse(textOf(await handleRpc(call('approve', asked), io)));
    expect(denied).toEqual({ behavior: 'deny', message: 'Not now.' });
    expect(logged).toEqual([{ mode: 'approve', ...asked, answer: denied }]);
    const unknown = { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_2' };
    const fallback = JSON.parse(textOf(await handleRpc(call('approve', unknown), io)));
    expect(fallback).toEqual({
      behavior: 'deny',
      message: 'The probe holds no decision for Bash, so it denies.',
    });
  });

  it('answers an unknown tool with an error result', async () => {
    const reply = await handleRpc(call('nope', {}), fakeIo().io);
    expect((reply?.result as { isError?: boolean }).isError).toBe(true);
  });

  it('gets -32601 for an unknown method and -32600 for a request without one', async () => {
    const { io } = fakeIo();
    expect(await handleRpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, io)).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32601, message: 'Method not found: resources/list' },
    });
    expect((await handleRpc({ jsonrpc: '2.0', id: 5 }, io))?.error?.code).toBe(-32600);
    expect(await handleRpc('not json-rpc', io)).toBeNull();
  });
});

describe('decide', () => {
  it('patches the input on allow', () => {
    expect(
      decide(
        'Write',
        { file_path: 'a.md', content: 'x' },
        {
          Write: { behavior: 'allow', updatedInput: { file_path: 'b.md' } },
        },
      ),
    ).toEqual({ behavior: 'allow', updatedInput: { file_path: 'b.md', content: 'x' } });
  });

  it("answers every AskUserQuestion question with the decision's label", () => {
    const questions = [{ question: 'Which color?' }, { question: 'Which size?' }];
    expect(
      decide(
        'AskUserQuestion',
        { questions },
        {
          AskUserQuestion: { behavior: 'allow', answer: 'Blue' },
        },
      ),
    ).toEqual({
      behavior: 'allow',
      updatedInput: { questions, answers: { 'Which color?': 'Blue', 'Which size?': 'Blue' } },
    });
  });
});

describe('hookAnswer', () => {
  it('allows what it holds no decision for', () => {
    expect(hookAnswer({ tool_name: 'mcp__probe__slow_echo' }, {})).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'The probe answers allow.',
      },
    });
  });

  it('answers the decided word and reason, and allows a word it does not know', () => {
    const decisions = {
      a: { permissionDecision: 'defer', permissionDecisionReason: 'Waiting.' },
      b: { permissionDecision: 'maybe' },
    };
    expect(hookAnswer({ tool_name: 'a' }, decisions).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'defer',
      permissionDecisionReason: 'Waiting.',
    });
    expect(hookAnswer({ tool_name: 'b' }, decisions)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
    expect(hookAnswer(null, decisions)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
  });
});

describe('probe.ts under plain node', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'probe-test-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prints the hook decision JSON and logs the input, allow by default', () => {
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'x' });
    const out = execFileSync(process.execPath, [PROBE, 'hook', '--dir', dir], { input });
    expect(JSON.parse(out.toString())).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
    writeFileSync(
      join(dir, 'hook-decisions.json'),
      JSON.stringify({ x: { permissionDecision: 'deny', permissionDecisionReason: 'No.' } }),
    );
    const denied = execFileSync(process.execPath, [PROBE, 'hook', '--dir', dir], { input });
    expect(JSON.parse(denied.toString()).hookSpecificOutput.permissionDecision).toBe('deny');
    const log = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n');
    expect(log.map((line) => JSON.parse(line).mode)).toEqual(['hook', 'hook']);
  });

  it('serves newline-delimited JSON-RPC on stdio', () => {
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      call('slow_echo', { text: 'pong', seconds: 0 }),
    ];
    const out = execFileSync(process.execPath, [PROBE, 'server', '--dir', dir], {
      input: `${lines.map((line) => JSON.stringify(line)).join('\n')}\nnot json\n`,
    });
    const replies = out
      .toString()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(new Set(replies.map((reply) => reply.id))).toEqual(new Set([1, 7, null]));
    expect(replies.find((reply) => reply.id === 7).result.content[0].text).toBe('pong');
    expect(replies.find((reply) => reply.id === null).error.code).toBe(-32700);
  });

  it('refuses to start without a mode and a folder', () => {
    const run = spawnSync(process.execPath, [PROBE, 'serve'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('usage');
  });
});
