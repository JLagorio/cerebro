import { describe, expect, it } from 'vitest';
import type { ChatMessage, MessagePart, ToolCall } from '@/agent/types';
import { replayedTurn } from './runsTranscript';

/**
 * A replayed turn (M91.14): the conversation's lines, a chain open on the
 * run's latest turn or one holding a failure, its failure in Rust's words or
 * Claude Code's, and cut off only once its run is over.
 */

const call = (id: string, over: Partial<ToolCall> = {}): ToolCall => ({
  id,
  name: 'mcp__cerebro__get_note',
  input: '{"path":"a.md"}',
  output: 'ok',
  done: true,
  failed: false,
  ...over,
});

function reply(parts: MessagePart[], tools: ToolCall[], over: Partial<ChatMessage> = {}) {
  const text = parts.filter((part) => part.kind === 'text').at(-1);
  return {
    id: 's-t1-a',
    role: 'assistant',
    text: text?.kind === 'text' ? text.text : '',
    tools,
    parts,
    ...over,
  } satisfies ChatMessage;
}

const thought: MessagePart = { kind: 'reasoning', id: 'reasoning-1', text: 'Which risks moved?' };
const answer: MessagePart = { kind: 'text', id: 'text-1', text: 'Two **moved**.' };

describe('replayedTurn', () => {
  it('draws its reasoning and folded reads in one chain, then its answer', () => {
    const tools = [call('t1'), call('t2')];
    const turn = replayedTurn(
      reply(
        [thought, { kind: 'tool', toolId: 't1' }, { kind: 'tool', toolId: 't2' }, answer],
        tools,
      ),
      { live: false, latest: true },
    );
    expect(turn.lines.map((line) => line.kind)).toEqual(['chain', 'text']);
    const chain = turn.lines[0];
    if (chain.kind !== 'chain') throw new Error('no chain');
    expect(chain.steps.map((step) => step.kind)).toEqual(['reasoning', 'group']);
    const last = turn.lines[1];
    expect(last).toMatchObject({ kind: 'text', text: 'Two **moved**.', answer: true });
    expect(turn.failure).toBeNull();
    expect(turn.interrupted).toBe(false);
  });

  it("opens the run's latest chain, and an earlier one only when a step of its turn failed", () => {
    const parts: MessagePart[] = [thought, answer];
    expect(replayedTurn(reply(parts, []), { live: false, latest: true }).chainOpen).toBe(true);
    expect(replayedTurn(reply(parts, []), { live: false, latest: false }).chainOpen).toBe(false);
    const failed = call('t3', { failed: true, output: 'no such note' });
    const turn = replayedTurn(reply([thought, { kind: 'tool', toolId: 't3' }, answer], [failed]), {
      live: false,
      latest: false,
    });
    expect(turn.chainOpen).toBe(true);
    // The failure stands beside the chain, never folded into it.
    expect(turn.lines.map((line) => line.kind)).toEqual(['chain', 'row', 'text']);
    // A turn with no reasoning has no chain to open.
    expect(replayedTurn(reply([answer], []), { live: false, latest: true }).chainOpen).toBe(false);
  });

  it('runs an unfinished call while its run writes the turn, and is cut off once it is over', () => {
    const open = call('t1', { done: false, output: null });
    const cut = reply([{ kind: 'tool', toolId: 't1' }], [open], { interrupted: true });
    const live = replayedTurn(cut, { live: true, latest: true });
    expect(live.interrupted).toBe(false);
    expect(live.lines[0]).toMatchObject({ kind: 'row', row: { status: 'running' } });
    const over = replayedTurn(cut, { live: false, latest: true });
    expect(over.interrupted).toBe(true);
    expect(over.lines[0]).toMatchObject({ kind: 'row', row: { status: 'interrupted' } });
  });

  it("says a failure in Rust's title when it typed it, else in Claude Code's words", () => {
    const notice = {
      kind: 'rate_limit',
      title: 'Usage limit reached',
      body: '',
      action: null,
      resets_at: null,
      window: null,
      cli_version: null,
    };
    expect(
      replayedTurn(reply([], [], { error: 'raw words', notice }), { live: false, latest: true })
        .failure,
    ).toEqual({ typed: true, text: 'Usage limit reached' });
    expect(
      replayedTurn(reply([], [], { error: 'Error: boom' }), { live: false, latest: true }).failure,
    ).toEqual({ typed: false, text: 'Error: boom' });
  });
});
