// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetHoverCards } from '@/components/ui/HoverCard';
import { resetLayers } from '@/components/ui/layers';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';
import { MarkdownEditor, type EditorReadyInfo } from './MarkdownEditor';
import { NotePathContext } from './notePath';

const open = vi.fn();
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => open }));

const requestSection = vi.fn();
vi.mock('./sectionLinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sectionLinks')>()),
  requestSection: (...args: unknown[]) => requestSection(...args),
}));

/**
 * Page and person chips preview their page on hover (M59.7), in a mounted
 * editor: the trigger listeners are native on the chip's own button, the card
 * portals to the body, and the chip keeps its DOM and its click.
 */

const MAP = 'strategy/systems-map.md';
const HOST = 'delivery/how-we-schedule.md';
const PERSON = 'people/tom-keller.md';

beforeEach(() => {
  open.mockReset();
  requestSection.mockReset();
  resetHoverCards();
  resetLayers();
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entries: [
      makeEntry({
        path: MAP,
        filename: 'systems-map.md',
        folder: 'strategy',
        title: 'Systems map',
        snippet: "How the demo product's pieces talk to each other.",
      }),
      makeEntry({
        path: HOST,
        filename: 'how-we-schedule.md',
        folder: 'delivery',
        title: 'How we schedule',
      }),
      makeEntry({
        path: PERSON,
        filename: 'tom-keller.md',
        folder: 'people',
        title: 'Tom Keller',
        snippet: 'Runs field operations.',
      }),
    ],
    status: 'ready',
    error: null,
  });
});
afterEach(cleanup);

async function openNote(markdown: string) {
  const onReady = vi.fn<(info: EditorReadyInfo) => void>();
  render(
    <NotePathContext.Provider value={HOST}>
      <MarkdownEditor
        markdown={markdown}
        onChange={vi.fn()}
        onReady={onReady}
        debounceMs={60_000}
      />
    </NotePathContext.Provider>,
  );
  await waitFor(() => expect(onReady).toHaveBeenCalled());
  await waitFor(() => expect(document.querySelector('[data-chip]')).not.toBeNull());
}

const chips = (kind: string) => [
  ...document.querySelectorAll<HTMLElement>(`[data-chip="${kind}"]`),
];
const card = () => document.querySelector<HTMLElement>('[data-testid="hover-card"]');

let at = 100;
/** A real move over `el`, then wait for its card. */
async function hover(el: HTMLElement) {
  at += 5;
  act(() => {
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, screenX: at, screenY: at }));
  });
  return waitFor(() => {
    const found = card();
    if (found === null) throw new Error('no hover card');
    return found;
  });
}

describe('chip hover previews', () => {
  it('opens a page link’s card with its title and snippet', async () => {
    await openNote('Read [[systems-map]] first.\n');
    const found = await hover(chips('wikilink')[0]);
    expect(found.getAttribute('aria-label')).toBe('Page preview');
    expect(found.querySelector('[data-testid="page-preview-title"]')?.textContent).toBe(
      'Systems map',
    );
    expect(found.textContent).toContain("How the demo product's pieces");
    expect(chips('wikilink')[0].getAttribute('aria-describedby')).toBe(found.id);
  });

  it('says a dangling link’s page does not exist', async () => {
    await openNote('Read [[no-such-page]].\n');
    const found = await hover(chips('wikilink')[0]);
    expect(found.textContent).toBe('No page named "no-such-page"');
  });

  it('previews an assignee’s page', async () => {
    await openNote('Owner @[[tom-keller]].\n');
    const found = await hover(chips('assignee')[0]);
    expect(found.querySelector('[data-testid="page-preview-path"]')?.textContent).toBe(PERSON);
    expect(found.textContent).toContain('Runs field operations.');
  });

  it('gives the chips no native title tooltip', async () => {
    await openNote('Read [[systems-map]] with @[[tom-keller]] and [[nowhere]].\n');
    const all = [...chips('wikilink'), ...chips('assignee')];
    expect(all).toHaveLength(3);
    for (const chip of all) expect(chip.hasAttribute('title')).toBe(false);
  });

  it('closes the card on Escape, and the editor stays', async () => {
    await openNote('Read [[systems-map]] first.\n');
    await hover(chips('wikilink')[0]);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(card()).toBeNull());
    expect(document.querySelector('.bn-editor')).not.toBeNull();
    expect(chips('wikilink')).toHaveLength(1);
  });

  it('opens the page from the card’s title', async () => {
    await openNote('Read [[systems-map]] first.\n');
    const found = await hover(chips('wikilink')[0]);
    fireEvent.click(found.querySelector<HTMLElement>('[data-testid="page-preview-title"]')!);
    expect(open).toHaveBeenCalledExactlyOnceWith(MAP);
    expect(requestSection).not.toHaveBeenCalled();
    await waitFor(() => expect(card()).toBeNull());
  });

  it('sends a section link through requestSection before it opens the page', async () => {
    await openNote('Before a release, read [[systems-map#Rollback]].\n');
    const found = await hover(chips('wikilink')[0]);
    fireEvent.click(found.querySelector<HTMLElement>('[data-testid="page-preview-title"]')!);
    expect(requestSection).toHaveBeenCalledExactlyOnceWith(MAP, 'Rollback');
    expect(open).toHaveBeenCalledExactlyOnceWith(MAP);
  });

  it('keeps the chip’s own click', async () => {
    await openNote('Read [[systems-map]] first.\n');
    fireEvent.click(chips('wikilink')[0]);
    expect(open).toHaveBeenCalledExactlyOnceWith(MAP);
  });
});
