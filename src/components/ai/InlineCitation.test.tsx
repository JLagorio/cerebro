// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOVER_OPEN_MS, resetHoverCards } from '@/components/ui/HoverCard';
import { resetLayers } from '@/components/ui/layers';
import { InlineCitation, citationLabel, type CitationSource } from './InlineCitation';
import { SOURCES_WORDS } from './Sources';

/**
 * Inline Citation (M91.9): the caller's own link or button stays the trigger,
 * its name and role unchanged, so a keyboard keeps the one way in; the hover
 * card is an extra, and links only to the web (CV-16).
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

const ASTRO: CitationSource = {
  kind: 'url',
  url: 'https://docs.astro.build/en/install-and-setup/',
  title: 'Install Astro',
  description: 'Run pnpm create astro@latest and follow the prompts.',
  via: 'text',
};

const NOTES: CitationSource = {
  kind: 'vault',
  path: 'notes/release.md',
  title: 'Release notes',
  via: 'read',
};

let at = 0;
function hover(el: Element) {
  at += 7;
  act(() => {
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, screenX: at, screenY: at }));
  });
  act(() => {
    vi.advanceTimersByTime(HOVER_OPEN_MS);
  });
}

/** Every link drawn goes to the web, never to a vault path (CV-16). */
function onlyWebLinks() {
  for (const link of document.querySelectorAll('a')) {
    expect(link.getAttribute('href') ?? '', link.outerHTML).toMatch(/^https?:\/\//);
  }
}

describe('InlineCitation', () => {
  it('keeps the caller’s link as it is, and opens a card that describes it', () => {
    render(
      <p>
        Astro scaffolds the project.{' '}
        <InlineCitation sources={[ASTRO]}>
          <a href={ASTRO.url} target="_blank" rel="noreferrer noopener">
            Astro docs
          </a>
        </InlineCitation>
      </p>,
    );
    const link = screen.getByRole('link', { name: 'Astro docs' });
    expect(link.parentElement?.tagName).toBe('P');
    expect(link.getAttribute('aria-describedby')).toBeNull();
    hover(link);
    const card = screen.getByRole('group', { name: 'Source' });
    expect(link.getAttribute('aria-describedby')).toBe(card.id);
    expect(card.textContent).toContain('Install Astro');
    expect(card.textContent).toContain('Run pnpm create astro@latest and follow the prompts.');
    const out = screen.getByRole('link', { name: `docs.astro.build${SOURCES_WORDS.newTab}` });
    expect(out.getAttribute('href')).toBe(ASTRO.url);
    expect(out.getAttribute('target')).toBe('_blank');
    onlyWebLinks();
  });

  it('keeps a wikilink button’s role, click and own description', () => {
    const onClick = vi.fn();
    render(
      <>
        <span id="hint">A page in this vault</span>
        <InlineCitation sources={[NOTES]}>
          <button type="button" aria-describedby="hint" onClick={onClick}>
            Release notes
          </button>
        </InlineCitation>
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'Release notes' });
    expect(trigger.getAttribute('aria-describedby')).toBe('hint');
    hover(trigger);
    const card = screen.getByRole('group', { name: 'Source' });
    expect(trigger.getAttribute('aria-describedby')).toBe(`hint ${card.id}`);
    fireEvent.click(trigger);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('hands the caller’s own ref the trigger too', () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <InlineCitation sources={[ASTRO]}>
        <button type="button" ref={ref}>
          1
        </button>
      </InlineCitation>,
    );
    expect(ref.current).toBe(screen.getByRole('button', { name: '1' }));
    hover(ref.current as HTMLButtonElement);
    expect(screen.getByRole('group', { name: 'Source' })).toBeTruthy();
  });

  it('draws a trigger of the caller’s own from the card’s ref and description', () => {
    render(
      <InlineCitation sources={[ASTRO, NOTES]}>
        {({ ref, describedBy }) => (
          <button type="button" ref={ref} aria-describedby={describedBy}>
            [1]
          </button>
        )}
      </InlineCitation>,
    );
    const trigger = screen.getByRole('button', { name: '[1]' });
    hover(trigger);
    const card = screen.getByRole('group', { name: '2 sources' });
    expect(trigger.getAttribute('aria-describedby')).toBe(card.id);
    expect(card.querySelectorAll('[data-slot="inline-citation-source"]')).toHaveLength(2);
  });

  it('opens a vault page in the app, through the caller, and closes the card', () => {
    const onOpenPath = vi.fn();
    render(
      <InlineCitation sources={[NOTES]} onOpenPath={onOpenPath}>
        <button type="button">[^notes]</button>
      </InlineCitation>,
    );
    hover(screen.getByRole('button', { name: '[^notes]' }));
    const open = screen.getByRole('button', { name: 'Open notes/release.md' });
    fireEvent.click(open);
    expect(onOpenPath).toHaveBeenCalledWith('notes/release.md');
    expect(screen.queryByRole('group', { name: 'Source' })).toBeNull();
    onlyWebLinks();
  });

  it('says an untitled source’s address once', () => {
    render(
      <InlineCitation
        sources={[
          { kind: 'vault', path: 'notes/untitled.md', via: 'read' },
          { kind: 'vault', path: 'notes/elsewhere.md', via: 'read' },
        ]}
        onOpenPath={vi.fn()}
        isVaultPath={(path) => path === 'notes/untitled.md'}
      >
        <button type="button">[2]</button>
      </InlineCitation>,
    );
    hover(screen.getByRole('button', { name: '[2]' }));
    const card = screen.getByRole('group', { name: '2 sources' });
    expect(card.textContent?.split('notes/untitled.md')).toHaveLength(2);
    expect(card.textContent?.split('notes/elsewhere.md')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Open notes/untitled.md' })).toBeTruthy();
  });

  it('names a source it cannot open as text', () => {
    render(
      <InlineCitation
        sources={[NOTES, { kind: 'url', url: 'javascript:alert(1)', title: 'Trap', via: 'text' }]}
      >
        <button type="button">[1]</button>
      </InlineCitation>,
    );
    hover(screen.getByRole('button', { name: '[1]' }));
    const card = screen.getByRole('group', { name: '2 sources' });
    expect(card.querySelector('a')).toBeNull();
    expect(card.querySelectorAll('button')).toHaveLength(0);
    expect(card.textContent).toContain('notes/release.md');
    expect(card.textContent).toContain('javascript:alert(1)');
  });

  it('opens no card with no sources', () => {
    render(
      <InlineCitation sources={[]}>
        <button type="button">[1]</button>
      </InlineCitation>,
    );
    hover(screen.getByRole('button', { name: '[1]' }));
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('names its card by how many sources it holds', () => {
    expect(citationLabel([ASTRO])).toBe('Source');
    expect(citationLabel([ASTRO, NOTES])).toBe('2 sources');
  });
});
