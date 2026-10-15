import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuickOpen } from '@/app/QuickOpen';
import { visibleDestinations } from '@/engine/destinations';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { useOpenLogStore } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
import { fixtureVault, makeEntry } from '@/test/factories';
import type { VaultHit, VaultSearch } from '@/lib/ipc';

// The page-text search (M59.4) is Rust's; these tests decide what it says.
const searchVault = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  searchVault,
}));

const NOTHING: VaultSearch = { hits: [], total: 0, widened: false, capped: 0 };

afterEach(cleanup);

const PLACEHOLDER = 'Search pages, databases, and places…';

describe('QuickOpen', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ quickOpenVisible: true, inboxEnabled: true });
    // Navigating records opens (M59.3); every order below starts from none.
    useOpenLogStore.setState({ logs: {}, saved: true });
    searchVault.mockReset();
    searchVault.mockResolvedValue(NOTHING);
  });

  // M55.11 — a page's own icon in ⌘K: an emoji page, and a Collection page
  // whose `icon:` has always been a lucide name.
  it("draws a page's own icon: an emoji, and the Delivery page's lucide rocket", async () => {
    const ROCKET = '\u{1F680}';
    useVaultStore.setState({
      entries: [
        ...fixtureVault(),
        makeEntry({
          path: 'inbox/launch-plan.md',
          title: 'Launch plan',
          properties: { icon: ROCKET },
        }),
        makeEntry({
          path: 'delivery/delivery.md',
          title: 'Delivery',
          type: 'Collection',
          properties: { icon: 'rocket', color: '#3D8BE8' },
        }),
      ],
    });
    const user = userEvent.setup();
    render(<QuickOpen />);
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    await user.type(input, 'launch plan');
    const launch = screen
      .getAllByTestId('quick-open-result')
      .find((r) => r.textContent?.includes('Launch plan'));
    expect(launch?.querySelector('[role="img"]')?.textContent).toBe(ROCKET);
    await user.clear(input);
    await user.type(input, 'delivery');
    const delivery = screen
      .getAllByTestId('quick-open-result')
      .find((r) => r.textContent?.includes('Delivery'));
    const glyph = delivery?.querySelector('[data-icon="rocket"]') as SVGElement | null;
    expect(glyph).not.toBe(null);
    expect(glyph?.style.color).toBe('rgb(61, 139, 232)');
  });

  it('ranks an exact title prefix above a mid-title match', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'guided');
    const options = screen.getAllByRole('option');
    // The ask row is pinned above every match (M42.5, the DS ask-bar
    // contract); 'Guided onboarding' (prefix match) must rank first among
    // the MATCHES — and carry the default highlight, so Enter still means
    // "open the thing I named".
    expect(options[0].textContent).toContain('Ask the Assistant');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    expect(options[1].textContent).toContain('Guided onboarding');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
  });

  it('the ask row hands the words to the assistant panel (M42.5)', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'why is onboarding stalling');
    await user.click(
      screen.getByRole('option', { name: /Ask the Assistant: why is onboarding stalling/ }),
    );
    expect(useUiStore.getState().aiPanelOpen).toBe(true);
    // The typed words are the bubble — they are the person's own (M52.3).
    expect(useUiStore.getState().handoffs.at(-1)).toMatchObject({
      text: 'why is onboarding stalling',
      subject: null,
      label: null,
    });
    expect(useUiStore.getState().quickOpenVisible).toBe(false);
  });

  it('Enter opens the top result and closes the palette', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'guided{Enter}');
    // M12.5: a legacy project.md is an ordinary record now — panel over its
    // folder's Collection, never a page of its own.
    expect(useNavStore.getState().selection).toEqual({
      kind: 'collection',
      folder: 'projects/onboarding',
    });
    expect(useUiStore.getState().detailPath).toBe('projects/onboarding/project.md');
    expect(useUiStore.getState().quickOpenVisible).toBe(false);
  });

  it('picking an item opens its detail over its containing Collection', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'wire');
    // [0] is the pinned ask row (M42.5); the best match sits under it.
    await user.click(screen.getAllByRole('option')[1]);
    // M12.5: containment still gives the backdrop, but the backdrop is the
    // folder's Collection — the project page is gone.
    expect(useNavStore.getState().selection).toEqual({
      kind: 'collection',
      folder: 'projects/onboarding',
    });
    expect(useUiStore.getState().detailPath).toBe('projects/onboarding/items/fld-2.md');
  });

  // M12.1: every typed entry is a record. A Person has no project, so its
  // backdrop is its type screen, and it opens in the panel — never in Docs.
  it('picking a record without a project lands on its type screen with the panel', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ detailPath: null });
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'ana');
    // [0] is the pinned ask row (M42.5); the best match sits under it.
    await user.click(screen.getAllByRole('option')[1]);
    expect(useNavStore.getState().selection).toEqual({
      kind: 'type',
      name: 'Person',
    });
    expect(useUiStore.getState().detailPath).toBe('people/ana-rios.md');
  });

  // It used to restate the placeholder verbatim ~50px under itself and offer
  // nothing to press.
  it('offers the places on an empty query instead of restating the placeholder', () => {
    render(<QuickOpen />);
    expect(screen.queryByText('Type to search notes, lists, types, and places to go.')).toBeNull();
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    expect(options.map((o) => o.textContent).join(' ')).toContain('Home');
  });

  it('hints the keys in the dialog footer', () => {
    render(<QuickOpen />);
    expect(screen.getByText('↑↓ navigate · ↵ open · esc close')).toBeTruthy();
  });

  // M59.1: the first place is the table's first visible row — Inbox while
  // its workflow is on, Home when it is off.
  it('Enter on the empty query opens the first place', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), '{Enter}');
    expect(useNavStore.getState().selection).toEqual({ kind: 'inbox' });
    expect(useUiStore.getState().quickOpenVisible).toBe(false);
  });

  it('Enter on the empty query opens Home with the inbox workflow off', async () => {
    useUiStore.setState({ inboxEnabled: false });
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), '{Enter}');
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  });

  it('lists the visible destinations in table order on an empty query, none of them Pulse', () => {
    render(<QuickOpen />);
    const options = screen.getAllByRole('option');
    const want = visibleDestinations({ inboxEnabled: true });
    expect(options.map((o) => o.textContent)).toEqual(want.map((d) => `${d.label}Go to`));
    expect(options.map((o) => o.textContent).join(' ')).not.toContain('Pulse');
  });

  it('hides Inbox when the inbox workflow is off, as the nav does', () => {
    useUiStore.setState({ inboxEnabled: false });
    render(<QuickOpen />);
    const labels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(labels).not.toContain('InboxGo to');
    expect(labels[0]).toBe('HomeGo to');
  });

  it('goes to History when you type history', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'history{Enter}');
    expect(useNavStore.getState().selection).toEqual({ kind: 'pulse' });
  });

  it('calls an untyped page a Page', async () => {
    useVaultStore.setState({
      entries: [makeEntry({ path: 'notes/zebra-notes.md', title: 'Zebra notes', type: null })],
    });
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'zebra');
    const row = screen
      .getAllByTestId('quick-open-result')
      .find((r) => r.textContent?.includes('Zebra notes'));
    expect(row?.textContent).toMatch(/Page$/);
  });

  // Two adjacent spans in the identical mono style read as one phrase: a
  // record key and a type name were typographically indistinguishable.
  it('gives the record key and the kind label distinct treatments', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'guided');
    // [1]: the pinned ask row above it has no key chip to measure (M42.5).
    const spans = [...screen.getAllByRole('option')[1].querySelectorAll('span')];
    const mono = spans.filter((s) => s.className.includes('font-mono'));
    expect(mono).toHaveLength(1);
    const kind = spans[spans.length - 1];
    expect(kind.className).not.toContain('font-mono');
    // fixed-width column so the category aligns down the list
    expect(kind.className).toContain('w-[84px]');
  });

  it('renders a type target count in words rather than a bare number chip', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'person');
    const rows = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    // The type target used to carry a bare "4" in a mono chip, styled exactly
    // like a record key.
    expect(rows.some((t) => /\d+ records?Database$/.test(t))).toBe(true);
  });

  // M59.3 — the open log: Recent on an empty query, and your own opens
  // ordering matches within a tier.
  describe('with the open log', () => {
    const NOTES = [
      makeEntry({ path: 'notes/plan-alpha.md', title: 'Plan alpha', type: null }),
      makeEntry({ path: 'notes/plan-beta.md', title: 'Plan beta', type: null }),
      makeEntry({ path: 'notes/plan-gamma.md', title: 'Plan gamma', type: null }),
      makeEntry({ path: 'notes/world.md', title: 'A Better World', type: null }),
      makeEntry({ path: 'notes/worldly.md', title: 'Hold a world view', type: null }),
    ];

    beforeEach(() => {
      useVaultStore.setState({
        vaultPath: '/v',
        entriesVault: '/v',
        status: 'ready',
        entries: [...fixtureVault(), ...NOTES],
      });
    });

    const log = (...paths: string[]) => {
      // Oldest first, so the last path named is the most recent.
      for (const p of paths) useOpenLogStore.getState().record('/v', p, Date.now());
    };

    it('lists Recent in most-recent-first order above Go to', () => {
      log('notes/plan-alpha.md', 'notes/plan-gamma.md');
      render(<QuickOpen />);
      const recent = screen.getByRole('group', { name: 'Recent' });
      expect(recent.getAttribute('data-section')).toBe('recent');
      const rows = [...recent.querySelectorAll('[data-testid="quick-open-result"]')];
      expect(rows.map((r) => r.textContent)).toEqual(['Plan gammaPage', 'Plan alphaPage']);
      const options = screen.getAllByRole('option');
      expect(options[0].textContent).toBe('Plan gammaPage');
      expect(options[2].textContent).toMatch(/Go to$/);
    });

    it('shows no Recent group with an empty log', () => {
      render(<QuickOpen />);
      expect(screen.queryByRole('group', { name: 'Recent' })).toBeNull();
      expect(screen.getByRole('group', { name: 'Go to' })).toBeTruthy();
    });

    it('Enter on an empty query opens the most recent page', async () => {
      log('notes/plan-alpha.md', 'notes/plan-beta.md');
      const user = userEvent.setup();
      render(<QuickOpen />);
      await user.type(screen.getByPlaceholderText(PLACEHOLDER), '{Enter}');
      expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'notes/plan-beta.md' });
    });

    it('ranks an opened page first within its tier, never above a better tier', async () => {
      log('notes/plan-gamma.md');
      const user = userEvent.setup();
      render(<QuickOpen />);
      await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'plan');
      const labels = screen.getAllByTestId('quick-open-result').map((r) => r.textContent);
      // Gamma leads its tier on its open; the unopened rest fall back to the
      // shorter title (beta before alpha).
      expect(labels.slice(0, 3)).toEqual(['Plan gammaPage', 'Plan betaPage', 'Plan alphaPage']);
    });

    it('lists a two-word match below every substring match', async () => {
      const user = userEvent.setup();
      render(<QuickOpen />);
      await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'a world');
      const labels = screen.getAllByTestId('quick-open-result').map((r) => r.textContent);
      expect(labels).toEqual(['Hold a world viewPage', 'A Better WorldPage']);
    });

    it('prunes a deleted page when it opens on a ready snapshot of this vault', () => {
      log('notes/gone.md', 'notes/plan-alpha.md');
      useUiStore.setState({ quickOpenVisible: false });
      render(<QuickOpen />);
      act(() => useUiStore.setState({ quickOpenVisible: true }));
      expect(useOpenLogStore.getState().logs['/v']?.map((r) => r.path)).toEqual([
        'notes/plan-alpha.md',
      ]);
    });

    it('keeps the log while the snapshot is mid-scan or another vault', () => {
      log('notes/gone.md');
      useVaultStore.setState({ status: 'scanning' });
      useUiStore.setState({ quickOpenVisible: false });
      const { unmount } = render(<QuickOpen />);
      act(() => useUiStore.setState({ quickOpenVisible: true }));
      expect(useOpenLogStore.getState().logs['/v']?.map((r) => r.path)).toEqual(['notes/gone.md']);
      unmount();
      useVaultStore.setState({ status: 'ready', entriesVault: '/w' });
      useUiStore.setState({ quickOpenVisible: false });
      render(<QuickOpen />);
      act(() => useUiStore.setState({ quickOpenVisible: true }));
      expect(useOpenLogStore.getState().logs['/v']?.map((r) => r.path)).toEqual(['notes/gone.md']);
    });

    it('never renders "No matches": the Ask row is always there', async () => {
      const user = userEvent.setup();
      render(<QuickOpen />);
      await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'zzqqxx');
      expect(screen.queryByText(/No matches/)).toBeNull();
      expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-testid'))).toEqual([
        'quick-open-ask',
      ]);
    });
  });

  // M59.4 — In pages: page text under the names, once typing pauses.
  describe('In pages', () => {
    const NOTES = [
      makeEntry({ path: 'notes/plan-alpha.md', title: 'Plan alpha', type: null }),
      makeEntry({ path: 'notes/plan-beta.md', title: 'Plan beta', type: null }),
    ];

    beforeEach(() => {
      useVaultStore.setState({
        vaultPath: '/v',
        entriesVault: '/v',
        status: 'ready',
        entries: [...fixtureVault(), ...NOTES],
      });
    });

    const hit = (n: number): VaultHit => ({
      path: `notes/page-${n}.md`,
      title: `Page ${n}`,
      type: null,
      parts: [
        { text: 'The queue is ', mark: false },
        { text: 'draining', mark: true },
        { text: ' slowly', mark: false },
      ],
    });
    const answer = (n: number, extra: Partial<VaultSearch> = {}): VaultSearch => ({
      hits: Array.from({ length: Math.min(n, 50) }, (_, i) => hit(i + 1)),
      total: n,
      widened: false,
      capped: 0,
      ...extra,
    });

    const type = async (text: string) => {
      const user = userEvent.setup();
      render(<QuickOpen />);
      await user.type(screen.getByPlaceholderText(PLACEHOLDER), text);
      return user;
    };

    it('draws each hit with its excerpt, the query in a <mark>, never as HTML', async () => {
      searchVault.mockResolvedValue({
        ...answer(1),
        hits: [{ ...hit(1), parts: [{ text: '<b>draining</b>', mark: true }] }],
      });
      await type('draining');
      const row = await screen.findByTestId('quick-open-content-result');
      expect(row.getAttribute('role')).toBe('option');
      expect(row.textContent).toContain('Page 1');
      expect(row.textContent).toContain('notes/page-1.md');
      expect(row.querySelector('mark')?.textContent).toBe('<b>draining</b>');
      expect(row.querySelector('b')).toBeNull();
      const group = screen.getByRole('group', { name: 'In pages' });
      expect(group.getAttribute('data-section')).toBe('pages');
      expect(group.textContent).toContain('In pages');
      expect(searchVault).toHaveBeenCalledTimes(1);
      expect(searchVault).toHaveBeenCalledWith('/v', 'draining', 50);
    });

    it('says the page text could not be searched, never "No matches", when it fails', async () => {
      searchVault.mockRejectedValue(new Error('disk gone'));
      await type('draining');
      const unavailable = await screen.findByTestId('section-unavailable');
      expect(unavailable.textContent).toBe(
        "Page text couldn't be searched. Names above are complete.",
      );
      expect(screen.queryByText(/No matches/)).toBeNull();
      expect(screen.queryByTestId('quick-open-content-result')).toBeNull();
    });

    it('keeps a highlight moved with ArrowDown when the page rows arrive', async () => {
      let land: (value: VaultSearch) => void = () => {};
      searchVault.mockReturnValue(new Promise<VaultSearch>((resolve) => (land = resolve)));
      const user = await type('plan');
      const before = screen.getAllByRole('option');
      expect(before[1].getAttribute('aria-selected')).toBe('true');
      await user.keyboard('{ArrowDown}');
      expect(before[2].getAttribute('aria-selected')).toBe('true');
      await vi.waitFor(() => expect(searchVault).toHaveBeenCalled());
      await act(async () => land(answer(3)));
      await screen.findAllByTestId('quick-open-content-result');
      const after = screen.getAllByRole('option');
      expect(after.length).toBeGreaterThan(before.length);
      expect(after[2].textContent).toBe(before[2].textContent);
      expect(after[2].getAttribute('aria-selected')).toBe('true');
      expect(after.filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    });

    it('expands "All N matches" in place, then counts what lies past 50', async () => {
      searchVault.mockResolvedValue(answer(72));
      const user = await type('draining');
      expect(await screen.findAllByTestId('quick-open-content-result')).toHaveLength(5);
      const all = screen.getByTestId('quick-open-all-matches');
      expect(all.textContent).toContain('All 72 matches');
      expect(screen.queryByText(/more not shown/)).toBeNull();
      await user.click(all);
      expect(screen.getAllByTestId('quick-open-content-result')).toHaveLength(50);
      expect(screen.queryByTestId('quick-open-all-matches')).toBeNull();
      expect(screen.getByText('22 more not shown — add a word to narrow it')).toBeTruthy();
      expect(useUiStore.getState().quickOpenVisible).toBe(true);
      // A new query folds it back.
      await user.type(screen.getByPlaceholderText(PLACEHOLDER), 's');
      expect(screen.queryByTestId('quick-open-content-result')).toBeNull();
      expect(await screen.findAllByTestId('quick-open-content-result')).toHaveLength(5);
      expect(searchVault).toHaveBeenCalledTimes(2);
    });

    it('says when long pages were searched in part', async () => {
      searchVault.mockResolvedValue(answer(8, { capped: 2 }));
      await type('draining');
      const all = await screen.findByTestId('quick-open-all-matches');
      expect(all.textContent).toContain('All 8 matches · 2 long pages searched in part');
    });

    it('heads widened answers "In pages · closest matches"', async () => {
      searchVault.mockResolvedValue(answer(2, { widened: true }));
      await type('draining slowly');
      await screen.findAllByTestId('quick-open-content-result');
      const group = screen.getByRole('group', { name: 'In pages' });
      expect(group.textContent).toContain('In pages · closest matches');
    });

    it('asks nothing under three characters', async () => {
      await type('pl');
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(searchVault).not.toHaveBeenCalled();
    });

    it('opens a page row on Enter and logs one open', async () => {
      searchVault.mockResolvedValue({
        ...answer(1),
        hits: [{ ...hit(1), path: 'notes/plan-alpha.md', title: 'Plan alpha' }],
      });
      const user = await type('draining');
      await screen.findByTestId('quick-open-content-result');
      // Nothing is named "draining", so the highlight sits on the ask row.
      await user.keyboard('{ArrowDown}');
      expect(screen.getByTestId('quick-open-content-result').getAttribute('aria-selected')).toBe(
        'true',
      );
      await user.keyboard('{Enter}');
      expect(useNavStore.getState().selection).toEqual({
        kind: 'doc',
        path: 'notes/plan-alpha.md',
      });
      expect(useUiStore.getState().quickOpenVisible).toBe(false);
      const log = useOpenLogStore.getState().logs['/v'] ?? [];
      expect(log.map((r) => [r.path, r.count])).toEqual([['notes/plan-alpha.md', 1]]);
    });
  });
});
