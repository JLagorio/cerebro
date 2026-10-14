import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEvent, endLiveTurn, healFromTranscript, replayTranscript } from '@/agent/transcript';
import type { AgentStreamEvent, ChatMessage } from '@/agent/types';

/**
 * The one reducer (M56.3, CV-27). The goldens are Rust's: fold.rs writes
 * conformance/transcript/<case>.json from the recorded streams and session
 * files, and this replays them, so the fold and the reducer are held to each
 * other on the same bytes.
 */

const GOLDENS = join(__dirname, '../../conformance/transcript');

interface Golden {
  case: string;
  cli_version: string;
  streams: { file: string; events: AgentStreamEvent[] }[];
  session: { file: string; events: AgentStreamEvent[] } | null;
}

const goldens: Golden[] = readdirSync(GOLDENS)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(GOLDENS, name), 'utf8')) as Golden);

const bubble = (): ChatMessage => ({
  id: 'a',
  role: 'assistant',
  text: '',
  tools: [],
  streaming: true,
});

/** One stream reduced the way useAgentChat reduces a live turn. */
function live(events: AgentStreamEvent[]): ChatMessage {
  let message = bubble();
  for (const event of events) {
    if (event.kind === 'Done') message = endLiveTurn(message);
    else message = applyEvent(message, event, 'live');
  }
  return endLiveTurn(message);
}

/** What a turn shows, for comparing a live turn with its replay. */
function shown(message: ChatMessage) {
  return {
    text: message.text,
    tools: message.tools,
    error: message.error,
    interrupted: message.interrupted === true,
  };
}

describe('the transcript goldens', () => {
  it('are all here, each naming the CLI it was folded from', () => {
    expect(goldens.map((g) => g.case)).toEqual([
      'api-error',
      'deferred',
      'interrupted',
      'long-payload',
      'session-records',
      'two-turns',
    ]);
    for (const golden of goldens) expect(golden.cli_version).toBe('2.1.250');
  });

  it.each(goldens.map((g) => [g.case, g] as const))(
    'replays the transcript goldens: %s',
    (_, g) => {
      if (g.session === null) return;
      const replayed = replayTranscript(g.session.events, 'S');
      const prompts = g.session.events.filter((e) => e.kind === 'UserPrompt').length;
      expect(replayed.messages.filter((m) => m.role === 'user')).toHaveLength(prompts);
      const assistants = replayed.messages.filter((m) => m.role === 'assistant');
      expect(assistants.every((m) => m.live === undefined && m.streaming === undefined)).toBe(true);
      const skip = assistants.length - g.streams.length;
      g.streams.forEach((stream, at) => {
        const watched = live(stream.events);
        const restored = assistants[skip + at];
        const label = `${g.case} turn ${skip + at + 1}`;
        if (restored.model !== undefined) expect(watched.model, label).toBe(restored.model);
        if (watched.interrupted === true || restored.interrupted === true) {
          // A cut-off turn: the calls it started, and that it never ended.
          expect(
            watched.tools.map((t) => t.id),
            label,
          ).toEqual(restored.tools.map((t) => t.id));
          expect(watched.interrupted, label).toBe(restored.interrupted);
          return;
        }
        expect(shown(watched), label).toEqual(shown(restored));
      });
    },
  );

  it('rebuilds the two-turn thread, Read cards and all', () => {
    const golden = goldens.find((g) => g.case === 'two-turns');
    const { messages, model } = replayTranscript(golden?.session?.events ?? [], 'S');
    expect(messages.map((m) => [m.id, m.role, m.text])).toEqual([
      ['S-t1-u', 'user', expect.stringContaining('Read a.md and b.md')],
      ['S-t1-a', 'assistant', 'done'],
      ['S-t2-u', 'user', 'Now answer with the two words all done.'],
      ['S-t2-a', 'assistant', 'all done'],
    ]);
    expect(messages[1].tools.map((t) => [t.name, t.done, t.failed])).toEqual([
      ['Read', true, false],
      ['Read', true, false],
    ]);
    expect(model).toBe('claude-haiku-4-5-20251001');
  });

  it('rebuilds the long-payload thread with each cut part whole (M56.8)', () => {
    const golden = goldens.find((g) => g.case === 'long-payload');
    const { messages } = replayTranscript(golden?.session?.events ?? [], 'S');
    const [read, write] = messages[1].tools;
    expect(read.name).toBe('mcp__cerebro__get_note');
    expect(read.output?.endsWith('…')).toBe(true);
    expect(read.payload).toMatchObject({ outputBytes: 3000, outputTruncated: false });
    expect(read.payload?.output).toHaveLength(3000);
    expect(read.payload?.input).toBeUndefined();
    expect(write.name).toBe('mcp__cerebro__write_concept');
    const body = (JSON.parse(write.payload?.input ?? '{}') as { body: string }).body;
    expect(body).toHaveLength(400);
    expect(write.payload?.output).toBeUndefined();
  });

  it('collects the pr link and reads the interrupted turns of the session records', () => {
    const golden = goldens.find((g) => g.case === 'session-records');
    const { messages, prLinks } = replayTranscript(golden?.session?.events ?? [], 'S');
    expect(prLinks).toEqual([
      { number: 7, url: 'https://github.com/example/notes/pull/7', repository: 'example/notes' },
    ]);
    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants.map((m) => m.interrupted === true)).toEqual([false, true, false, true]);
  });
});

describe('applyEvent', () => {
  const text = (message_id: string, value: string): AgentStreamEvent => ({
    kind: 'Text',
    message_id,
    text: value,
  });
  const run = (events: AgentStreamEvent[], mode: 'live' | 'replay') =>
    events.reduce((m, e) => applyEvent(m, e, mode), bubble());

  it('ends on the last message’s text, not the narration before it', () => {
    const events: AgentStreamEvent[] = [
      text('m1', 'Reading both notes.'),
      text('m2', 'done'),
      { kind: 'TurnEnded', stop_reason: 'end_turn' },
    ];
    expect(run(events, 'replay').text).toBe('done');
    expect(run(events, 'live').text).toBe('done');
  });

  it('never doubles what the deltas already streamed', () => {
    const streamed = run(
      [{ kind: 'TextDelta', text: 'hel' }, { kind: 'TextDelta', text: 'lo' }, text('m1', 'hello')],
      'live',
    );
    expect(streamed.text).toBe('hello');
    expect(applyEvent(streamed, { kind: 'TurnEnded' }, 'live').text).toBe('hello');
    // Two text blocks of one message are one reply.
    expect(run([text('m1', 'one'), text('m1', 'two'), { kind: 'TurnEnded' }], 'replay').text).toBe(
      'one\n\ntwo',
    );
  });

  it('falls back to the result when no Text arrived', () => {
    const fallback = run(
      [
        { kind: 'TextDelta', text: 'partial' },
        { kind: 'Result', text: 'the whole answer' },
      ],
      'live',
    );
    expect(fallback.text).toBe('the whole answer');
    const empty = run(
      [
        { kind: 'TextDelta', text: 'kept' },
        { kind: 'Result', text: '  ' },
      ],
      'live',
    );
    expect(empty.text).toBe('kept');
  });

  it('keeps all of a cut-off turn’s text, and reads it interrupted', () => {
    const cut = run(
      [text('m1', 'Looking.'), text('m2', 'Half'), { kind: 'TurnInterrupted', reason: 'cut_off' }],
      'replay',
    );
    expect(cut.text).toBe('Looking.\n\nHalf');
    expect(cut.interrupted).toBe(true);
    // Live, a turn whose run ended without a word of its end reads the same.
    expect(endLiveTurn(run([{ kind: 'TextDelta', text: 'Hal' }], 'live')).interrupted).toBe(true);
    expect(endLiveTurn(run([{ kind: 'TurnEnded' }], 'live')).interrupted).toBeUndefined();
  });

  it('names the model and the error', () => {
    const m = run(
      [
        { kind: 'ModelChanged', model: 'claude-haiku-4-5-20251001' },
        { kind: 'Error', message: 'API Error', code: 'rate_limit' },
      ],
      'live',
    );
    expect(m.model).toBe('claude-haiku-4-5-20251001');
    expect(m.error).toBe('API Error');
    // One without a notice keeps today's shape: no notice key at all.
    expect('notice' in m).toBe(false);
  });

  // M56.4: the notice Rust typed lands on the message beside the raw words.
  it('carries an error notice onto the message', () => {
    const notice = {
      kind: 'usage_limit',
      title: "You've reached your Claude usage limit",
      body: 'Claude Code stopped because your weekly limit is used up. Background work waits until then.',
      action: null,
      resets_at: '2026-01-01T00:00:00Z',
      window: 'weekly',
      cli_version: '2.1.250',
    };
    for (const mode of ['live', 'replay'] as const) {
      const m = run([{ kind: 'Error', message: 'raw words', code: 'rate_limit', notice }], mode);
      expect(m.error).toBe('raw words');
      expect(m.notice).toEqual(notice);
    }
    const bare = run([{ kind: 'Error', message: 'raw', notice: null }], 'live');
    expect('notice' in bare).toBe(false);
  });

  it('replays the api-error golden onto a message with its notice', () => {
    const golden = goldens.find((g) => g.case === 'api-error');
    expect(golden).toBeDefined();
    const replayed = replayTranscript(golden?.session?.events ?? [], 's');
    const failed = replayed.messages.find((m) => m.error !== undefined);
    expect(failed?.notice?.title).toBe('Claude is limiting requests');
    expect(failed?.notice?.cli_version).toBe('2.1.250');
  });

  it('keeps a redelivered tool finished (M15, PR #7)', () => {
    const start: AgentStreamEvent = {
      kind: 'ToolStart',
      tool_name: 'Read',
      tool_id: 't-1',
      input: 'a.md',
    };
    const m = run([start, { kind: 'ToolDone', tool_id: 't-1', output: 'contents' }, start], 'live');
    expect(m.tools).toEqual([
      { id: 't-1', name: 'Read', input: 'a.md', output: 'contents', done: true, failed: false },
    ]);
  });

  it('lands a ToolPayload on its tool by id, live and replayed (M56.8)', () => {
    const start = (id: string): AgentStreamEvent => ({
      kind: 'ToolStart',
      tool_name: 'mcp__cerebro__get_note',
      tool_id: id,
      input: '{"path":"a.md"}',
    });
    const events: AgentStreamEvent[] = [
      start('t-1'),
      start('t-2'),
      { kind: 'ToolDone', tool_id: 't-2', output: 'cut…' },
      {
        kind: 'ToolPayload',
        tool_id: 't-2',
        part: 'output',
        text: 'the whole',
        bytes: 9,
        truncated: false,
      },
      {
        kind: 'ToolPayload',
        tool_id: 't-2',
        part: 'input',
        text: '{"path":"a.md","body":"long"}',
        bytes: 400_000,
        truncated: true,
      },
    ];
    for (const mode of ['live', 'replay'] as const) {
      const m = run(events, mode);
      expect(m.tools[0].payload, mode).toBeUndefined();
      expect(m.tools[1].output, mode).toBe('cut…');
      expect(m.tools[1].payload, mode).toEqual({
        output: 'the whole',
        outputBytes: 9,
        outputTruncated: false,
        input: '{"path":"a.md","body":"long"}',
        inputBytes: 400_000,
        inputTruncated: true,
      });
    }
    // A payload for a tool the message does not hold changes no row.
    const lone = run(
      [
        {
          kind: 'ToolPayload',
          tool_id: 'x',
          part: 'output',
          text: 't',
          bytes: 1,
          truncated: false,
        },
      ],
      'live',
    );
    expect(lone.tools).toEqual([]);
  });

  it('marks a deferred call, and Done after it never reads interrupted (M57.1)', () => {
    let message = applyEvent(
      bubble(),
      { kind: 'ToolStart', tool_name: 'mcp__cerebro__append_to_note', tool_id: 't1', input: '{}' },
      'live',
    );
    message = applyEvent(
      message,
      { kind: 'ToolDeferred', tool_id: 't1', tool_name: 'mcp__cerebro__append_to_note' },
      'live',
    );
    expect(message.tools[0]).toMatchObject({ id: 't1', deferred: true, done: false });
    const ended = endLiveTurn(message);
    expect(ended.streaming).toBe(false);
    expect(ended.interrupted).toBeUndefined();
    // Answered: the resumed result lands on the same row, by id.
    const resumed = applyEvent(
      message,
      { kind: 'ToolDone', tool_id: 't1', output: 'Appended to a.md' },
      'live',
    );
    expect(resumed.tools[0]).toMatchObject({ done: true, deferred: true });
    // A deferral read without its start still gets a row.
    const lone = applyEvent(bubble(), { kind: 'ToolDeferred', tool_id: 't9', tool_name: 'Bash' }, 'live');
    expect(lone.tools).toEqual([
      { id: 't9', name: 'Bash', input: null, output: null, done: false, failed: false, deferred: true },
    ]);
  });

  it('marks a waiting call cancelled when the person stops the turn (M57.1)', () => {
    let message = applyEvent(
      bubble(),
      { kind: 'ToolDeferred', tool_id: 't1', tool_name: 'Bash' },
      'live',
    );
    message = applyEvent(message, { kind: 'ToolCancelled', tool_id: 't1' }, 'live');
    expect(message.tools[0].cancelled).toBe(true);
    // A finished call is never cancelled after the fact.
    const done = applyEvent(
      applyEvent(bubble(), { kind: 'ToolStart', tool_name: 'Bash', tool_id: 't2' }, 'live'),
      { kind: 'ToolDone', tool_id: 't2' },
      'live',
    );
    expect(applyEvent(done, { kind: 'ToolCancelled', tool_id: 't2' }, 'live').tools[0].cancelled).toBe(
      undefined,
    );
  });

  it('replays the deferred golden as a held turn, never an interrupted one (M57.1)', () => {
    const golden = goldens.find((g) => g.case === 'deferred');
    const { messages } = replayTranscript(golden?.session?.events ?? [], 'S');
    const [, assistant] = messages;
    expect(assistant.interrupted).toBeUndefined();
    expect(assistant.tools).toEqual([
      expect.objectContaining({
        name: 'mcp__cerebro__append_to_note',
        deferred: true,
        done: false,
      }),
    ]);
  });

  it('changes nothing for kinds that are not about the message', () => {
    const before = bubble();
    for (const event of [
      { kind: 'Init', session_id: 's' },
      { kind: 'UserPrompt', text: 'x' },
      { kind: 'PrLink', number: 1, url: 'https://x', repository: 'a/b' },
      { kind: 'Interaction', interaction: { id: 'c', kind: 'permission' } },
      { kind: 'Teleported' },
    ] as AgentStreamEvent[]) {
      expect(applyEvent(before, event, 'live')).toBe(before);
    }
  });
});

describe('healFromTranscript', () => {
  const tool = (id: string, done: boolean, output: string | null = null) => ({
    id,
    name: 'Read',
    input: null,
    output,
    done,
    failed: false,
  });

  it('fills unfinished tool rows by tool id and keeps the cached wording', () => {
    const cached: ChatMessage[] = [
      { id: 'u', role: 'user', text: 'as typed', tools: [] },
      {
        id: 'a',
        role: 'assistant',
        text: 'cached reply',
        tools: [tool('t-1', false), tool('t-2', true, 'mine')],
      },
    ];
    const rebuilt: ChatMessage[] = [
      {
        id: 'x',
        role: 'assistant',
        text: 'rebuilt reply',
        tools: [tool('t-1', true, 'alpha'), tool('t-2', true, 'theirs')],
      },
    ];
    const healed = healFromTranscript(cached, rebuilt);
    expect(healed[0]).toBe(cached[0]);
    expect(healed[1].text).toBe('cached reply');
    expect(healed[1].tools).toEqual([tool('t-1', true, 'alpha'), tool('t-2', true, 'mine')]);
  });

  it('copies a payload the cache never kept, by tool id (M56.8)', () => {
    const payload = { output: 'the whole result', outputBytes: 16, outputTruncated: false };
    const cached: ChatMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        text: 'cached reply',
        tools: [tool('t-1', true, 'cut…'), tool('t-2', true, 'short')],
      },
    ];
    const rebuilt: ChatMessage[] = [
      {
        id: 'x',
        role: 'assistant',
        text: 'rebuilt reply',
        tools: [{ ...tool('t-1', true, 'cut…'), payload }, tool('t-2', true, 'short')],
      },
    ];
    const healed = healFromTranscript(cached, rebuilt);
    expect(healed[0].text).toBe('cached reply');
    expect(healed[0].tools).toEqual([
      { ...tool('t-1', true, 'cut…'), payload },
      tool('t-2', true, 'short'),
    ]);
    // Once held, a payload is not replaced, and nothing changes.
    expect(healFromTranscript(healed, rebuilt)).toBe(healed);
  });

  it('hands back the same array when nothing needed healing', () => {
    const cached: ChatMessage[] = [
      { id: 'a', role: 'assistant', text: 'r', tools: [tool('t-1', false)] },
    ];
    expect(healFromTranscript(cached, [])).toBe(cached);
  });
});
