// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceRef } from '@/engine/ai/types';
import { SOURCES_WORDS, Source, Sources, sourceHost, sourceName } from './Sources';

/**
 * Sources (M91.9): what a reply drew on. A web page is a link out that says
 * it opens a new tab; a vault page opens in the app through the caller, never
 * through an href (CV-16); anything else is text.
 */

afterEach(cleanup);

const SOURCES: SourceRef[] = [
  {
    kind: 'url',
    url: 'https://docs.astro.build/en/install-and-setup/',
    title: 'Install Astro',
    via: 'search',
  },
  { kind: 'url', url: 'https://www.npmjs.com/package/create-astro', via: 'fetch' },
  { kind: 'vault', path: 'notes/release.md', title: 'Release notes', via: 'read' },
  { kind: 'vault', path: 'notes/plan.md', via: 'read' },
];

/** Every link drawn goes to the web, never to a vault path (CV-16). */
function onlyWebLinks() {
  for (const link of document.querySelectorAll('a')) {
    expect(link.getAttribute('href') ?? '', link.outerHTML).toMatch(/^https?:\/\//);
  }
}

describe('Sources', () => {
  it('says how many it used, and starts closed', () => {
    render(<Sources sources={SOURCES} />);
    const trigger = screen.getByRole('button', { name: 'Used 4 sources' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.closest('[data-slot="sources"]')).not.toBeNull();
    cleanup();
    render(<Sources sources={[SOURCES[0]]} />);
    expect(screen.getByRole('button', { name: 'Used 1 source' })).toBeTruthy();
  });

  it('links a web page out, in a new tab, and says so', () => {
    render(<Sources sources={SOURCES} defaultOpen />);
    const titled = screen.getByRole('link', {
      name: `Install Astro docs.astro.build${SOURCES_WORDS.newTab}`,
    });
    expect(titled.getAttribute('href')).toBe('https://docs.astro.build/en/install-and-setup/');
    expect(titled.getAttribute('target')).toBe('_blank');
    expect(titled.getAttribute('rel')).toBe('noreferrer noopener');
    expect(titled.dataset.via).toBe('search');
    // Untitled, it is named by its host, without "www.".
    const bare = screen.getByRole('link', { name: `npmjs.com${SOURCES_WORDS.newTab}` });
    expect(bare.getAttribute('href')).toBe('https://www.npmjs.com/package/create-astro');
    onlyWebLinks();
  });

  it('opens a vault page in the app, through the caller', () => {
    const onOpenPath = vi.fn();
    render(<Sources sources={SOURCES} onOpenPath={onOpenPath} defaultOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Release notes' }));
    expect(onOpenPath).toHaveBeenCalledWith('notes/release.md');
    fireEvent.click(screen.getByRole('button', { name: 'Open notes/plan.md' }));
    expect(onOpenPath).toHaveBeenLastCalledWith('notes/plan.md');
    onlyWebLinks();
  });

  it('draws a vault page as text when nothing can open it', () => {
    render(<Sources sources={SOURCES} defaultOpen />);
    expect(screen.queryByRole('button', { name: /Release notes/ })).toBeNull();
    const row = document.querySelector('[data-kind="vault"]') as HTMLElement;
    expect(row.textContent).toBe('Release notes');
    expect(row.getAttribute('title')).toBe('notes/release.md');
  });

  it('draws nothing for a reply that drew on none', () => {
    const { container } = render(<Sources sources={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('Source (CV-16)', () => {
  it.each<SourceRef>([
    { kind: 'url', url: 'javascript:alert(1)', via: 'text' },
    { kind: 'url', url: 'ftp://files.example.com/a', via: 'text' },
    { kind: 'url', url: 'https://user:secret@example.com/', via: 'text' },
    { kind: 'url', url: 'notes/release.md', via: 'text' },
  ])('draws $url as text, never a link', (source) => {
    render(<Source source={source} onOpenPath={() => undefined} />);
    expect(document.querySelector('a')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('[data-slot="source"]')?.textContent).not.toBe('');
  });

  it.each(['../outside.md', '/Users/me/vault/a.md', 'file:///etc/passwd'])(
    'opens no vault path that leaves the vault: %s',
    (path) => {
      render(<Source source={{ kind: 'vault', path, via: 'read' }} onOpenPath={() => undefined} />);
      expect(screen.queryByRole('button')).toBeNull();
      expect(document.querySelector('a')).toBeNull();
    },
  );

  it('says where a source stands after its name, inside its row, in either kind', () => {
    const onOpenPath = vi.fn();
    render(
      <Source
        source={{ kind: 'vault', path: 'knowledge/old.md', title: 'Old belief', via: 'read' }}
        description="· replaced"
        onOpenPath={onOpenPath}
      />,
    );
    const page = screen.getByRole('button', { name: 'Open Old belief · replaced' });
    const words = page.querySelector('[data-slot="trace-description"]');
    expect(words?.textContent).toBe('· replaced');
    // After the name, which truncates; the words themselves never do.
    expect(words?.previousElementSibling?.getAttribute('data-slot')).toBe('trace-title');
    fireEvent.click(page);
    expect(onOpenPath).toHaveBeenCalledWith('knowledge/old.md');
    cleanup();
    render(<Source source={SOURCES[0]} description="· archived" />);
    expect(
      screen.getByRole('link', {
        name: `Install Astro docs.astro.build · archived${SOURCES_WORDS.newTab}`,
      }),
    ).toBeTruthy();
    cleanup();
    render(<Source source={SOURCES[3]} description="" onOpenPath={onOpenPath} />);
    expect(document.querySelector('[data-slot="trace-description"]')).toBeNull();
  });

  it('lets the caller have the last word on what is a vault page', () => {
    const isVaultPath = (path: string) => path.startsWith('notes/');
    const { rerender } = render(
      <Source source={SOURCES[3]} onOpenPath={() => undefined} isVaultPath={isVaultPath} />,
    );
    expect(screen.getByRole('button', { name: 'Open notes/plan.md' })).toBeTruthy();
    rerender(
      <Source
        source={{ kind: 'vault', path: 'src/a.ts', via: 'read' }}
        onOpenPath={() => undefined}
        isVaultPath={isVaultPath}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('gives its link or its button the tab stop a caller asks for, and text none (M92.4)', () => {
    render(<Source source={SOURCES[0]} tabIndex={0} />);
    expect(screen.getByRole('link').getAttribute('tabindex')).toBe('0');
    cleanup();
    render(<Source source={SOURCES[3]} onOpenPath={() => undefined} tabIndex={0} />);
    expect(screen.getByRole('button').getAttribute('tabindex')).toBe('0');
    cleanup();
    // A row of text is no stop, asked or not.
    render(<Source source={SOURCES[3]} tabIndex={0} />);
    expect(document.querySelector('[tabindex]')).toBeNull();
    cleanup();
    // Unasked, a control keeps its own.
    render(<Source source={SOURCES[3]} onOpenPath={() => undefined} />);
    expect(screen.getByRole('button').hasAttribute('tabindex')).toBe(false);
  });
});

describe('names', () => {
  it('names a source by its title, else its host or path', () => {
    expect(sourceName(SOURCES[0])).toBe('Install Astro');
    expect(sourceName(SOURCES[1])).toBe('npmjs.com');
    expect(sourceName(SOURCES[3])).toBe('notes/plan.md');
    expect(sourceName({ ...SOURCES[0], title: '  ' })).toBe('docs.astro.build');
    expect(sourceName({ kind: 'url', url: 'not a url', via: 'text' })).toBe('not a url');
  });

  it('reads a host without "www.", and none from text that is no URL', () => {
    expect(sourceHost('https://www.example.com/a')).toBe('example.com');
    expect(sourceHost('https://WWW.Example.com')).toBe('example.com');
    expect(sourceHost('not a url')).toBeNull();
    expect(sourceHost('javascript:alert(1)')).toBeNull();
  });
});
