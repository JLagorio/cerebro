// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RENDERERS, TranscriptRows } from '@/agent/toolRenderers';
import type { ToolCall } from '@/agent/types';
import { TOOLS } from '@/lib/policy/tools';

/**
 * Rows drawn by the manifest's renderer (M56.8). The renderer vocabulary is
 * the manifest's, so this holds RENDERERS to it, and every single row to the
 * action card's test ids.
 */

afterEach(cleanup);

let next = 0;
function call(name: string, over: Partial<ToolCall> = {}): ToolCall {
  next += 1;
  return {
    id: `t-${next}`,
    name: name.startsWith('mcp__') || /^[A-Z]/.test(name) ? name : `mcp__cerebro__${name}`,
    input: '{}',
    output: 'ok',
    done: true,
    failed: false,
    ...over,
  };
}

function rows(tools: ToolCall[], streaming = false, onOpenPath = vi.fn()) {
  render(<TranscriptRows tools={tools} streaming={streaming} onOpenPath={onOpenPath} />);
  return onOpenPath;
}

describe('RENDERERS', () => {
  it('draws every renderer the manifest uses, and no other', () => {
    const used = new Set<string>([
      ...TOOLS.tools.map((row) => row.renderer),
      ...TOOLS.cli_tools.map((row) => row.renderer),
      TOOLS.generated.renderer,
    ]);
    for (const renderer of used) expect(RENDERERS, renderer).toHaveProperty(renderer);
    expect(Object.keys(RENDERERS).sort()).toEqual(
      ['change', 'commit', 'concept', 'handoff', 'step', 'view'].sort(),
    );
  });
});

describe('TranscriptRows', () => {
  it('folds five reads into a group that expands to their cards', () => {
    const tools = Array.from({ length: 5 }, (_, i) =>
      call('get_note', { input: JSON.stringify({ path: `notes/n-${i}.md` }) }),
    );
    rows(tools);
    const group = screen.getByTestId('action-group');
    expect(group.getAttribute('data-count')).toBe('5');
    expect(within(group).getByTestId('action-group-toggle').textContent).toContain('Read 5 notes');
    const cards = within(group).getAllByTestId('action-card');
    expect(cards).toHaveLength(5);
    // Folded: mounted, but out of sight.
    expect(cards[0].parentElement?.hidden).toBe(true);
    fireEvent.click(within(group).getByTestId('action-group-toggle'));
    expect(cards[0].parentElement?.hidden).toBe(false);
    expect(cards.every((card) => card.getAttribute('data-tool') === 'mcp__cerebro__get_note')).toBe(
      true,
    );
  });

  it('spins a group while a member runs', () => {
    rows([call('get_note'), call('get_note', { done: false, output: null })], true);
    const group = screen.getByTestId('action-group');
    expect(group.getAttribute('data-status')).toBe('running');
    expect(group.querySelector('.animate-spin')).not.toBeNull();
  });

  it('names the agent a handoff went to, and says when it could not go', () => {
    rows([
      call('hand_to', { input: JSON.stringify({ agent: 'release-scout', message: 'Go.' }) }),
      call('hand_to', {
        input: JSON.stringify({ agent: 'night-owl', message: 'Go.' }),
        failed: true,
        output: 'night-owl is paused, so it cannot be called.',
      }),
    ]);
    const [sent, refused] = screen.getAllByTestId('action-card');
    expect(sent.getAttribute('data-renderer')).toBe('handoff');
    expect(sent.textContent).toContain('Handed to release-scout');
    expect(refused.textContent).toContain("Couldn't hand to night-owl");
    expect(within(refused).getByTestId('action-handoff-refusal').textContent).toBe(
      'night-owl is paused, so it cannot be called.',
    );
  });

  it('counts what a commit decided, and shows a refusal’s code', () => {
    rows([
      call('commit_proposals', {
        output: JSON.stringify({
          commit_set_id: 'cs-1',
          transition: 'initial_queue',
          results: [{ id: 'p-1' }, { id: 'p-2' }, { id: 'p-3' }],
          batch_id: 'b-1',
          replayed: false,
          kept_files: ['knowledge/metrics/churn.md'],
        }),
      }),
      call('commit_proposals', {
        output: JSON.stringify({ outcome: 'refused', code: 'stale_target_version', detail: 'x' }),
      }),
      call('commit_proposals', { output: 'not the answer' }),
    ]);
    const [committed, refused, raw] = screen.getAllByTestId('action-card');
    expect(committed.getAttribute('data-renderer')).toBe('commit');
    expect(committed.textContent).toContain('Committed 3 proposals');
    expect(within(committed).getByTestId('action-commit-detail').textContent).toBe(
      'initial queue · knowledge/metrics/churn.md',
    );
    expect(refused.textContent).toContain('Commit refused: stale_target_version');
    // Neither shape: the card as it was, its output a click away.
    expect(raw.textContent).toContain('commit proposals');
  });

  it('reads a commit’s whole payload before its preview', () => {
    const answer = JSON.stringify({
      transition: 'apply',
      results: [{ id: 'p-1' }],
      kept_files: [],
    });
    rows([
      call('commit_proposals', {
        output: `${answer.slice(0, 10)}…`,
        payload: { output: answer, outputBytes: answer.length, outputTruncated: false },
      }),
    ]);
    expect(screen.getByTestId('action-card').textContent).toContain('Committed 1 proposal');
  });

  it('offers a written concept to review', () => {
    const onOpenPath = rows([
      call('write_concept', { input: JSON.stringify({ path: 'knowledge/metrics/churn.md' }) }),
    ]);
    const card = screen.getByTestId('action-card');
    expect(card.getAttribute('data-renderer')).toBe('concept');
    expect(card.getAttribute('data-write')).toBe('true');
    fireEvent.click(within(card).getByRole('button', { name: 'Open to review' }));
    expect(onOpenPath).toHaveBeenCalledWith('knowledge/metrics/churn.md');
  });

  it('offers no review for a concept write that failed', () => {
    rows([
      call('write_concept', {
        input: JSON.stringify({ path: 'knowledge/metrics/churn.md' }),
        failed: true,
      }),
    ]);
    expect(screen.queryByTestId('action-open-review')).toBeNull();
  });

  it('draws an unknown tool generic, by its raw name', () => {
    rows([call('SomethingNew'), call('mcp__gmail__search_threads')]);
    const [unknown, connector] = screen.getAllByTestId('action-card');
    expect(unknown.getAttribute('data-renderer')).toBe('step');
    expect(unknown.textContent).toContain('SomethingNew');
    expect(connector.textContent).toContain('search threads');
    expect(within(connector).getByTestId('action-server').textContent).toBe('gmail');
  });

  it('keeps action-card, data-tool and data-write on every single row', () => {
    rows([
      call('get_note'),
      call('edit_note'),
      call('hand_to'),
      call('commit_proposals'),
      call('write_concept'),
      call('get_note', { failed: true }),
      call('get_note', { done: false, output: null }),
    ]);
    const cards = screen.getAllByTestId('action-card');
    expect(cards).toHaveLength(7);
    for (const card of cards) {
      expect(card.getAttribute('data-tool')).not.toBeNull();
      expect(['true', 'false']).toContain(card.getAttribute('data-write'));
      expect(card.getAttribute('data-renderer')).not.toBeNull();
      expect(card.getAttribute('data-status')).not.toBeNull();
    }
    expect(cards.map((card) => card.getAttribute('data-status'))).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'failed',
      'interrupted',
    ]);
  });
});

describe('a held call (M57.1)', () => {
  it('says each deferred status in its own words, with its data-status', () => {
    const held = call('append_to_note', {
      input: JSON.stringify({ path: 'notes/inbox.md' }),
      output: null,
      done: false,
      deferred: true,
    });
    const cases = [
      [{}, held.id, 'waiting', 'Waiting for your answer'],
      [{ cancelled: true }, null, 'cancelled', 'Cancelled: it did not run'],
      [{}, null, 'not_run', 'Not run: it waited for an answer that never came'],
      [
        { paused: true },
        null,
        'paused',
        'Paused by a hook outside Cerebro; your next message refuses it',
      ],
    ] as const;
    for (const [over, waitingToolId, status, words] of cases) {
      render(
        <TranscriptRows
          tools={[{ ...held, ...over }]}
          streaming={false}
          onOpenPath={vi.fn()}
          waitingToolId={waitingToolId}
        />,
      );
      const card = screen.getByTestId('action-card');
      expect(card.getAttribute('data-status'), status).toBe(status);
      expect(screen.getByTestId('action-deferred').textContent).toBe(words);
      expect(screen.queryByTestId('action-interrupted')).toBeNull();
      expect(card.querySelector('.animate-spin')).toBeNull();
      cleanup();
    }
  });

  it('draws a held handoff as the plain card, never as handed', () => {
    render(
      <TranscriptRows
        tools={[
          call('hand_to', {
            input: JSON.stringify({ agent: 'scout', task: 'x' }),
            output: null,
            done: false,
            deferred: true,
          }),
        ]}
        streaming={false}
        onOpenPath={vi.fn()}
      />,
    );
    expect(screen.getByTestId('action-card').textContent).not.toContain('Handed to');
    expect(screen.getByTestId('action-deferred')).toBeTruthy();
  });
});
