import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  durationBetween,
  endLiveTurn,
  findCall,
  healFromTranscript,
  replaceLastTurn,
  replayTranscript,
  stopStreaming,
} from '@/agent/transcript';
import type {
  AgentStreamEvent,
  ChatMessage,
  MessagePart,
  RunReach,
  SubagentRun,
  ToolCall,
} from '@/agent/types';

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

const golden = (name: string): Golden => {
  const found = goldens.find((g) => g.case === name);
  if (found === undefined) throw new Error(`no golden ${name}`);
  return found;
};

/** The session a golden's run went to, as its stream's Init names it. */
const sessionOf = (g: Golden): string =>
  g.streams
    .flatMap((stream) => stream.events)
    .flatMap((event) => (event.kind === 'Init' ? [event.session_id] : []))[0] ?? 'S';

const bubble = (): ChatMessage => ({
  id: 'a',
  role: 'assistant',
  text: '',
  tools: [],
  streaming: true,
});

/** One stream reduced the way useAgentChat reduces a live turn: each event
 * through the reducer, with the session its Init named. */
function live(events: AgentStreamEvent[]): ChatMessage {
  let message = bubble();
  let session: string | null = null;
  for (const event of events) {
    if (event.kind === 'Init') session = event.session_id;
    if (event.kind === 'Done') message = endLiveTurn(message);
    else message = applyEvent(message, event, 'live', session);
  }
  return endLiveTurn(message);
}

/** The kinds only the live stream says (§3.1): a replay never has them. */
const LIVE_ONLY = new Set<AgentStreamEvent['kind']>([
  'Init',
  'Reach',
  'TextDelta',
  'ThinkingDelta',
  'ToolDenied',
  'SubagentStarted',
  'SubagentProgress',
  'SubagentDone',
  'Result',
  'Interaction',
  'Cancelled',
  'Changeset',
  'Done',
]);

/** A subagent's summary, without what only the live stream says of it. */
function summaryOf(run: SubagentRun) {
  const {
    background: _background,
    depth: _depth,
    progress: _progress,
    lastTool: _lastTool,
    parts: _parts,
    tools: _tools,
    ...summary
  } = run;
  return summary;
}

/**
 * What a turn shows, thread by thread (M91.4: the main thread under '', each
 * subagent under its Agent call), for comparing a live turn with its replay.
 * It leaves out what only the live stream carries (a denial, a subagent's
 * progress, depth and background), every recorded time (`at`, `startedAt`,
 * `endedAt`), and a subagent's calls' structured results, which 2.1.250
 * forwards to the stream without (M91.3b).
 */
function shown(message: ChatMessage) {
  const threads: Record<string, unknown> = {};
  const walk = (key: string, parts: MessagePart[] | undefined, tools: ToolCall[]) => {
    threads[key] = {
      parts: (parts ?? []).map((part) => {
        if (part.kind !== 'reasoning') return part;
        const { at: _at, streaming: _streaming, ...kept } = part;
        return kept;
      }),
      tools: tools.map(({ startedAt: _s, endedAt: _e, denied: _d, result, subagent, ...tool }) => ({
        ...tool,
        ...(key === '' && result !== undefined ? { result } : {}),
        ...(subagent === undefined ? {} : { subagent: summaryOf(subagent) }),
      })),
    };
    for (const tool of tools) {
      if (tool.subagent !== undefined) walk(tool.id, tool.subagent.parts, tool.subagent.tools);
    }
  };
  walk('', message.parts, message.tools);
  return {
    text: message.text,
    error: message.error,
    interrupted: message.interrupted === true,
    anchor: message.anchor,
    threads,
  };
}

/** Each thread's call parts name its calls, once each and in order. */
function partsMatchCalls(parts: MessagePart[] | undefined, tools: ToolCall[]): boolean {
  const named = (parts ?? []).flatMap((part) => (part.kind === 'tool' ? [part.toolId] : []));
  if (tools.length > 0 && parts === undefined) return false;
  if (named.join('\n') !== tools.map((tool) => tool.id).join('\n')) return false;
  return tools.every(
    (tool) =>
      tool.subagent === undefined || partsMatchCalls(tool.subagent.parts, tool.subagent.tools),
  );
}

describe('the transcript goldens', () => {
  it('are all here, each naming the CLI it was folded from', () => {
    expect(goldens.map((g) => g.case)).toEqual([
      'api-error',
      'deferred',
      'denied',
      'interrupted',
      'long-payload',
      'session-records',
      'subagent',
      'thinking-summarized',
      'todos',
      'two-turns',
      'web',
    ]);
    for (const golden of goldens) expect(golden.cli_version).toBe('2.1.250');
  });

  it.each(goldens.map((g) => [g.case, g] as const))(
    'replays the transcript goldens: %s',
    (_, g) => {
      if (g.session === null) return;
      const replayed = replayTranscript(g.session.events, sessionOf(g));
      const prompts = g.session.events.filter((e) => e.kind === 'UserPrompt').length;
      expect(replayed.messages.filter((m) => m.role === 'user')).toHaveLength(prompts);
      const assistants = replayed.messages.filter((m) => m.role === 'assistant');
      expect(assistants.every((m) => m.live === undefined && m.streaming === undefined)).toBe(true);
      // A session file holds none of what only the live stream says.
      expect(g.session.events.filter((e) => LIVE_ONLY.has(e.kind))).toEqual([]);
      const skip = assistants.length - g.streams.length;
      g.streams.forEach((stream, at) => {
        const watched = live(stream.events);
        const restored = assistants[skip + at];
        const label = `${g.case} turn ${skip + at + 1}`;
        expect(partsMatchCalls(watched.parts, watched.tools), label).toBe(true);
        expect(partsMatchCalls(restored.parts, restored.tools), label).toBe(true);
        if (restored.model !== undefined) expect(watched.model, label).toBe(restored.model);
        // M92.2: how long the run worked rides its stream's result alone, a
        // later count of the run its own; the replay has none.
        const counts = stream.events.flatMap((e) =>
          (e.kind === 'Result' || e.kind === 'ToolDeferred') && e.duration_ms !== undefined
            ? [e.duration_ms]
            : [],
        );
        expect(watched.workedMs, label).toBe(counts.at(-1));
        expect(restored.workedMs, label).toBeUndefined();
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

  it('keeps every call’s thread and nothing a subagent counted in tokens (M91.4)', () => {
    for (const g of goldens) {
      const messages = [
        ...replayTranscript(g.session?.events ?? [], sessionOf(g)).messages,
        ...g.streams.map((stream) => live(stream.events)),
      ];
      for (const message of messages) {
        expect(partsMatchCalls(message.parts, message.tools), g.case).toBe(true);
        expect(JSON.stringify(message), g.case).not.toContain('subagent_tokens');
        // The top level holds the main thread's calls only.
        expect(
          message.tools.filter((tool) => tool.parent !== undefined),
          g.case,
        ).toEqual([]);
      }
    }
  });

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
    const lone = applyEvent(
      bubble(),
      { kind: 'ToolDeferred', tool_id: 't9', tool_name: 'Bash' },
      'live',
    );
    expect(lone.tools).toEqual([
      {
        id: 't9',
        name: 'Bash',
        input: null,
        output: null,
        done: false,
        failed: false,
        deferred: true,
      },
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
    expect(
      applyEvent(done, { kind: 'ToolCancelled', tool_id: 't2' }, 'live').tools[0].cancelled,
    ).toBe(undefined);
  });

  it('marks a stopped reply cancelled live and keeps its text (M57.5)', () => {
    const stopped = endLiveTurn(
      run([{ kind: 'TextDelta', text: 'Half an ans' }, { kind: 'Cancelled' }], 'live'),
    );
    expect(stopped.cancelled).toBe(true);
    expect(stopped.text).toBe('Half an ans');
    expect(stopped.streaming).toBe(false);
    // No golden's session file says Cancelled: it is the live reader's word.
    for (const golden of goldens) {
      expect((golden.session?.events ?? []).some((e) => e.kind === 'Cancelled')).toBe(false);
    }
  });

  it('upserts a run’s Changeset by run id, and a resume adds a second (M58.3)', () => {
    const commit = (run_id: string, additions: number) =>
      ({
        kind: 'Changeset',
        changeset: {
          state: 'committed',
          run_id,
          commit: 'b'.repeat(40),
          files: [],
          additions,
          deletions: 0,
          binary: 0,
          shell_unrecorded: false,
        },
      }) as AgentStreamEvent;
    const once = run([commit('run-1', 1)], 'live');
    expect(once.changesets?.map((c) => c.run_id)).toEqual(['run-1']);
    const again = applyEvent(once, commit('run-1', 2), 'live');
    expect(again.changesets).toHaveLength(1);
    expect(again.changesets?.[0]).toMatchObject({ additions: 2 });
    const resumed = applyEvent(again, commit('run-2', 3), 'live');
    expect(resumed.changesets?.map((c) => c.run_id)).toEqual(['run-1', 'run-2']);
    // No golden's session file says Changeset: it is the live reader's word,
    // so a replayed thread carries none and the goldens read as before.
    for (const golden of goldens) {
      expect((golden.session?.events ?? []).some((e) => e.kind === 'Changeset')).toBe(false);
      const { messages } = replayTranscript(golden.session?.events ?? [], 'S');
      expect(messages.every((m) => m.changesets === undefined)).toBe(true);
    }
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

describe('how long a reply worked (M92.2)', () => {
  /** A run's last word, which closes its count. */
  const ran = (run_id: string): AgentStreamEvent => ({
    kind: 'Changeset',
    changeset: { state: 'nothing', run_id, shell_unrecorded: false },
  });
  /** `events` reduced onto `from` as the panel reduces a live run, its Done
   * through endLiveTurn. */
  const reduce = (events: AgentStreamEvent[], from: ChatMessage = bubble()): ChatMessage =>
    events.reduce(
      (m, e) => (e.kind === 'Done' ? endLiveTurn(m) : applyEvent(m, e, 'live', 'S')),
      from,
    );
  /** The answer that resumes a held reply, as useAgentChat patches it: a
   * fresh cursor, and streaming again. */
  const answered = ({ seq: _cursor, ...rest }: ChatMessage): ChatMessage => ({
    ...rest,
    streaming: true,
  });
  /** A run the gate held on its call (M57.1), counting `ms` till then. */
  const held = (ms?: number): AgentStreamEvent[] => [
    { kind: 'ToolStart', tool_name: 'Bash', tool_id: 't1', input: '{"command":"ls"}' },
    {
      kind: 'ToolDeferred',
      tool_id: 't1',
      tool_name: 'Bash',
      ...(ms === undefined ? {} : { duration_ms: ms }),
    },
    ran('run-a'),
    { kind: 'Done' },
  ];
  /** The run an answer resumes, counting `ms`. */
  const resumed = (ms?: number): AgentStreamEvent[] => [
    { kind: 'ToolDone', tool_id: 't1', output: 'a.md' },
    { kind: 'Text', message_id: 'm2', text: 'One file.' },
    { kind: 'Result', text: 'One file.', ...(ms === undefined ? {} : { duration_ms: ms }) },
    { kind: 'TurnEnded', stop_reason: 'end_turn' },
    ran('run-b'),
    { kind: 'Done' },
  ];

  it('sums its runs across a deferral resume, each once', () => {
    const waiting = reduce(held(2400));
    expect([waiting.workedMs, waiting.workedRun]).toEqual([2400, undefined]);
    const done = reduce(resumed(3000), answered(waiting));
    expect(done.text).toBe('One file.');
    expect([done.workedMs, done.workedRun]).toEqual([5400, undefined]);
    // The resume's changeset heard again brings it up to date, and closes
    // nothing a second time.
    expect(reduce([ran('run-b')], done).workedMs).toBe(5400);
  });

  it('upserts a run’s count: a later count of the same run replaces it', () => {
    const first = reduce([{ kind: 'Result', text: 'a', duration_ms: 3000 }]);
    expect([first.workedMs, first.workedRun]).toEqual([3000, 3000]);
    const again = reduce([{ kind: 'Result', text: 'a', duration_ms: 3500 }, ran('run-1')], first);
    expect([again.workedMs, again.workedRun]).toEqual([3500, undefined]);
  });

  it('keeps no sum once one run counted and another did not (CV-05)', () => {
    // The resume counted nothing.
    expect(reduce(resumed(), answered(reduce(held(2400)))).workedMs).toBeNull();
    // The held run counted nothing: nothing while no run has counted, and
    // no sum once the resume does.
    const uncounted = reduce(held());
    expect(uncounted.workedMs).toBeUndefined();
    expect(reduce(resumed(3000), answered(uncounted)).workedMs).toBeNull();
    // A resume stopped before its result, as Rust's reader closes it.
    const stopped = reduce(
      [ran('run-b'), { kind: 'Cancelled' }, { kind: 'Done' }],
      answered(reduce(held(2400))),
    );
    expect(stopped.workedMs).toBeNull();
    // A later count never makes one again.
    const later = reduce([{ kind: 'Result', text: 'x', duration_ms: 10 }, ran('run-c')], stopped);
    expect(later.workedMs).toBeNull();
    // A reply saved before M92.2, whose earlier run closed with no count.
    const older: ChatMessage = {
      ...bubble(),
      changesets: [{ state: 'nothing', run_id: 'run-a', shell_unrecorded: false }],
    };
    expect(reduce([{ kind: 'Result', text: 'x', duration_ms: 10 }], older).workedMs).toBeNull();
  });

  it('counts nothing a session file holds, a restored card marks, or that is no count', () => {
    for (const duration_ms of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result: AgentStreamEvent = { kind: 'Result', text: 'x', duration_ms };
      expect(reduce([result]).workedMs).toBeUndefined();
    }
    const counted: AgentStreamEvent = { kind: 'Result', text: 'x', duration_ms: 9 };
    expect(applyEvent(bubble(), counted, 'replay').workedMs).toBeUndefined();
    // The card a restored thread waits on marks its call again (useAgentChat's
    // waitOnCard): it counts nothing and keeps the sum.
    const restored: ChatMessage = { ...bubble(), streaming: false, workedMs: 2400 };
    const marked = applyEvent(
      restored,
      { kind: 'ToolDeferred', tool_id: 't1', tool_name: 'Bash' },
      'live',
    );
    expect([marked.workedMs, marked.workedRun]).toEqual([2400, undefined]);
  });

  it('keeps the sum through a rebuild from the session file, which counts none', () => {
    const done = reduce(resumed(3000), answered(reduce(held(2400))));
    const { messages } = replayTranscript(
      [
        { kind: 'UserPrompt', text: 'ls' },
        { kind: 'ToolStart', tool_name: 'Bash', tool_id: 't1', input: '{"command":"ls"}' },
        { kind: 'ToolDone', tool_id: 't1', output: 'a.md' },
        { kind: 'Text', message_id: 'm2', text: 'One file.' },
        { kind: 'TurnEnded' },
      ],
      'S',
    );
    expect(messages[1].workedMs).toBeUndefined();
    const [rebuilt] = replaceLastTurn([done], done.id, messages);
    expect(rebuilt.workedMs).toBe(5400);
  });
});

describe('what a run reaches (M92.8)', () => {
  const reach = (over: Partial<RunReach> = {}): RunReach => ({
    connectors: [{ name: 'gmail', status: 'connected' }],
    missing: [{ name: 'linear', reason: "not in this vault's connector list" }],
    missing_more: 0,
    inherits: false,
    permission_mode: 'acceptEdits',
    cerebro: true,
    families: { confirmable: ['allow'], delegate: ['cli'], shell: ['deny'], web: ['allow'] },
    ...over,
  });
  const said = (what: RunReach): AgentStreamEvent => ({ kind: 'Reach', reach: what });

  it('keeps the run’s reach on its reply, and changes nothing else of it', () => {
    const held = applyEvent(bubble(), said(reach()), 'live', 'S');
    expect(held.reach).toEqual(reach());
    const { reach: _kept, ...rest } = held;
    expect(rest).toEqual(bubble());
  });

  it('shows once: the same Reach heard again on a re-attach is the same reply (CV-30)', () => {
    const held = applyEvent(bubble(), said(reach()), 'live', 'S');
    expect(applyEvent(held, said(reach()), 'live', 'S')).toEqual(held);
  });

  it('keeps the latest run’s: a resume’s stands in place of the held run’s', () => {
    const held = applyEvent(bubble(), said(reach()), 'live', 'S');
    const resumed = reach({ connectors: [{ name: 'gmail', status: 'needs-auth' }] });
    const next: AgentStreamEvent[] = [
      { kind: 'ToolStart', tool_name: 'Bash', tool_id: 't1', input: '{"command":"ls"}' },
      { kind: 'ToolDeferred', tool_id: 't1', tool_name: 'Bash' },
      said(resumed),
      { kind: 'ToolDone', tool_id: 't1', output: 'a.md' },
    ];
    const done = next.reduce((m, e) => applyEvent(m, e, 'live', 'S'), held);
    expect(done.reach).toEqual(resumed);
  });

  it('is live only: a replay holds none, and a rebuild from the file keeps the live one', () => {
    const watched: ChatMessage = {
      ...applyEvent(bubble(), said(reach()), 'live', 'S'),
      streaming: false,
      text: 'One file.',
    };
    const { messages } = replayTranscript(
      [
        { kind: 'UserPrompt', text: 'ls' },
        { kind: 'Text', message_id: 'm2', text: 'One file.' },
        { kind: 'TurnEnded' },
      ],
      'S',
    );
    expect(messages.some((m) => m.reach !== undefined)).toBe(false);
    const [rebuilt] = replaceLastTurn([watched], watched.id, messages);
    expect(rebuilt.reach).toEqual(reach());
    expect(healFromTranscript([watched], messages)[0].reach).toEqual(reach());
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

describe('replaceLastTurn (M57.6)', () => {
  const cached: ChatMessage[] = [
    { id: 'u-1', role: 'user', text: 'first', tools: [] },
    { id: 'a-1', role: 'assistant', text: 'one', tools: [] },
    { id: 'u-2', role: 'user', text: 'second', tools: [] },
    {
      id: 'a-2',
      role: 'assistant',
      text: 'half a rep',
      tools: [],
      streaming: true,
      gap: true,
      cancelled: true,
      seq: 41,
    },
  ];
  const file: ChatMessage[] = [
    { id: 's-t1-u', role: 'user', text: 'first', tools: [] },
    { id: 's-t1-a', role: 'assistant', text: 'one', tools: [] },
    { id: 's-t2-u', role: 'user', text: 'second', tools: [] },
    {
      id: 's-t2-a',
      role: 'assistant',
      text: 'half a reply, whole',
      tools: [{ id: 't-1', name: 'Read', input: 'a.md', output: 'x', done: true, failed: false }],
    },
  ];

  it("swaps in the file's last reply and keeps cancelled", () => {
    const next = replaceLastTurn(cached, 'a-2', file);
    expect(next[0]).toBe(cached[0]);
    expect(next[1]).toBe(cached[1]);
    expect(next[3]).toMatchObject({
      id: 'a-2',
      text: 'half a reply, whole',
      cancelled: true,
    });
    expect(next[3].tools).toEqual(file[3].tools);
    expect(next[3].streaming).toBeUndefined();
    expect(next[3].gap).toBeUndefined();
  });

  it("keeps a call's cancel, pause and denial, which only the live stream says", () => {
    const call = {
      id: 't-1',
      name: 'Read',
      input: 'a.md',
      output: null,
      done: false,
      failed: false,
    };
    const live: ChatMessage[] = [
      ...cached.slice(0, 3),
      {
        ...cached[3],
        tools: [
          { ...call, cancelled: true, paused: true, denied: 'Refused by a rule.' },
          {
            ...call,
            id: 'a-1',
            name: 'Agent',
            cancelled: true,
            subagent: {
              type: '',
              description: '',
              status: 'cancelled',
              parts: [],
              tools: [{ ...call, id: 's-1', denied: 'Not here.' }],
            },
          },
        ],
      },
    ];
    const rebuilt: ChatMessage[] = [
      ...file.slice(0, 3),
      {
        ...file[3],
        tools: [
          { ...call, done: true, output: 'x' },
          {
            ...call,
            id: 'a-1',
            name: 'Agent',
            subagent: {
              type: '',
              description: '',
              status: 'interrupted',
              parts: [],
              tools: [{ ...call, id: 's-1' }],
            },
          },
        ],
      },
    ];
    const [first, agent] = replaceLastTurn(live, 'a-2', rebuilt)[3].tools;
    expect(first).toMatchObject({
      done: true,
      cancelled: true,
      paused: true,
      denied: 'Refused by a rule.',
    });
    expect(agent.cancelled).toBe(true);
    expect(agent.subagent?.status).toBe('cancelled');
    expect(agent.subagent?.tools[0].denied).toBe('Not here.');
  });

  it('changes nothing with no replayed reply or no such message', () => {
    expect(replaceLastTurn(cached, 'a-2', [])).toBe(cached);
    expect(replaceLastTurn(cached, 'gone', file)).toBe(cached);
  });
});

/** The CLI's time `s` seconds into a turn, as a line's `at`. */
const at = (s: number): string =>
  new Date(Date.UTC(2026, 9, 22, 12, 0, 0) + s * 1000).toISOString();

const SESSION = '00000000-0000-4000-8000-0000000091a4';

/** Events reduced in one mode, the session named. */
const reduce = (
  events: AgentStreamEvent[],
  mode: 'live' | 'replay',
  session: string | null = null,
) => events.reduce((m, e) => applyEvent(m, e, mode, session), bubble());

const textOf = (message_id: string, text: string, extra: Partial<AgentStreamEvent> = {}) =>
  ({ kind: 'Text', message_id, text, ...extra }) as AgentStreamEvent;

const start = (tool_id: string, tool_name: string, extra: Partial<AgentStreamEvent> = {}) =>
  ({ kind: 'ToolStart', tool_id, tool_name, input: '{}', ...extra }) as AgentStreamEvent;

const done = (tool_id: string, extra: Partial<AgentStreamEvent> = {}) =>
  ({ kind: 'ToolDone', tool_id, output: 'ok', ...extra }) as AgentStreamEvent;

/** An Agent call, as the model makes it. */
const agentCall = (tool_id: string, description: string, extra: Partial<AgentStreamEvent> = {}) =>
  start(tool_id, 'Agent', {
    input: JSON.stringify({ description, subagent_type: 'cerebro-researcher', prompt: 'Look.' }),
    ...extra,
  });

const runOf = (message: ChatMessage, id: string): SubagentRun => {
  const run = findCall(message.tools, id)?.subagent;
  if (run === undefined) throw new Error(`no run on ${id}`);
  return run;
};

describe('the parts of a turn (M91.4)', () => {
  it('keeps every message’s words in order, one part per message, the last its answer', () => {
    const events: AgentStreamEvent[] = [
      textOf('m1', 'Reading both notes.'),
      start('t1', 'Read'),
      done('t1'),
      textOf('m2', 'done'),
      textOf('m2', 'and checked'),
      { kind: 'TurnEnded', stop_reason: 'end_turn' },
    ];
    for (const mode of ['live', 'replay'] as const) {
      const m = reduce(events, mode);
      expect(m.text, mode).toBe('done\n\nand checked');
      expect(m.parts, mode).toEqual([
        { kind: 'text', id: 'text-1', text: 'Reading both notes.' },
        { kind: 'tool', toolId: 't1' },
        { kind: 'text', id: 'text-2', text: 'done\n\nand checked' },
      ]);
    }
  });

  it('streams deltas into one open part that the whole block settles, never doubled', () => {
    let m = reduce(
      [
        { kind: 'TextDelta', text: 'Read' },
        { kind: 'TextDelta', text: 'ing.' },
      ],
      'live',
    );
    expect(m.parts).toEqual([{ kind: 'text', id: 'text-1', text: 'Reading.' }]);
    m = applyEvent(m, textOf('m1', 'Reading.'), 'live');
    expect(m.parts).toEqual([{ kind: 'text', id: 'text-1', text: 'Reading.' }]);
    // A second block of the same message streams apart, then joins its part.
    m = applyEvent(m, { kind: 'TextDelta', text: 'And more.' }, 'live');
    expect(m.parts).toHaveLength(2);
    m = applyEvent(m, textOf('m1', 'And more.'), 'live');
    expect(m.parts).toEqual([{ kind: 'text', id: 'text-1', text: 'Reading.\n\nAnd more.' }]);
    // The bubble's text still streams as it always did.
    expect(m.text).toBe('Reading.And more.');
    expect(applyEvent(m, { kind: 'TurnEnded' }, 'live').text).toBe('Reading.\n\nAnd more.');
  });

  it('streams on into the open part of a reply restored mid-block, never a second copy', () => {
    const before = reduce(
      [start('t1', 'Read'), done('t1'), { kind: 'TextDelta', text: 'Half ' }],
      'live',
    );
    // A reload keeps the reply and drops the reducer's memory (M57.6).
    const { live: _live, ...restored } = before;
    let m = applyEvent(restored, { kind: 'TextDelta', text: 'done.' }, 'live');
    m = applyEvent(m, textOf('m1', 'Half done.'), 'live');
    expect(m.parts).toEqual([
      { kind: 'tool', toolId: 't1' },
      { kind: 'text', id: 'text-1', text: 'Half done.' },
    ]);
    // A restored reply whose last part is a call opens a part of its own.
    const { live: _l, ...called } = reduce([start('t1', 'Read'), done('t1')], 'live');
    expect(applyEvent(called, { kind: 'TextDelta', text: 'Next' }, 'live').parts).toEqual([
      { kind: 'tool', toolId: 't1' },
      { kind: 'text', id: 'text-1', text: 'Next' },
    ]);
  });

  it('settles the open reasoning part with its Thinking, replacing what streamed', () => {
    let m = reduce(
      [
        { kind: 'ThinkingDelta', text: 'Look at ' },
        { kind: 'ThinkingDelta', text: 'the note.' },
      ],
      'live',
    );
    expect(m.parts).toEqual([
      { kind: 'reasoning', id: 'reasoning-1', text: 'Look at the note.', streaming: true },
    ]);
    m = applyEvent(
      m,
      { kind: 'Thinking', message_id: 'm1', text: 'Look at the note.', at: at(2) },
      'live',
    );
    expect(m.parts).toEqual([
      { kind: 'reasoning', id: 'reasoning-1', text: 'Look at the note.', at: at(2) },
    ]);
    // The mock streams its thinking and then says it whole: once, not twice.
    const mock = reduce(
      [
        { kind: 'ThinkingDelta', text: 'Reading the vault context first.' },
        { kind: 'Thinking', message_id: 'm1', text: 'Reading the vault context first.' },
      ],
      'live',
    );
    expect(mock.parts).toEqual([
      { kind: 'reasoning', id: 'reasoning-1', text: 'Reading the vault context first.' },
    ]);
  });

  it('draws no part for thinking with no words, and says withheld thinking was there', () => {
    const empty: AgentStreamEvent = { kind: 'Thinking', message_id: 'm1', text: '' };
    for (const mode of ['live', 'replay'] as const) {
      expect(reduce([empty], mode).parts, mode).toBeUndefined();
      expect(reduce([{ ...empty, redacted: true }], mode).parts, mode).toEqual([
        { kind: 'reasoning', id: 'reasoning-1', text: '', redacted: true },
      ]);
    }
    // A Thinking with no words takes away the part its deltas opened.
    const settled = reduce([{ kind: 'ThinkingDelta', text: 'hm' }, empty], 'live');
    expect(settled.parts).toEqual([]);
  });

  it('times a reasoning block only from two recorded times (CV-05)', () => {
    const thinking = (id: string, when?: string): AgentStreamEvent => ({
      kind: 'Thinking',
      message_id: id,
      text: `thought ${id}`,
      ...(when === undefined ? {} : { at: when }),
    });
    for (const mode of ['live', 'replay'] as const) {
      const m = reduce(
        [
          thinking('m1', at(2)),
          start('t1', 'Read', { at: at(2.4) }),
          done('t1', { at: at(3) }),
          thinking('m2', at(4.5)),
          start('t2', 'Read', { at: at(5) }),
          // A step nobody timed leaves the next block untimed.
          done('t2'),
          thinking('m3', at(7)),
          // Times that run backwards measure nothing.
          start('t3', 'Read', { at: at(9) }),
          done('t3', { at: at(10) }),
          thinking('m4', at(8)),
        ],
        mode,
      );
      const reasoning = (m.parts ?? []).filter((part) => part.kind === 'reasoning');
      expect(
        reasoning.map((part) => (part.kind === 'reasoning' ? part.durationMs : null)),
        mode,
      ).toEqual([undefined, 1500, undefined, undefined]);
      expect(m.tools[0]).toMatchObject({ startedAt: at(2.4), endedAt: at(3) });
      expect('endedAt' in m.tools[1]).toBe(false);
    }
  });

  it('measures a duration from two readable times, in order, and nothing else', () => {
    expect(durationBetween(at(1), at(3.25))).toBe(2250);
    expect(durationBetween(at(1), at(1))).toBe(0);
    expect(durationBetween(at(3), at(1))).toBeUndefined();
    expect(durationBetween(undefined, at(1))).toBeUndefined();
    expect(durationBetween(at(1), undefined)).toBeUndefined();
    expect(durationBetween('yesterday', at(1))).toBeUndefined();
  });

  it('anchors a turn at its session and last line, and only with both', () => {
    const ended: AgentStreamEvent = { kind: 'TurnEnded', last_uuid: 'u-1' };
    expect(reduce([ended], 'live', SESSION).anchor).toEqual({ sessionId: SESSION, uuid: 'u-1' });
    expect(reduce([ended], 'live').anchor).toBeUndefined();
    expect(reduce([{ kind: 'TurnEnded' }], 'live', SESSION).anchor).toBeUndefined();
    const replayed = replayTranscript(
      [{ kind: 'UserPrompt', text: 'q' }, textOf('m1', 'a'), ended],
      SESSION,
    );
    expect(replayed.messages[1].anchor).toEqual({ sessionId: SESSION, uuid: 'u-1' });
  });

  it('keeps a continuation’s first answer as a part, and moves the anchor to its end', () => {
    for (const mode of ['live', 'replay'] as const) {
      const first = reduce(
        [
          textOf('m1', 'First answer.'),
          { kind: 'Result', text: 'First answer.' },
          { kind: 'TurnEnded', stop_reason: 'end_turn', last_uuid: 'u-1' },
        ],
        mode,
        SESSION,
      );
      expect(first.text, mode).toBe('First answer.');
      let m = first;
      for (const event of [
        { kind: 'TextDelta', text: 'Second' },
        textOf('m2', 'Second answer.'),
        { kind: 'Result', text: 'Second answer.' },
      ] as AgentStreamEvent[]) {
        if (mode === 'replay' && event.kind === 'TextDelta') continue;
        m = applyEvent(m, event, mode, SESSION);
      }
      // A continuation's deltas never touch the answer before its end.
      if (mode === 'live') expect(m.text).toBe('Second answer.');
      m = applyEvent(
        m,
        { kind: 'TurnEnded', stop_reason: 'end_turn', last_uuid: 'u-2' },
        mode,
        SESSION,
      );
      expect(m.text, mode).toBe('Second answer.');
      expect(m.parts, mode).toEqual([
        { kind: 'text', id: 'text-1', text: 'First answer.' },
        { kind: 'text', id: 'text-2', text: 'Second answer.' },
      ]);
      expect(m.anchor, mode).toEqual({ sessionId: SESSION, uuid: 'u-2' });
    }
  });

  it('takes a reply only a result carried as its one text part', () => {
    expect(reduce([{ kind: 'Result', text: 'the whole answer' }], 'live').parts).toEqual([
      { kind: 'text', id: 'text-1', text: 'the whole answer' },
    ]);
    const streamed = reduce(
      [
        { kind: 'TextDelta', text: 'partial' },
        { kind: 'Result', text: 'the whole answer' },
      ],
      'live',
    );
    expect(streamed.parts).toEqual([{ kind: 'text', id: 'text-1', text: 'the whole answer' }]);
    expect(streamed.text).toBe('the whole answer');
  });

  it('lands a structured result on its call, and keeps a denial in Claude Code’s words', () => {
    const shell = {
      type: 'shell',
      stdout: '3',
      stderr: '',
      interrupted: false,
      truncated: false,
    } as const;
    const m = reduce(
      [
        start('t1', 'Bash'),
        { kind: 'ToolDenied', tool_id: 't1', tool_name: 'Bash', message: 'Needs approval.' },
        done('t1', { is_error: true }),
        start('t2', 'Bash'),
        done('t2'),
        { kind: 'ToolResult', tool_id: 't2', data: shell },
      ],
      'live',
    );
    expect(m.tools[0]).toMatchObject({ denied: 'Needs approval.', failed: true });
    expect(m.tools[1].result).toEqual(shell);
    // A denial or result for a call the turn never started gets no row.
    for (const event of [
      { kind: 'ToolDenied', tool_id: 'nope', tool_name: 'Bash', message: 'No.' },
      { kind: 'ToolResult', tool_id: 'nope', data: shell },
    ] as AgentStreamEvent[]) {
      expect(applyEvent(m, event, 'live')).toBe(m);
    }
  });

  it('reads a legacy reply’s text and calls as its first parts before adding one', () => {
    const legacy: ChatMessage = {
      id: 'a',
      role: 'assistant',
      text: 'Adding it.',
      tools: [{ id: 't1', name: 'Read', input: null, output: null, done: false, failed: false }],
    };
    const m = applyEvent(legacy, textOf('m2', 'Added.'), 'live');
    expect(m.parts).toEqual([
      { kind: 'text', id: 'text-1', text: 'Adding it.' },
      { kind: 'tool', toolId: 't1' },
      { kind: 'text', id: 'text-2', text: 'Added.' },
    ]);
  });
});

describe('subagents (M91.4)', () => {
  const g = golden('subagent');
  const AGENT = 'toolu_000000000000000000009501';
  const READ = 'toolu_000000000000000000009511';
  const REPORT = 'The launch note is ready for review, but its press list is still open.';

  it('routes the subagent golden into its Agent call’s run, live and replayed', () => {
    const watched = live(g.streams[0].events);
    const restored = replayTranscript(g.session?.events ?? [], sessionOf(g)).messages[1];
    for (const [mode, m] of [
      ['live', watched],
      ['replay', restored],
    ] as const) {
      // The turn's own: its reasoning, its one call and its answer.
      expect(
        m.tools.map((t) => t.id),
        mode,
      ).toEqual([AGENT]);
      expect(m.text, mode).toBe(
        'Almost: the launch note is ready for review, but its press list is still open.',
      );
      expect(m.error, mode).toBeUndefined();
      expect(
        m.parts?.map((part) => (part.kind === 'tool' ? part.toolId : part.id)),
        mode,
      ).toEqual(['reasoning-1', AGENT, 'reasoning-2', 'text-1']);
      // Timed from the step before it on its own thread: the call's return.
      expect(m.parts?.[2], mode).toMatchObject({ kind: 'reasoning', durationMs: 1700 });
      expect(m.anchor, mode).toEqual({
        sessionId: sessionOf(g),
        uuid: '00000000-0000-4000-8000-000009500111',
      });
      const run = runOf(m, AGENT);
      expect(run, mode).toMatchObject({
        agentId: 'a0000000000000001',
        type: 'cerebro-researcher',
        description: 'Read the launch note',
        status: 'done',
        toolUses: 1,
        durationMs: 3800,
        model: 'claude-haiku-4-5-20251001',
        summary: REPORT,
      });
      expect(
        run.tools.map((t) => [t.id, t.parent, t.done]),
        mode,
      ).toEqual([[READ, AGENT, true]]);
      expect(run.parts, mode).toEqual([
        expect.objectContaining({
          kind: 'reasoning',
          id: `${AGENT}:reasoning-1`,
          // Its first step is timed from its call's start.
          durationMs: 1600,
        }),
        { kind: 'tool', toolId: READ },
        expect.objectContaining({ kind: 'reasoning', durationMs: 1500 }),
        { kind: 'text', id: `${AGENT}:text-1`, text: REPORT },
      ]);
    }
    // What only the stream says: how it ran and what it was last doing.
    expect(runOf(watched, AGENT)).toMatchObject({
      background: false,
      depth: 1,
      progress: 'Reading projects/launch.md',
      lastTool: 'mcp__cerebro__get_note',
    });
    expect(runOf(restored, AGENT).progress).toBeUndefined();
  });

  it('never lets a subagent’s error reach the bubble', () => {
    const m = reduce(
      [
        agentCall('a1', 'Look around'),
        { kind: 'Error', message: 'API Error: overloaded', parent: 'a1' },
      ],
      'live',
    );
    expect(m.error).toBeUndefined();
    expect(m.notice).toBeUndefined();
    expect(runOf(m, 'a1')).toMatchObject({ status: 'failed', error: 'API Error: overloaded' });
    // One for a call the turn never started changes nothing.
    expect(applyEvent(m, { kind: 'Error', message: 'x', parent: 'nope' }, 'live')).toBe(m);
  });

  it('drops a subagent’s step whose call the turn never started', () => {
    const before = reduce([agentCall('a1', 'Look')], 'live');
    for (const event of [
      textOf('m9', 'stray', { parent: 'nope' }),
      { kind: 'Thinking', message_id: 'm9', text: 'stray', parent: 'nope' },
      start('x1', 'Read', { parent: 'nope' }),
      done('x1', { parent: 'nope' }),
    ] as AgentStreamEvent[]) {
      expect(applyEvent(before, event, 'live')).toBe(before);
    }
  });

  it('routes a nested subagent’s steps by the call that started it', () => {
    for (const mode of ['live', 'replay'] as const) {
      const m = reduce(
        [
          agentCall('a1', 'Outer'),
          agentCall('a2', 'Inner', { parent: 'a1' }),
          start('r1', 'mcp__cerebro__get_note', { parent: 'a2' }),
          done('r1', { parent: 'a2' }),
          textOf('m5', 'Inner found it.', { parent: 'a2' }),
          done('a2', { parent: 'a1' }),
          textOf('m4', 'Outer found it.', { parent: 'a1' }),
          done('a1'),
        ],
        mode,
      );
      expect(
        m.tools.map((t) => t.id),
        mode,
      ).toEqual(['a1']);
      const outer = runOf(m, 'a1');
      expect(
        outer.tools.map((t) => t.id),
        mode,
      ).toEqual(['a2']);
      expect(outer.parts.at(-1), mode).toEqual({
        kind: 'text',
        id: 'a1:text-1',
        text: 'Outer found it.',
      });
      const inner = runOf(m, 'a2');
      expect(
        inner.tools.map((t) => [t.id, t.parent, t.done]),
        mode,
      ).toEqual([['r1', 'a2', true]]);
      expect(inner.parts.at(-1), mode).toEqual({
        kind: 'text',
        id: 'a2:text-1',
        text: 'Inner found it.',
      });
      expect([outer.status, inner.status], mode).toEqual(['done', 'done']);
      expect(m.text, mode).toBe('');
      expect(m.parts, mode).toEqual([{ kind: 'tool', toolId: 'a1' }]);
    }
  });

  it('finds a denied call wherever it is', () => {
    const m = reduce(
      [
        agentCall('a1', 'Look'),
        start('b1', 'Bash', { parent: 'a1' }),
        { kind: 'ToolDenied', tool_id: 'b1', tool_name: 'Bash', message: 'Refused.' },
      ],
      'live',
    );
    expect(runOf(m, 'a1').tools[0].denied).toBe('Refused.');
    expect(m.tools).toHaveLength(1);
  });

  it('reads a subagent still running when its message stops streaming as interrupted', () => {
    const started: AgentStreamEvent = {
      kind: 'SubagentStarted',
      tool_id: 'a1',
      agent_id: 'a0000000000000002',
      subagent_type: 'cerebro-researcher',
      description: 'Look',
      background: false,
    };
    const running = reduce([agentCall('a1', 'Look'), started], 'live');
    expect(runOf(running, 'a1').status).toBe('running');
    expect(runOf(endLiveTurn(running), 'a1').status).toBe('interrupted');
    expect(runOf(stopStreaming(running), 'a1').status).toBe('interrupted');
    expect(stopStreaming(running).streaming).toBe(false);
    // Replayed, a file that stops while it runs reads the same.
    const replayed = replayTranscript(
      [
        { kind: 'UserPrompt', text: 'q' },
        agentCall('a1', 'Look'),
        start('r1', 'Read', { parent: 'a1' }),
      ],
      SESSION,
    );
    expect(runOf(replayed.messages[1], 'a1').status).toBe('interrupted');
  });

  it('keeps a background subagent running past its call’s return, until it says it ended', () => {
    const background = reduce(
      [
        agentCall('a1', 'Look'),
        {
          kind: 'SubagentStarted',
          tool_id: 'a1',
          agent_id: 'a0000000000000003',
          subagent_type: '',
          description: '',
          background: true,
        },
        done('a1', { output: 'Async agent launched.' }),
      ],
      'live',
    );
    expect(runOf(background, 'a1').status).toBe('running');
    const ended = applyEvent(
      background,
      { kind: 'SubagentDone', tool_id: 'a1', status: 'completed', tool_uses: 4 },
      'live',
    );
    expect(runOf(ended, 'a1')).toMatchObject({ status: 'done', toolUses: 4 });
    expect(runOf(endLiveTurn(background), 'a1').status).toBe('interrupted');
  });

  it('takes the CLI’s words for a subagent’s life, and never an empty one', () => {
    let m = reduce([agentCall('a1', 'Read the launch note')], 'live');
    m = applyEvent(
      m,
      {
        kind: 'SubagentStarted',
        tool_id: 'a1',
        agent_id: '',
        subagent_type: '',
        description: '',
        background: false,
        depth: 1,
      },
      'live',
    );
    expect(runOf(m, 'a1')).toMatchObject({
      type: 'cerebro-researcher',
      description: 'Read the launch note',
      depth: 1,
    });
    expect(runOf(m, 'a1').agentId).toBeUndefined();
    m = applyEvent(
      m,
      { kind: 'SubagentProgress', tool_id: 'a1', description: '', last_tool: 'Read', tool_uses: 2 },
      'live',
    );
    expect(runOf(m, 'a1').progress).toBeUndefined();
    expect(runOf(m, 'a1')).toMatchObject({ lastTool: 'Read', toolUses: 2 });
    for (const [status, reads] of [
      ['', 'running'],
      ['an end this build does not know', 'running'],
      ['killed', 'interrupted'],
      ['failed', 'failed'],
      ['completed', 'done'],
    ] as const) {
      const after = applyEvent(m, { kind: 'SubagentDone', tool_id: 'a1', status }, 'live');
      expect(runOf(after, 'a1').status, status).toBe(reads);
    }
  });

  it('holds a deferred Agent call’s run waiting until it starts, and cancels it on a stop', () => {
    let m = reduce(
      [agentCall('a1', 'Look'), { kind: 'ToolDeferred', tool_id: 'a1', tool_name: 'Agent' }],
      'live',
    );
    expect(runOf(m, 'a1').status).toBe('waiting');
    expect(runOf(endLiveTurn(m), 'a1').status).toBe('waiting');
    m = applyEvent(m, { kind: 'ToolCancelled', tool_id: 'a1' }, 'live');
    expect(runOf(m, 'a1').status).toBe('cancelled');
  });

  it('makes a run for an alias of the subagent tool, by the manifest', () => {
    const m = reduce([start('a1', 'Task', { input: '{"description":"Old name"}' })], 'live');
    expect(runOf(m, 'a1')).toMatchObject({ type: '', description: 'Old name', status: 'running' });
    expect(reduce([start('r1', 'Read')], 'live').tools[0].subagent).toBeUndefined();
  });
});

describe('healFromTranscript, through subagents and parts (M91.4)', () => {
  const call = (id: string, over: Partial<ToolCall> = {}): ToolCall => ({
    id,
    name: 'Read',
    input: null,
    output: null,
    done: false,
    failed: false,
    ...over,
  });
  const run = (over: Partial<SubagentRun> = {}): SubagentRun => ({
    type: 'cerebro-researcher',
    description: 'Look',
    status: 'done',
    parts: [],
    tools: [],
    ...over,
  });
  const reply = (over: Partial<ChatMessage>): ChatMessage => ({
    id: 'a',
    role: 'assistant',
    text: 'answer',
    tools: [],
    ...over,
  });

  it('heals a subagent’s calls by id, at any depth', () => {
    const nested = (inner: ToolCall) =>
      call('a1', {
        name: 'Agent',
        done: true,
        subagent: run({
          tools: [call('a2', { name: 'Agent', done: true, subagent: run({ tools: [inner] }) })],
        }),
      });
    const cached = [reply({ tools: [nested(call('r1'))] })];
    const rebuilt = [
      reply({ id: 'x', tools: [nested(call('r1', { done: true, output: 'alpha' }))] }),
    ];
    const healed = healFromTranscript(cached, rebuilt);
    expect(findCall(healed[0].tools, 'r1')).toMatchObject({ done: true, output: 'alpha' });
    expect(healed[0].text).toBe('answer');
  });

  it('gives a run kept as its summary its steps back, and how it ended', () => {
    const steps = run({
      status: 'done',
      agentId: 'a0000000000000004',
      model: 'claude-haiku-4-5-20251001',
      parts: [{ kind: 'tool', toolId: 'r1' }],
      tools: [call('r1', { done: true, parent: 'a1' })],
    });
    const cached = [
      reply({
        tools: [
          call('a1', {
            name: 'Agent',
            done: true,
            subagent: run({ status: 'interrupted', summary: 'What the copy kept.' }),
          }),
        ],
      }),
    ];
    const rebuilt = [
      reply({ id: 'x', tools: [call('a1', { name: 'Agent', done: true, subagent: steps })] }),
    ];
    const healed = runOf(healFromTranscript(cached, rebuilt)[0], 'a1');
    expect(healed).toMatchObject({
      status: 'done',
      agentId: 'a0000000000000004',
      model: 'claude-haiku-4-5-20251001',
      summary: 'What the copy kept.',
    });
    expect(healed.tools).toEqual(steps.tools);
    expect(healed.parts).toEqual(steps.parts);
  });

  it('puts reasoning back where it was, keeping the cached words', () => {
    const thought = (id: string): MessagePart => ({ kind: 'reasoning', id, text: `thought ${id}` });
    const cached = [
      reply({
        tools: [call('t1', { done: true })],
        parts: [
          { kind: 'text', id: 'text-1', text: 'as the copy has it' },
          { kind: 'tool', toolId: 't1' },
          { kind: 'text', id: 'text-2', text: 'answer' },
        ],
      }),
    ];
    const rebuilt = [
      reply({
        id: 'x',
        tools: [call('t1', { done: true })],
        parts: [
          thought('reasoning-1'),
          { kind: 'text', id: 'text-1', text: 'as the file has it' },
          { kind: 'tool', toolId: 't1' },
          thought('reasoning-2'),
          { kind: 'text', id: 'text-2', text: 'answer' },
        ],
      }),
    ];
    expect(healFromTranscript(cached, rebuilt)[0].parts).toEqual([
      thought('reasoning-1'),
      { kind: 'text', id: 'text-1', text: 'as the copy has it' },
      { kind: 'tool', toolId: 't1' },
      thought('reasoning-2'),
      { kind: 'text', id: 'text-2', text: 'answer' },
    ]);
    // Parts that do not line up get none: nothing is placed by guesswork.
    const other = [
      reply({
        id: 'x',
        tools: [call('t1', { done: true })],
        parts: [thought('reasoning-1'), { kind: 'tool', toolId: 't1' }],
      }),
    ];
    expect(healFromTranscript(cached, other)).toBe(cached);
  });

  it('takes the anchor, results and times a copy never kept, and parts when it had none', () => {
    const anchor = { sessionId: SESSION, uuid: 'u-9' };
    const result = { type: 'web_fetch', url: 'https://example.com/a' } as const;
    const cached = [reply({ tools: [call('t1', { done: true })] })];
    const rebuilt = [
      reply({
        id: 'x',
        anchor,
        tools: [call('t1', { done: true, result, startedAt: at(1), endedAt: at(2) })],
        parts: [
          { kind: 'tool', toolId: 't1' },
          { kind: 'text', id: 'text-1', text: 'answer' },
        ],
      }),
    ];
    const [healed] = healFromTranscript(cached, rebuilt);
    expect(healed.anchor).toEqual(anchor);
    expect(healed.tools[0]).toMatchObject({ result, startedAt: at(1), endedAt: at(2) });
    expect(healed.parts).toEqual(rebuilt[0].parts);
    // A copy whose answer reads otherwise keeps showing what it showed.
    const reworded = healFromTranscript([reply({ ...cached[0], text: 'other words' })], rebuilt);
    expect(reworded[0].parts).toBeUndefined();
  });

  it('heals the subagent golden’s reloaded copy back to its replay', () => {
    const g = golden('subagent');
    const replayed = replayTranscript(g.session?.events ?? [], sessionOf(g)).messages;
    // What a reload holds: no reasoning, no results, each run its summary.
    const reloaded = replayed.map((message) => ({
      ...message,
      ...(message.parts === undefined
        ? {}
        : { parts: message.parts.filter((part) => part.kind !== 'reasoning') }),
      tools: message.tools.map(({ result: _result, subagent, ...tool }) => ({
        ...tool,
        ...(subagent === undefined ? {} : { subagent: { ...subagent, parts: [], tools: [] } }),
      })),
    }));
    const healed = healFromTranscript(reloaded, replayed);
    expect(healed.map(shown)).toEqual(replayed.map(shown));
    // Healed once, there is nothing more to take.
    expect(healFromTranscript(healed, replayed)).toBe(healed);
  });
});

describe('replaceLastTurn carries the file’s parts and anchor (M91.4)', () => {
  it('swaps in the parts and anchor with the reply, and keeps an anchor the file lacks', () => {
    const cached: ChatMessage[] = [
      { id: 'u', role: 'user', text: 'q', tools: [] },
      {
        id: 'a',
        role: 'assistant',
        text: 'Half',
        tools: [],
        parts: [{ kind: 'text', id: 'text-1', text: 'Half' }],
        streaming: true,
        gap: true,
      },
    ];
    const g = golden('subagent');
    const file = replayTranscript(g.session?.events ?? [], sessionOf(g)).messages;
    const [, next] = replaceLastTurn(cached, 'a', file);
    expect(next.parts).toEqual(file[1].parts);
    expect(next.anchor).toEqual(file[1].anchor);
    expect(next.tools).toEqual(file[1].tools);
    const anchored = { ...cached[1], anchor: { sessionId: SESSION, uuid: 'u-1' } };
    const unended: ChatMessage[] = [
      { id: 'x', role: 'assistant', text: 'cut', tools: [], interrupted: true },
    ];
    const [, kept] = replaceLastTurn([cached[0], anchored], 'a', unended);
    expect(kept.anchor).toEqual({ sessionId: SESSION, uuid: 'u-1' });
    expect(kept.parts).toBeUndefined();
  });
});
