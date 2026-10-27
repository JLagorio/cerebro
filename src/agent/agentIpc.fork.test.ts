import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FORK_REFUSED,
  onAgentEvent,
  readCliTranscript,
  runAgent,
  type RunHandle,
} from './agentIpc';
import {
  confirmMockInteraction,
  listMockInteractions,
  registerMockInteraction,
  resetMockInteractions,
} from './mockInteractions';
import { replayTranscript } from './transcript';
import type { AgentEvent, AgentStreamEvent, ForkPoint } from './types';
import * as mock from '@/lib/mockIpc';

/**
 * A branch in the browser (M91.6): the mock mints the branch's session as
 * Rust does, after finding its anchor where a turn of its source ended, and
 * copies the source's replay up to that turn under it, as Claude Code copies
 * the source's lines into the branch's file. Refusals are Rust's words.
 */

const VAULT = '/demo-vault';

beforeEach(() => {
  mock.resetMockFs();
  resetMockInteractions();
});

function start(message: string, sessionId: string | null, fork?: ForkPoint) {
  return runAgent(VAULT, {
    message,
    sessionId,
    ...(fork === undefined ? {} : { fork }),
    shell: 'off',
    connectors: false,
    attended: true,
  });
}

/** Ask, and resolve once the run said Done. */
async function ask(
  message: string,
  sessionId: string | null,
  fork?: ForkPoint,
): Promise<RunHandle> {
  const started = await start(message, sessionId, fork);
  if ('deferred' in started || 'settled' in started || 'observed_generation' in started) {
    throw new Error('an attended run is never deferred or settled');
  }
  await new Promise<void>((resolve) => {
    const off = onAgentEvent((event) => {
      if (event.kind !== 'Done') return;
      off();
      resolve();
    }, started.run);
  });
  return started;
}

/** What reading a session back gives: its events, which must be there. */
async function eventsOf(session: string): Promise<AgentStreamEvent[]> {
  const read = await readCliTranscript(VAULT, session, null);
  if (read.state !== 'read') throw new Error(`${session} reads ${read.reason}`);
  return read.events;
}

const anchorsOf = (events: AgentStreamEvent[]): string[] =>
  events.flatMap((event) =>
    event.kind === 'TurnEnded' && event.last_uuid !== undefined ? [event.last_uuid] : [],
  );

/** A source of two turns, each ending where a branch may start. */
async function twoTurns(): Promise<{ source: string; anchors: string[] }> {
  const first = await ask('think it through', null);
  const source = first.sessionId ?? '';
  await ask('make a todo list', source);
  const anchors = anchorsOf(await eventsOf(source));
  expect(anchors).toHaveLength(2);
  return { source, anchors };
}

describe('a branch in the browser (M91.6)', () => {
  it('forks the source’s replay up to its anchor into a session of its own', async () => {
    const { source, anchors } = await twoTurns();
    const before = await eventsOf(source);
    const branch = await ask('search the web', null, { from: source, at: anchors[0] });
    const minted = branch.sessionId ?? '';
    expect(minted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(minted).not.toBe(source);
    const copied = await eventsOf(minted);
    const end = before.findIndex((event) => event.kind === 'TurnEnded');
    expect(copied.slice(0, end + 1)).toEqual(before.slice(0, end + 1));
    const prompts = copied.flatMap((event) => (event.kind === 'UserPrompt' ? [event.text] : []));
    expect(prompts).toEqual(['think it through', 'search the web']);
    // The source is as it was, and the branch rebuilds whole from its own.
    expect(await eventsOf(source)).toEqual(before);
    const replayed = replayTranscript(copied, minted).messages;
    expect(replayed.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(replayed[1].anchor).toEqual({ sessionId: minted, uuid: anchors[0] });
  });

  it('refuses as Rust does, in its words, and starts nothing', async () => {
    const { source, anchors } = await twoTurns();
    const heard: AgentEvent[] = [];
    const off = onAgentEvent((event) => heard.push(event));
    const gone = '00000000-0000-4000-8000-000000000404';
    mock.__seedCliTranscript(gone, {
      state: 'unavailable',
      reason: 'unreadable',
      retention_days: 30,
    });
    for (const [sessionId, fork, words] of [
      [
        null,
        { from: source, at: '00000000-0000-4000-8000-000000000999' },
        FORK_REFUSED.notAnAnchor,
      ],
      [null, { from: 'mock-session', at: anchors[0] }, FORK_REFUSED.malformed],
      [null, { from: source, at: '../../etc/passwd' }, FORK_REFUSED.malformed],
      [
        null,
        { from: '00000000-0000-4000-8000-000000000123', at: anchors[0] },
        FORK_REFUSED.noSource,
      ],
      [null, { from: gone, at: anchors[0] }, FORK_REFUSED.unreadable],
      [source, { from: source, at: anchors[0] }, FORK_REFUSED.alsoResumes],
    ] as const) {
      await expect(start('search the web', sessionId, fork), JSON.stringify(fork)).rejects.toThrow(
        words,
      );
    }
    off();
    expect(heard).toEqual([]);
  });

  it('leaves the card its source waits on waiting', async () => {
    const { source, anchors } = await twoTurns();
    const card = confirmMockInteraction(
      registerMockInteraction(
        VAULT,
        source,
        'toolu_source',
        'mcp__cerebro__append_to_note',
        '{}',
        () => undefined,
      ),
    );
    expect(card).not.toBeNull();
    await ask('search the web', null, { from: source, at: anchors[1] });
    expect(
      listMockInteractions(VAULT).map((waiting) => [waiting.session_id, waiting.tool_id]),
    ).toEqual([[source, 'toolu_source']]);
  });

  it('gives each refusal in the words Rust’s ForkRefused gives it', () => {
    const rust = readFileSync(join(__dirname, '../../src-tauri/src/agent/transcript.rs'), 'utf8');
    for (const words of Object.values(FORK_REFUSED)) expect(rust).toContain(`"${words}"`);
  });
});
