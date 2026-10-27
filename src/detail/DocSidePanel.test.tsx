// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentsFile } from '@/engine/comments';
import { backlinksFor, outgoingFor } from '@/engine/links';
import { buildSchema } from '@/engine/schema';
import { toConcept, type Concept } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { resetMockFs } from '@/lib/mockIpc';
import type { CommentsSlot } from '@/stores/commentsStore';
import { useUiStore } from '@/stores/uiStore';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { commentSections } from './commentSections';
import { DocSidePanel, PageDates } from './DocSidePanel';
import { InspectorSection } from './InspectorSection';
import type { PageCommentsController } from './usePageComments';

/** The page's side panel: one panel at a time — Details, Comments or History,
 *  each opened by its own toolbar button (PanelButtons) — over one body. Its
 *  Comments (M70.2b) are on every page, concepts included; its Details are
 *  folding sections, Access (M58.6) folded among them, ending with Info: the
 *  page's dates and its last change (M58.1b). */

const PAGE = 'records/decisions/dec-offline-window-72h.md';
const CONCEPT = 'knowledge/playbooks/warehouse-cutover.md';

const open = (id: string) => ({
  comments: [{ id, author: 'human:owner', created: '2026-10-14T09:00:00Z', body: 'x' }],
});
const TWO_OPEN: CommentsFile = {
  format: 1,
  threads: [
    open('0000000000000001'),
    open('0000000000000002'),
    { ...open('0000000000000003'), resolved: { at: '2026-10-14T10:00:00Z', by: 'human:owner' } },
  ],
};

function controller(slot: CommentsSlot | null): PageCommentsController {
  const nothing = async () => null;
  const no = async () => false;
  return {
    path: PAGE,
    slot,
    sections: slot?.kind === 'ready' ? commentSections(slot.file, null) : null,
    focused: null,
    draft: null,
    start: () => undefined,
    cancelDraft: () => undefined,
    submitDraft: nothing,
    startDiscussion: nothing,
    reply: nothing,
    setResolved: no,
    deleteComment: no,
    deleteThread: no,
    focus: () => undefined,
  };
}

let entry: Entry;

const found = (path: string): Entry => {
  const hit = useVaultStore.getState().entries.find((e) => e.path === path);
  if (hit === undefined) throw new Error(`fixture vault has no ${path}`);
  return hit;
};

/** A real concept from the corpus, so its Details can render. */
const concept = (): Concept => toConcept(found(CONCEPT), '2026-10-18');

function panel(
  slot: CommentsSlot | null,
  conceptOf: Concept | null = null,
  extra: Partial<Parameters<typeof DocSidePanel>[0]> = {},
) {
  return (
    <DocSidePanel
      entry={entry}
      schema={buildSchema(useVaultStore.getState().entries)}
      panel="details"
      concept={conceptOf}
      comments={controller(slot)}
      {...extra}
    />
  );
}

/** What the panel holds, under its head (and under a title, when it has one). */
const body = () => document.querySelector<HTMLElement>('.cb-inspector-body') as HTMLElement;
const sectionIds = () =>
  [...document.querySelectorAll<HTMLElement>('.cb-inspector-section')].map(
    (s) => s.dataset.section,
  );
const before = (a: HTMLElement, b: HTMLElement) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(async () => {
  useNavStore.getState().reset();
  resetMockFs();
  await useVaultStore.getState().openVault('/demo-vault');
  entry = found(PAGE);
  window.localStorage.removeItem('cerebro.docPanelTab');
  window.localStorage.removeItem('cerebro.inspectorCollapsed');
  window.localStorage.removeItem('cerebro.inspectorExpanded');
  useUiStore.setState({
    docPanel: 'comments',
    conceptPanel: 'comments',
    inspectorCollapsed: [],
    inspectorExpanded: [],
    inspectorReveal: null,
  });
});
afterEach(cleanup);

describe('DocSidePanel slot', () => {
  it('shows the one panel its host names, with no tab strip and no picker', () => {
    render(panel(null));
    const aside = screen.getByTestId('doc-side-panel');
    expect(aside.dataset.panel).toBe('details');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(aside.querySelector('select, [role="combobox"], [aria-haspopup="listbox"]')).toBeNull();
    // Details opens on its sections: no title over them, and its name is the host's.
    expect(aside.querySelector('.cb-inspector-title')).toBeNull();
    expect(aside.getAttribute('aria-label')).toBe('Document panel');
    expect(sectionIds()[0]).toBe('properties');
  });

  it('takes its name from the host', () => {
    render(panel(null, null, { ariaLabel: 'Capture panel' }));
    expect(screen.getByRole('complementary', { name: 'Capture panel' })).toBeTruthy();
  });

  it('titles Comments and History, and is named by the title', () => {
    const { rerender } = render(panel(null, null, { panel: 'comments' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Comments' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Comments' })).toBeTruthy();
    rerender(panel(null, null, { panel: 'history' }));
    expect(screen.getByRole('heading', { level: 2, name: 'History' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'History' })).toBeTruthy();
    expect(sectionIds()).toEqual([]);
  });

  it('never asks the store which panel to show: the host holds it', () => {
    // The store says Comments; the host says Details.
    render(panel(null));
    expect(screen.getByTestId('doc-side-panel').dataset.panel).toBe('details');
    expect(screen.queryByTestId('comments-panel')).toBeNull();
  });

  it('draws as a drawer over the column when the page asks', () => {
    render(panel(null, null, { overlay: true }));
    const aside = screen.getByTestId('doc-side-panel');
    expect(aside.dataset.overlay).toBe('true');
    expect(aside.tabIndex).toBe(-1);
  });
});

describe('DocSidePanel comments', () => {
  it("shows the page's threads in its Comments panel", () => {
    render(panel({ kind: 'ready', file: { format: 1, threads: [] } }, null, { panel: 'comments' }));
    expect(within(body()).getByTestId('comments-panel')).toBeTruthy();
    expect(sectionIds()).toEqual([]);
  });

  it("shows a concept's threads too, and none of its Details", () => {
    render(panel({ kind: 'ready', file: TWO_OPEN }, {} as Concept, { panel: 'comments' }));
    expect(screen.getByTestId('comments-panel')).toBeTruthy();
    expect(screen.queryByTestId('knowledge-panel')).toBeNull();
  });

  it('counts open threads beside its title once they are known and above zero', () => {
    const count = () => document.querySelector('.cb-inspector-title-count')?.textContent ?? null;
    const comments = (slot: CommentsSlot) => panel(slot, null, { panel: 'comments' });
    const { rerender } = render(comments({ kind: 'ready', file: TWO_OPEN }));
    expect(count()).toBe('2');
    expect(document.querySelector<HTMLElement>('.cb-inspector-title-count')?.title).toBe(
      '2 open comments',
    );
    rerender(comments({ kind: 'ready', file: { format: 1, threads: [] } }));
    expect(count()).toBeNull();
    rerender(comments({ kind: 'loading' }));
    expect(count()).toBeNull();
    rerender(comments({ kind: 'unavailable', reason: 'it is not valid JSON' }));
    expect(count()).toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Comments');
  });
});

// M58.4 (D18): History is a panel on every page, beside Comments.
// M64.2b: it renders PageHistory, the page's versions merged with its edits.
describe('DocSidePanel history', () => {
  it('shows the page history', async () => {
    render(panel(null, null, { panel: 'history' }));
    const history = await screen.findByTestId('page-history');
    expect(within(history).getByTestId('git-history').dataset.variant).toBe('panel');
    expect(body().contains(history)).toBe(true);
  });

  it("shows a concept's history too", async () => {
    render(panel(null, {} as Concept, { panel: 'history' }));
    expect(await screen.findByTestId('page-history')).toBeTruthy();
    expect(screen.queryByTestId('knowledge-panel')).toBeNull();
  });
});

describe('DocSidePanel details', () => {
  it("stacks a page's sections — properties, links, knowledge, access — then its Info", () => {
    render(panel(null));
    expect(sectionIds()).toEqual([
      'properties',
      'links',
      'backlinks',
      'mentions',
      'knowledge',
      'access',
      'info',
    ]);
    expect(
      screen.getByRole('button', { name: 'Properties', expanded: true }).closest('section'),
    ).toBe(screen.getByTestId('doc-properties').closest('section'));
    // Info is the last section: when the page was made and changed, and who.
    const info = screen.getByTestId('page-info');
    expect(before(screen.getByTestId('page-access'), info)).toBe(true);
    expect(body().lastElementChild).toBe(info);
  });

  it('folds Access until asked, its count on the header either way', () => {
    render(panel(null));
    const toggle = screen.getByRole('button', { name: 'Access' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect((screen.getByTestId('page-access').parentElement as HTMLElement).hidden).toBe(true);
    // The summary is said with the header, not named by it.
    const summary = screen.getByTestId('page-access-summary');
    expect(summary.textContent).toBe('No agent can change it');
    expect(toggle.getAttribute('aria-describedby')).toBe(summary.parentElement?.id);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(useUiStore.getState().inspectorExpanded).toEqual(['access']);
    expect(screen.getByTestId('page-access-summary').textContent).toBe('No agent can change it');
  });

  it('names backlink pages separately from exact occurrence rows', async () => {
    const entries = useVaultStore.getState().entries;
    const outgoing = outgoingFor(entry, entries).length;
    const backlinks = new Set(backlinksFor(entry, entries).map((link) => link.entry.path)).size;
    // The corpus decision is linked both ways, so both sections show.
    expect(outgoing).toBeGreaterThan(0);
    expect(backlinks).toBeGreaterThan(0);
    render(panel(null));
    const wrapper = screen.getByTestId('doc-links');
    const count = (id: string) =>
      wrapper.querySelector(`[data-section="${id}"] .cb-inspector-section-count`)?.textContent;
    expect(count('links')).toBe(String(outgoing));
    expect(
      wrapper.querySelector('[data-section="backlinks"] .cb-inspector-section-summary')
        ?.textContent,
    ).toBe(`${backlinks} pages`);
    expect(within(wrapper).getAllByTestId('doc-link-row')).toHaveLength(outgoing);
    expect(
      (await within(wrapper).findAllByTestId('source-occurrence-row')).length,
    ).toBeGreaterThanOrEqual(backlinks);
  });

  it('says the property a link rides as plain words at the end of its row', () => {
    render(panel(null));
    const links = screen.getByTestId('doc-links').querySelector('[data-section="links"]');
    if (!(links instanceof HTMLElement)) throw new Error('no Links section');
    // The decision names its deciders and what it affects in frontmatter.
    const rows = within(links).getAllByTestId('doc-link-row');
    const vias = rows.map((row) => within(row).queryByTestId('doc-link-via')?.textContent ?? null);
    expect(vias).toContain('deciders');
    expect(vias).toContain('affects');
    for (const row of rows) {
      const via = within(row).queryByTestId('doc-link-via');
      if (via === null) continue;
      // Last in its row, and text — not a chip with a fill of its own.
      expect(row.lastElementChild).toBe(via);
      expect(via.className).not.toMatch(/\bbg-/);
    }
  });

  it('says None on one header, and how to make a link in its tooltip, when there are none', async () => {
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    fs.set('notes/alone.md', '# Alone\n\nNothing links here.\n');
    await useVaultStore.getState().rescan();
    entry = found('notes/alone.md');
    render(panel(null));
    const links = screen.getByTestId('doc-links');
    // The outgoing Links header stays static; contextual reads and explicit
    // mention discovery have their own sections.
    const outgoing = links.querySelector('[data-section="links"]') as HTMLElement;
    expect(within(outgoing).queryAllByRole('button')).toHaveLength(0);
    expect(within(links).getByRole('button', { name: 'Search mentions' })).toBeTruthy();
    expect(within(links).getByRole('heading', { name: /^Links/ })).toBeTruthy();
    const none = within(links).getByText('None');
    expect(none.title).toBe('Type [[ in the page to link another');
    expect(within(links).queryByTestId('doc-link-row')).toBeNull();
  });

  it('shows bounded contextual backlinks with separate occurrence and page counts', async () => {
    entry = found('people/marcus-webb.md');
    const many = backlinksFor(entry, useVaultStore.getState().entries).length;
    expect(many).toBeGreaterThan(6);
    render(panel(null));
    const backlinks = screen
      .getByTestId('doc-links')
      .querySelector('[data-section="backlinks"]') as HTMLElement;
    const rows = await within(backlinks).findAllByTestId('source-occurrence-row');
    expect(rows.length).toBeGreaterThan(6);
    expect(rows.length).toBeLessThanOrEqual(50);
    expect(within(backlinks).getByTestId('source-occurrences-count').textContent).toMatch(
      /occurrences on \d+ pages/,
    );
    for (const row of rows) expect(row.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('folds a section, keeps the fold across pages, and opens it again', () => {
    const { unmount } = render(panel(null));
    const toggle = () => screen.getByRole('button', { name: 'Knowledge' });
    const body = () => screen.getByTestId('page-knowledge').parentElement as HTMLElement;
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(body().hidden).toBe(false);
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(body().hidden).toBe(true);
    expect(useUiStore.getState().inspectorCollapsed).toEqual(['knowledge']);
    expect(window.localStorage.getItem('cerebro.inspectorCollapsed')).toBe('["knowledge"]');
    unmount();
    // Another page: the fold is the person's, not the page's.
    entry = found('records/agents/release-scout.md');
    render(panel(null));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(useUiStore.getState().inspectorCollapsed).toEqual([]);
  });

  it('unfolds and scrolls to a revealed section, on Details', () => {
    useUiStore.setState({ inspectorCollapsed: ['knowledge'] });
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    render(panel(null));
    act(() => useUiStore.getState().revealInspectorSection('knowledge'));
    // The reveal asks the host for Details (its stored panel), open.
    expect(useUiStore.getState().docPanel).toBe('details');
    expect(useUiStore.getState().docPanelOpen).toBe(true);
    const knowledge = screen.getByRole('button', { name: 'Knowledge' });
    expect(knowledge.getAttribute('aria-expanded')).toBe('true');
    expect(scroll.mock.contexts).toContain(knowledge.closest('section'));
    scroll.mockRestore();
  });

  it('puts an Organize section first, in place of Properties, and keeps Info last', () => {
    render(
      panel(null, null, {
        organize: (
          <InspectorSection id="organize" label="Organize">
            <p>Type and fields</p>
          </InspectorSection>
        ),
      }),
    );
    // Then what Knowledge holds, the links, Access and Info.
    expect(sectionIds()).toEqual([
      'organize',
      'knowledge',
      'links',
      'backlinks',
      'mentions',
      'access',
      'info',
    ]);
    expect(screen.queryByTestId('doc-properties')).toBeNull();
    expect(before(screen.getByText('Type and fields'), screen.getByTestId('last-change'))).toBe(
      true,
    );
    expect(body().lastElementChild).toBe(screen.getByTestId('page-info'));
  });

  it("leads a concept's Details with its provenance, then its links, then Info", () => {
    entry = found(CONCEPT);
    render(panel(null, concept()));
    const details = screen.getByTestId('knowledge-panel');
    expect((details.closest('.cb-inspector-section') as HTMLElement).dataset.section).toBe(
      'concept',
    );
    const info = screen.getByTestId('page-info');
    expect(before(details, screen.getByTestId('doc-links'))).toBe(true);
    expect(before(screen.getByTestId('doc-links'), info)).toBe(true);
    expect(sectionIds()[0]).toBe('concept');
    expect(sectionIds().at(-1)).toBe('info');
    expect(
      sectionIds()
        .slice(1, -1)
        .every((id) => id === 'links' || id === 'backlinks' || id === 'mentions'),
    ).toBe(true);
    expect(screen.queryByTestId('doc-properties')).toBeNull();
    expect(screen.queryByTestId('page-knowledge')).toBeNull();
    expect(screen.queryByTestId('page-access')).toBeNull();
  });
});

describe('DocSidePanel Info: last change (M58.1b) and dates', () => {
  it("ends a page's Details with when it was made and changed, then who changed it", async () => {
    render(panel(null));
    const info = screen.getByTestId('page-info');
    expect((info as HTMLElement).dataset.section).toBe('info');
    const last = await within(info).findByTestId('last-change');
    expect(before(screen.getByTestId('doc-properties'), last)).toBe(true);
    // A label and a value each, on the property grid.
    const terms = [...info.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(terms).toEqual(['Created', 'Modified', 'Changed by']);
    const line = await screen.findByTestId('last-change-line');
    expect(line.textContent).toBe('Not recorded');
    // The sentence it stands for is its tooltip.
    expect(line.title).toBe('Who changed this page was not recorded');
    const dates = within(info).getByTestId('page-dates');
    expect(before(dates, last)).toBe(true);
    expect(within(info).getByTestId('page-created').textContent).toMatch(
      /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/,
    );
    expect(within(info).getByTestId('page-modified').textContent).toMatch(
      /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/,
    );
    // Said once: the properties print no dates of their own.
    expect(body().textContent?.match(/Created/g)).toHaveLength(1);
    expect(screen.getByTestId('doc-properties').textContent).not.toContain('Modified');
  });

  it("ends an agent page's Details too, after its own facts", async () => {
    entry = found('records/agents/release-scout.md');
    render(panel(null));
    const last = await screen.findByTestId('last-change');
    expect(before(screen.getByTestId('agent-info'), last)).toBe(true);
    // The agent's section says what it is, never the generic property editor.
    expect(screen.getByRole('button', { name: 'Agent' }).closest('section')).toBe(
      screen.getByTestId('agent-info').closest('section'),
    );
    expect(screen.queryByTestId('doc-properties')).toBeNull();
    const info = screen.getByTestId('agent-info');
    const facts = [...info.querySelectorAll('dt')].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(facts).toEqual([
      ['Handle', '@release-scout'],
      ['Writes as', 'process:release-scout'],
      ['File', 'records/agents/release-scout.md'],
    ]);
  });

  it("ends a concept's Details too, after its links", async () => {
    entry = found(CONCEPT);
    render(panel(null, concept()));
    const info = screen.getByTestId('page-info');
    expect(within(info).getByTestId('page-dates')).toBeTruthy();
    const line = await within(info).findByTestId('last-change-line');
    expect(line.textContent).toBe('Knowledge');
    expect(line.title).toBe('Changed through Knowledge');
  });

  // M61.8: an instant prints the day this machine's clock said, not UTC's.
  it('prints the dates as the local day, in words', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      // 03:00Z is the evening BEFORE in Los Angeles.
      render(
        <dl>
          <PageDates
            entry={{
              ...found(PAGE),
              createdAt: '2026-07-01T03:00:00Z',
              modifiedAt: '2026-07-23T03:00:00Z',
            }}
          />
        </dl>,
      );
      const dates = screen.getByTestId('page-dates');
      expect(screen.getByTestId('page-created').textContent).toBe('Jun 30, 2026');
      expect(screen.getByTestId('page-modified').textContent).toBe('Jul 22, 2026');
      // Machine-readable underneath: each day keeps the instant it was read from.
      expect([...dates.querySelectorAll('time')].map((t) => t.dateTime)).toEqual([
        '2026-07-01T03:00:00Z',
        '2026-07-23T03:00:00Z',
      ]);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe('DocSidePanel page access (M58.6)', () => {
  it("names a page's Access section, after its properties", () => {
    render(panel(null));
    const access = screen.getByTestId('page-access');
    expect(before(screen.getByTestId('doc-properties'), access)).toBe(true);
    expect(screen.getByTestId('page-access-summary').textContent).toBe('No agent can change it');
    // The section names it, once: the access list carries no heading of its own.
    const section = access.closest('section') as HTMLElement;
    expect(section.dataset.section).toBe('access');
    expect(within(section).getByRole('heading', { name: 'Access' })).toBeTruthy();
    expect(within(access).queryByRole('heading')).toBeNull();
    expect(screen.getAllByText('Access')).toHaveLength(1);
    expect(screen.queryByText('Who can change this page')).toBeNull();
  });

  it("follows an agent page's own note", () => {
    entry = found('records/agents/release-scout.md');
    render(panel(null));
    expect(before(screen.getByTestId('agent-info'), screen.getByTestId('page-access'))).toBe(true);
  });

  it('is not on a concept, whose Details have no access rows', () => {
    entry = found(CONCEPT);
    render(panel(null, concept()));
    expect(screen.queryByTestId('page-access')).toBeNull();
  });
});
