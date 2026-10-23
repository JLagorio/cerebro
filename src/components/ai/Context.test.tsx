// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOVER_OPEN_MS, resetHoverCards } from '@/components/ui/HoverCard';
import { resetLayers } from '@/components/ui/layers';
import { CONTEXT_WORDS, Context, contextName, contextShare, type ContextUsage } from './Context';

/**
 * Context (M91.8): the reading is the control's name, never "Context: …";
 * the ring is decoration; and a count nobody recorded is words, never 0
 * (CV-05) — not recorded and unavailable are different sentences.
 */

beforeEach(() => {
  vi.useFakeTimers();
  resetHoverCards();
  resetLayers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let at = 0;
/** Hovers `el` with a real move (jsdom has no PointerEvent), until its card
 *  is up. */
function hover(el: Element) {
  at += 7;
  act(() => {
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, screenX: at, screenY: at }));
  });
  act(() => {
    vi.advanceTimersByTime(HOVER_OPEN_MS);
  });
}

const RECORDED: ContextUsage = {
  state: 'recorded',
  used: 124_000,
  window: 200_000,
  model: 'claude-sonnet-4-5',
};

describe('the reading, in words', () => {
  it.each<[ContextUsage, string]>([
    [RECORDED, '62% of context used'],
    [{ state: 'recorded', used: 600, window: 200_000 }, 'Less than 1% of context used'],
    [{ state: 'recorded', used: 0, window: 200_000 }, '0% of context used'],
    [{ state: 'recorded', used: 41_200, window: null }, '41,200 tokens of context used'],
    [{ state: 'recorded', used: 41_200, window: 0 }, '41,200 tokens of context used'],
    [{ state: 'not_recorded' }, 'Context use not recorded'],
    [{ state: 'recorded', used: Number.NaN, window: 200_000 }, 'Context use not recorded'],
    [{ state: 'recorded', used: -1, window: 200_000 }, 'Context use not recorded'],
    [{ state: 'unavailable' }, 'Context use unavailable'],
  ])('%j reads “%s”', (usage, name) => {
    expect(contextName(usage)).toBe(name);
    expect(contextName(usage)).not.toMatch(/^Context:/);
    render(<Context usage={usage} />);
    expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('knows a share only from a recorded window', () => {
    expect(contextShare(RECORDED)).toBeCloseTo(0.62);
    expect(contextShare({ state: 'recorded', used: 5 })).toBeNull();
    expect(contextShare({ state: 'not_recorded' })).toBeNull();
  });
});

describe('the toolbar control', () => {
  it('draws the ring as decoration, an arc for the share, and the figure beside it', () => {
    render(<Context usage={RECORDED} testId="context" />);
    const control = screen.getByTestId('context');
    const ring = control.querySelector('svg') as SVGElement;
    expect(ring.getAttribute('aria-hidden')).toBe('true');
    expect(ring.querySelector('.cb-ai-context-arc')).toBeTruthy();
    expect(control.textContent).toBe('62%');
    expect(control.dataset.state).toBe('recorded');
    expect(control.dataset.level).toBeUndefined();
  });

  it('takes an explicit tab stop when its caller gives one, and sets none otherwise', () => {
    // WebKit leaves a native button with no explicit tab stop out of the Tab
    // order, so the composer asks for one.
    const { rerender } = render(<Context usage={RECORDED} testId="context" />);
    expect(screen.getByTestId('context').hasAttribute('tabindex')).toBe(false);
    rerender(<Context usage={RECORDED} testId="context" tabIndex={0} />);
    expect(screen.getByTestId('context').getAttribute('tabindex')).toBe('0');
  });

  it('draws no arc and no figure for an absent reading: never a zero', () => {
    for (const usage of [{ state: 'not_recorded' }, { state: 'unavailable' }] as ContextUsage[]) {
      const { unmount } = render(<Context usage={usage} testId="context" />);
      const control = screen.getByTestId('context');
      expect(control.querySelector('.cb-ai-context-arc')).toBeNull();
      expect(control.textContent).toBe('');
      expect(control.dataset.state).toBe(usage.state);
      unmount();
    }
  });

  it('shows the tokens when the window is unknown, and warns as the window fills', () => {
    const { rerender } = render(
      <Context usage={{ state: 'recorded', used: 41_200 }} testId="context" />,
    );
    expect(screen.getByTestId('context').textContent).toBe('41.2K');
    rerender(
      <Context usage={{ state: 'recorded', used: 170_000, window: 200_000 }} testId="context" />,
    );
    expect(screen.getByTestId('context').dataset.level).toBe('high');
    rerender(
      <Context usage={{ state: 'recorded', used: 199_000, window: 200_000 }} testId="context" />,
    );
    expect(screen.getByTestId('context').dataset.level).toBe('full');
    rerender(
      <Context usage={{ state: 'recorded', used: 600, window: 200_000 }} testId="context" />,
    );
    expect(screen.getByTestId('context').textContent).toBe('<1%');
  });
});

describe('the detail', () => {
  it('opens on hover: used of the window, the model and the breakdown, absent counts in words', () => {
    render(
      <Context
        usage={{
          ...RECORDED,
          breakdown: { input: 3_000, cacheRead: 120_000, cacheWrite: null, output: 1_000 },
        }}
      />,
    );
    const control = screen.getByRole('button', { name: '62% of context used' });
    hover(control);
    const card = screen.getByRole('group', { name: 'Context use' });
    expect(control.getAttribute('aria-describedby')).toBe(card.id);
    expect(card.textContent).toContain('124,000 of 200,000 tokens');
    expect(card.textContent).toContain('62% used');
    expect(card.textContent).toContain('claude-sonnet-4-5');
    const rows = [...card.querySelectorAll('dt')].map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ]);
    expect(rows).toEqual([
      ['Model', 'claude-sonnet-4-5'],
      ['Input', '3,000'],
      ['Cache read', '120,000'],
      ['Cache write', CONTEXT_WORDS.valueNotRecorded],
      ['Output', '1,000'],
    ]);
    expect(card.querySelector('.cb-ai-context-meter')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('says what is missing: an unreported window, an unreported model', () => {
    render(<Context usage={{ state: 'recorded', used: 41_200, model: null }} />);
    hover(screen.getByRole('button'));
    const card = screen.getByRole('group', { name: 'Context use' });
    expect(card.textContent).toContain('41,200 tokens used');
    expect(card.textContent).toContain(CONTEXT_WORDS.windowNotRecorded);
    expect(card.querySelector('dd')?.textContent).toBe(CONTEXT_WORDS.valueNotRecorded);
    expect(card.textContent).not.toMatch(/\b0 tokens\b/);
  });

  it.each<[ContextUsage, string, string]>([
    [{ state: 'not_recorded' }, CONTEXT_WORDS.notRecorded, CONTEXT_WORDS.notRecordedDetail],
    [{ state: 'unavailable' }, CONTEXT_WORDS.unavailable, CONTEXT_WORDS.unavailableDetail],
  ])('%j says so, and no number', (usage, title, detail) => {
    render(<Context usage={usage} />);
    hover(screen.getByRole('button'));
    const card = screen.getByRole('group', { name: 'Context use' });
    expect(card.textContent).toBe(`${title}${detail}`);
    expect(card.textContent).not.toMatch(/\d/);
  });
});
