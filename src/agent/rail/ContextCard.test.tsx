// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextUseRecorded } from '@/agent/agentIpc';
import { contextUsageOf } from '@/agent/elements/composerContext';
import { RAIL_CONTEXT_WORDS, railContext, type RailContext } from '@/agent/elements/contextCard';
import type { ContextUseState } from '@/agent/useContextUse';
import { Context } from '@/components/ai/Context';
import type { ContextBreakdown } from '@/engine/ai/contextBreakdown';
import { ContextCard } from './ContextCard';

/**
 * The rail's Context card (M92.14): the composer ring's figure on its
 * heading line, the breakdown's rows under a bar of the window, the
 * servers folded, and when the reading was read; quiet with no turns, and
 * the reason in words wherever it shows less than the whole (CV-05).
 */

afterEach(cleanup);

const AT = '2026-07-28T11:58:00.000Z';
const SESSION = '00000000-0000-4000-8000-000000092148';

const BREAKDOWN: ContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 6_797, kind: 'used' },
    { name: 'System tools', tokens: 7_030, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 438, kind: 'deferred' },
    { name: 'Messages', tokens: 19_420, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
    { name: 'Free space', tokens: 133_753, kind: 'free' },
  ],
  total: 33_247,
  max: 200_000,
  model: 'claude-sonnet-5',
  autocompact: { enabled: true, threshold: 167_000 },
  mcpServers: [
    { name: 'cerebro', tools: 31, loaded: 2, tokens: 412 },
    { name: 'gmail', tools: 12, loaded: 0, tokens: 0 },
  ],
  memoryFiles: 1,
};

function recorded(over: Partial<ContextUseRecorded> = {}): ContextUseRecorded {
  return {
    state: 'recorded',
    used: 33_247,
    window: 200_000,
    model: 'claude-sonnet-5',
    at: AT,
    breakdown: BREAKDOWN,
    ...over,
  };
}

const cardOf = (reading: ContextUseState, streaming = false, session: string | null = SESSION) =>
  railContext(reading, { session, streaming });

function draw(context: RailContext, folded = false) {
  return render(<ContextCard context={context} folded={folded} />);
}

const card = () => screen.getByTestId('rail-context');
const heading = () => within(card()).getByRole('heading', { level: 3 });
/** The legend's rows, each its name and its value. */
const legend = () =>
  [...card().querySelectorAll('.cb-ai-context-legend-row')].map((row) => [
    row.querySelector('dt')?.textContent,
    row.querySelector('dd')?.textContent,
  ]);

describe('ContextCard', () => {
  it('heads with how full the context is, then the tokens, the rows and the facts', () => {
    draw(cardOf(recorded()));
    expect(card().dataset.state).toBe('ready');
    expect(screen.getByRole('group', { name: 'Context' })).toBe(card());
    expect(within(card()).getByRole('button', { name: 'Context 17% used' })).toBeTruthy();
    expect(screen.getByTestId('rail-context-figure').textContent).toBe('33,247 of 200,000 tokens');
    expect(legend()).toEqual([
      ['System prompt', '6.8K · 3.4%'],
      ['System tools', '7K · 3.5%'],
      ['MCP tools (deferred)', 'not loaded'],
      ['Messages', '19.4K · 9.7%'],
      ['Autocompact buffer', '33K · 16.5%'],
      ['Free space', '133.8K · 66.9%'],
    ]);
    const facts = [...card().querySelectorAll('.cb-rail-context-facts dt')].map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ]);
    expect(facts).toEqual([
      ['Model', 'claude-sonnet-5'],
      ['Autocompact', 'at 167,000 tokens'],
      ['Memory files', '1'],
    ]);
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });

  it('draws the used rows and the reserve on a bar of the window, and the deferred ones off it', () => {
    draw(cardOf(recorded()));
    const bar = card().querySelector('[data-slot="context-bar"]') as HTMLElement;
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    const shares = [...bar.children].map((segment) => {
      const el = segment as HTMLElement;
      return [el.dataset.tone ?? el.dataset.kind, el.style.flexGrow];
    });
    expect(shares).toEqual([
      ['0', '6797'],
      ['1', '7030'],
      ['2', '19420'],
      ['free', `${200_000 - 6_797 - 7_030 - 19_420 - 33_000}`],
      ['buffer', '33000'],
    ]);
  });

  it('reads a deferred row and a server with nothing loaded as not loaded, never 0 or a dash', () => {
    draw(cardOf(recorded()));
    const deferred = card().querySelector('.cb-ai-context-legend-row[data-kind="deferred"] dd');
    expect(deferred?.textContent).toBe('not loaded');
    const gmail = card().querySelector('.cb-rail-context-server[data-deferred] dd');
    expect(gmail?.textContent).toBe('not loaded');
    expect(card().textContent).not.toMatch(/—/);
  });

  it('folds the servers under one line that is its own tab stop', () => {
    draw(cardOf(recorded()));
    const servers = screen.getByTestId('rail-context-servers');
    const fold = within(servers).getByRole('button', { name: 'MCP servers 2' });
    expect(fold.getAttribute('tabindex')).toBe('0');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    const rows = [...servers.querySelectorAll('.cb-rail-context-server')].map((row) => [
      row.querySelector('.cb-rail-context-server-name')?.textContent,
      row.querySelector('.cb-rail-context-server-tools')?.textContent,
      row.querySelector('dd')?.textContent,
    ]);
    expect(rows).toEqual([
      ['cerebro', '31 tools, 2 loaded', '412'],
      ['gmail', '12 tools', 'not loaded'],
    ]);
  });

  it('says when the reading was read, and from the previous turn while a turn streams', () => {
    const reading = recorded();
    const { rerender } = draw(cardOf(reading));
    const fresh = () => screen.getByTestId('rail-context-freshness');
    expect(fresh().textContent).toMatch(/^Read when the last turn ended, /);
    expect(fresh().querySelector('time')?.getAttribute('datetime')).toBe(AT);
    rerender(<ContextCard context={cardOf(reading, true)} folded={false} />);
    expect(fresh().textContent).toMatch(/^From the previous turn, /);
  });

  it('is the count alone with no breakdown for the turn, and says so', () => {
    draw(cardOf(recorded({ used: 124_000, breakdown: undefined })));
    expect(card().dataset.state).toBe('partial');
    expect(within(card()).getByRole('button', { name: 'Context 62% used' })).toBeTruthy();
    expect(screen.getByTestId('rail-context-figure').textContent).toBe('124,000 of 200,000 tokens');
    expect(card().textContent).toContain(RAIL_CONTEXT_WORDS.noBreakdown);
    expect(screen.queryByTestId('rail-context-categories')).toBeNull();
    expect(screen.queryByTestId('rail-context-servers')).toBeNull();
  });

  it('lists the rows without shares or a bar when no window was reported', () => {
    const { max: _max, ...noMax } = BREAKDOWN;
    draw(cardOf(recorded({ used: 41_200, window: undefined, breakdown: noMax })));
    expect(card().dataset.state).toBe('partial');
    expect(card().textContent).toContain(RAIL_CONTEXT_WORDS.noWindow);
    expect(card().querySelector('[data-slot="context-bar"]')).toBeNull();
    expect(legend()[0]).toEqual(['System prompt', '6.8K']);
  });

  it('says nothing was recorded yet, and when it will be', () => {
    draw(cardOf({ state: 'not_recorded' }));
    expect(card().dataset.state).toBe('not-recorded');
    expect(card().textContent).toContain("Context use not recordedIt's read when a turn ends.");
    expect(screen.queryByTestId('rail-context-figure')).toBeNull();
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });

  it('says a read that failed could not be read, never that nothing was recorded', () => {
    draw(cardOf({ state: 'unavailable' }));
    expect(card().dataset.state).toBe('unavailable');
    expect(screen.getByTestId('section-unavailable').textContent).toBe(
      RAIL_CONTEXT_WORDS.unavailable,
    );
    expect(card().textContent).not.toContain(RAIL_CONTEXT_WORDS.notRecorded);
  });

  it('is one quiet line before the conversation’s first turn', () => {
    draw(cardOf({ state: 'not_recorded' }, false, null));
    expect(card().dataset.state).toBe('empty');
    expect(heading().textContent).toBe('ContextNo turns yet');
    expect(within(card()).queryByRole('button')).toBeNull();
  });

  it('draws nothing while the pull waits for its first answer', () => {
    draw(cardOf({ state: 'loading' }));
    expect(screen.queryByTestId('rail-context')).toBeNull();
  });

  it('keeps what it drew while folded, and draws the latest as the rail unfolds', () => {
    const { rerender } = draw(cardOf(recorded({ used: 124_000, breakdown: undefined })), true);
    expect(card().dataset.state).toBe('partial');
    rerender(<ContextCard context={cardOf(recorded())} folded />);
    expect(card().dataset.state).toBe('partial');
    rerender(<ContextCard context={cardOf(recorded())} folded={false} />);
    expect(card().dataset.state).toBe('ready');
  });

  it('shows the composer ring’s own figure', () => {
    const reading = recorded();
    render(
      <>
        <Context usage={contextUsageOf(reading)} testId="ring" />
        <ContextCard context={cardOf(reading)} folded={false} />
      </>,
    );
    const ring = screen.getByTestId('ring').textContent ?? '';
    expect(ring).toBe('17%');
    expect(heading().textContent).toBe(`Context${ring} used`);
  });
});
