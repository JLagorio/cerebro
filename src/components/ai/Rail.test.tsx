// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rail, RailSection, type RailSectionState } from './Rail';

/**
 * The rail (M92.1): a region named by its heading, its cards in a list under
 * it. An empty card is one quiet line; any other keeps its body under a fold
 * that is a tab stop of its own (WebKit skips a native button without one).
 * Presentation only, like the rest of the layer (boundary.test.ts).
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const heading = () => screen.getByRole('heading', { level: 2, name: 'Conversation details' });

describe('Rail', () => {
  it('is a region named by its heading, which takes focus without being a tab stop', () => {
    const ref = createRef<HTMLHeadingElement>();
    render(
      <Rail
        id="rail-1"
        title="Conversation details"
        headingRef={ref}
        className="host-rail"
        data-testid="rail"
      >
        <p>A card</p>
      </Rail>,
    );
    const region = screen.getByRole('region', { name: 'Conversation details' });
    expect(region).toBe(screen.getByTestId('rail'));
    expect(region.id).toBe('rail-1');
    expect(region.className).toBe('cb-ai-rail host-rail');
    expect(ref.current).toBe(heading());
    expect(heading().tabIndex).toBe(-1);
    ref.current?.focus();
    expect(document.activeElement).toBe(heading());
    const cards = region.querySelector('[data-slot="rail-cards"]');
    expect(cards?.textContent).toBe('A card');
  });

  it('with no cards, is its heading over an empty list', () => {
    render(<Rail title="Conversation details" />);
    const region = screen.getByRole('region', { name: 'Conversation details' });
    expect(region.querySelector('[data-slot="rail-cards"]')?.childElementCount).toBe(0);
    expect(region.querySelectorAll('[data-slot="rail-section"]')).toHaveLength(0);
  });
});

describe('RailSection', () => {
  it('draws an empty card as one heading line ending in None, with nothing to open', () => {
    render(
      <RailSection data-testid="rail-sources" title="Sources" icon="book-open" state="empty">
        <p>Never drawn</p>
      </RailSection>,
    );
    const card = screen.getByTestId('rail-sources');
    expect(card.dataset.state).toBe('empty');
    expect(screen.getByRole('group', { name: 'Sources' })).toBe(card);
    expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe('SourcesNone');
    expect(within(card).queryByRole('button')).toBeNull();
    expect(within(card).queryByText('Never drawn')).toBeNull();
  });

  it('says what an empty card holds in its own words, when it has them', () => {
    render(<RailSection title="Context" state="empty" none="No turns yet" />);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('ContextNo turns yet');
  });

  it.each<RailSectionState>(['ready', 'not-recorded', 'partial', 'unavailable'])(
    'keeps a %s card fully visible, its body under a fold that is a tab stop',
    (state) => {
      render(
        <RailSection data-testid="rail-plan" title="Plan" count="3 of 5 done" state={state}>
          <p>The list</p>
        </RailSection>,
      );
      const card = screen.getByTestId('rail-plan');
      expect(card.dataset.state).toBe(state);
      expect(screen.getByRole('group', { name: 'Plan' })).toBe(card);
      const fold = within(card).getByRole('button', { name: 'Plan 3 of 5 done' });
      expect(fold.closest('h3')).not.toBeNull();
      expect(fold.tabIndex).toBe(0);
      expect(fold.getAttribute('aria-expanded')).toBe('true');
      const body = document.getElementById(fold.getAttribute('aria-controls')!)!;
      expect(body.textContent).toBe('The list');
      fireEvent.click(fold);
      expect(fold.getAttribute('aria-expanded')).toBe('false');
      // Folded, the body stays in the document, so what it holds keeps its
      // own state.
      expect(body.isConnected).toBe(true);
      expect(body.hidden).toBe(true);
      fireEvent.click(fold);
      expect(body.hidden).toBe(false);
    },
  );

  it('folds as its host says, and tells the host when the reader folds it', () => {
    const heard: boolean[] = [];
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <RailSection
          title="Subagents"
          count="2 done"
          state="ready"
          open={open}
          onOpenChange={(next) => {
            heard.push(next);
            setOpen(next);
          }}
        >
          <p>Two rows</p>
        </RailSection>
      );
    }
    render(<Host />);
    const fold = screen.getByRole('button', { name: 'Subagents 2 done' });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(fold);
    expect(heard).toEqual([true]);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
  });

  it('adds no window or document keydown listener (CV-47), and names only icons that exist', () => {
    const onWindow = vi.spyOn(window, 'addEventListener');
    const onDocument = vi.spyOn(document, 'addEventListener');
    render(
      <Rail title="Conversation details">
        <RailSection title="Plan" icon="list-todo" count="1 of 2 done" state="ready">
          <p>A step</p>
        </RailSection>
        <RailSection title="Sources" icon="book-open" state="empty" />
      </Rail>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Plan 1 of 2 done' }));
    const keydowns = [...onWindow.mock.calls, ...onDocument.mock.calls].filter(
      ([type]) => type === 'keydown',
    );
    expect(keydowns).toEqual([]);
    expect(document.querySelectorAll('[data-unknown-icon]')).toHaveLength(0);
  });
});

describe('rail.css', () => {
  const css = readFileSync(resolve(__dirname, 'rail.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('spends motion tokens, never a duration of its own', () => {
    for (const [, value] of css.matchAll(/(?:transition|animation)[\w-]*:([^;]+);/g)) {
      expect(value).toMatch(/var\(--(?:motion|dur)-/);
      expect(value).not.toMatch(/(?<![\w-])\d*\.?\d+m?s\b/);
    }
  });

  it('paints with DS tokens only', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
  });
});
