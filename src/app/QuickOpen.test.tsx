import { installOpenIntent } from './openIntent';
import { fireEvent } from '@testing-library/react';
import { APP_SCOPE, bind, resetKeymap } from '@/lib/keys/registry';
import { ROOT_PAGE_ID } from '@/lib/keys/root';
import { previewTheme } from '@/hooks/useTheme';
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

  it('names a scanned whiteboard and uses its file-kind icon', async () => {
    useVaultStore.setState({
      entries: [
        makeEntry({
          path: 'boards/release-plan.canvas',
          filename: 'release-plan.canvas',
          title: 'Release plan',
        }),
      ],
    });
    render(<QuickOpen />);
    await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), 'Release plan');
    expect(screen.getByText('Whiteboard')).toBeTruthy();
    const board = screen
      .getAllByTestId('quick-open-result')
      .find((row) => row.textContent?.includes('Release plan'));
    expect(board?.querySelector('[data-icon="presentation"]')).toBeTruthy();
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
    expect(screen.getByText(/Open beside/).querySelector('[data-keys="shift+enter"]')).toBeTruthy();
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
    expect(options).toHaveLength(want.length);
    for (const [index, destination] of want.entries()) {
      expect(options[index].textContent).toContain(destination.label);
      expect(options[index].querySelector('[data-keys]')?.getAttribute('data-keys')).toBe(
        `g ${destination.go}`,
      );
    }
    expect(options.map((o) => o.textContent).join(' ')).not.toContain('Pulse');
  });

  it('hides Inbox when the inbox workflow is off, as the nav does', () => {
    useUiStore.setState({ inboxEnabled: false });
    render(<QuickOpen />);
    const labels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(labels).not.toContain('InboxGo to');
    expect(labels[0]).toMatch(/^Home.*Go to$/);
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

describe('palette commands and choosers', () => {
  beforeEach(() => {
    resetKeymap();
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entriesVault: '/demo-vault',
      entries: fixtureVault(),
      status: 'ready',
    });
    useUiStore.setState({
      quickOpenVisible: true,
      inboxEnabled: true,
      handoffs: [],
      themeMode: 'light',
      favorites: {},
    });
    useOpenLogStore.setState({ logs: {}, saved: true });
    searchVault.mockReset();
    searchVault.mockResolvedValue(NOTHING);
  });
  afterEach(() => {
    resetKeymap();
    previewTheme(null);
  });
  it('cycles category chips with Tab and exposes combobox option ids', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    const input = screen.getByRole('combobox');
    expect(input.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
    const id = input.getAttribute('aria-activedescendant');
    expect(document.getElementById(id!)?.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Tab}');
    expect(screen.getByTestId('palette-category-pages').getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(screen.getByTestId('palette-category-all').getAttribute('aria-selected')).toBe('true');
  });
  it('runs a snapshotted registry command after closing with its keycaps', async () => {
    const run = vi.fn(() => expect(useUiStore.getState().quickOpenVisible).toBe(false));
    bind(APP_SCOPE, 'theme.toggle', { run });
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByRole('combobox'), 'theme');
    const command = screen.getByRole('option', { name: /Switch light and dark/ });
    expect(command.querySelector('[data-keys]')?.getAttribute('data-keys')).toBe('mod+shift+l');
    await user.click(command);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  });
  it('previews a theme, restores on Escape and Backspace, and commits on Enter', async () => {
    useUiStore.getState().setThemeMode('light');
    const user = userEvent.setup();
    render(<QuickOpen />);
    const input = screen.getByRole('combobox');
    await user.type(input, 'theme');
    await user.click(screen.getByRole('option', { name: /Change theme/ }));
    await user.keyboard('{ArrowDown}');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('cerebro.themeMode')).toBe('light');
    await user.keyboard('{Escape}');
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('theme');
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}{Backspace}');
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.keyboard('{Enter}{ArrowDown}{Enter}');
    expect(localStorage.getItem('cerebro.themeMode')).toBe('dark');
    expect(useUiStore.getState().quickOpenVisible).toBe(false);
  });
  it('offers nothing active for an unmatched query, then Down reaches Ask', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByRole('combobox'), 'zzqxv');
    expect(
      screen.getAllByRole('option').every((row) => row.getAttribute('aria-selected') === 'false'),
    ).toBe(true);
    await user.keyboard('{Enter}');
    expect(useUiStore.getState().quickOpenVisible).toBe(true);
    expect(useUiStore.getState().handoffs).toEqual([]);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(useUiStore.getState().quickOpenVisible).toBe(false);
    expect(useUiStore.getState().handoffs.at(-1)?.text).toBe('zzqxv');
  });
  it('adopts a late first content hit only while the highlight is untouched', async () => {
    let land!: (value: VaultSearch) => void;
    searchVault.mockImplementation(
      () =>
        new Promise<VaultSearch>((resolve) => {
          land = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByRole('combobox'), 'zzqxv');
    await vi.waitFor(() => expect(searchVault).toHaveBeenCalled());
    await act(async () =>
      land({
        hits: [{ path: 'late.md', title: 'Late page', type: null, parts: [] }],
        total: 1,
        capped: 0,
        widened: false,
      }),
    );
    expect(screen.getByTestId('quick-open-content-result').getAttribute('aria-selected')).toBe(
      'true',
    );
  });
  it('captures only commands bound in the original page scope', async () => {
    const stop = bind({ id: ROOT_PAGE_ID, name: 'page' }, 'inbox.file', { run: vi.fn() });
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByRole('combobox'), 'file');
    expect(screen.getByRole('option', { name: /File the open capture/ })).toBeTruthy();
    cleanup();
    stop();
    useUiStore.setState({ quickOpenVisible: true });
    render(<QuickOpen />);
    await user.type(screen.getByRole('combobox'), 'file');
    expect(screen.queryByRole('option', { name: /File the open capture/ })).toBeNull();
  });
  it('opens a favorite or agent as a page', async () => {
    const favorite = makeEntry({ path: 'my-page.md', title: 'My page' });
    const agent = makeEntry({
      path: 'records/agents/helper.md',
      title: 'Helper',
      type: 'Agent',
      properties: { slug: 'helper', paused: true },
    });
    useVaultStore.setState({ entries: [favorite, agent] });
    useUiStore.setState({ favorites: { '/demo-vault': [favorite.path] } });
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByRole('combobox'), 'favorite');
    await user.click(screen.getByRole('option', { name: /Open favorite/ }));
    await user.keyboard('{Enter}');
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: favorite.path });
    await act(async () => useUiStore.setState({ quickOpenVisible: true }));
    await user.type(screen.getByRole('combobox'), 'open agent');
    await user.click(screen.getByRole('option', { name: /Open agent/ }));
    expect(screen.getByRole('option', { name: /Helper/ }).textContent).toContain(
      '@helper · paused',
    );
    await user.keyboard('{Enter}');
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: agent.path });
  });
});

describe('QuickOpen beside intent', () => {
  beforeEach(() => {
    useNavStore.getState().reset();
    useNavStore.getState().setPaneCapacity(2);
    useVaultStore.setState({ entries: [makeEntry({ path: 'beside.md', title: 'Beside note' })] });
    useUiStore.setState({ quickOpenVisible: true });
    searchVault.mockResolvedValue(NOTHING);
  });
  it.each(['shift', 'modified click'])('opens a place with %s', async (method) => {
    const stop = installOpenIntent();
    try {
      const user = userEvent.setup();
      render(<QuickOpen />);
      const input = screen.getByTestId('quick-open-input');
      await user.type(input, 'Beside note');
      if (method === 'shift') fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
      else fireEvent.click(screen.getByTestId('quick-open-result'), { metaKey: true });
      expect(useNavStore.getState().paneIds).toHaveLength(2);
      expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'beside.md' });
    } finally {
      stop();
    }
  });
  it('Shift+Enter runs a command without opening a pane', async () => {
    const ran = vi.fn();
    bind(APP_SCOPE, 'theme.toggle', { run: ran });
    const user = userEvent.setup();
    render(<QuickOpen />);
    const input = screen.getByTestId('quick-open-input');
    await user.click(screen.getByTestId('palette-category-commands'));
    await user.type(input, 'Switch light and dark');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(useNavStore.getState().paneIds).toHaveLength(1);
    await vi.waitFor(() => expect(ran).toHaveBeenCalledOnce());
  });
});
