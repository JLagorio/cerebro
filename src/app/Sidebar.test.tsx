import { beginPointerRename, followRename } from './pointers';
import { installOpenIntent } from './openIntent';
import { navSeed } from '@/test/navSeed';
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  isInaccessible,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESTINATIONS, destination } from '@/engine/destinations';
import type { Entry, Selection } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useRootsStore } from '@/stores/rootsStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { Sidebar } from './Sidebar';
import { createRef, StrictMode } from 'react';
import type { PageNavigationControls } from './PageNavigation';

function mkEntry(partial: Partial<Entry> & { path: string }): Entry {
  return {
    filename: partial.path.split('/').pop() ?? '',
    folder: partial.path.includes('/') ? partial.path.slice(0, partial.path.lastIndexOf('/')) : '',
    project: null,
    title: 'Untitled',
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-01T00:00:00Z',
    parseError: null,
    hash: null,
    ...partial,
  };
}

const railButton = (name: string) =>
  within(screen.getByTestId('app-rail')).getByRole('button', { name });
const chooseArea = (name: string) => fireEvent.click(railButton(name));

const project = mkEntry({
  path: 'projects/foundations/project.md',
  filename: 'project.md',
  project: 'projects/foundations/project.md',
  title: 'Foundations',
  type: 'Project',
});

describe('Sidebar', () => {
  it('restores an explicit context opener after compact selection without stealing newer focus', async () => {
    const controls = createRef<PageNavigationControls>();
    render(
      <>
        <button>Captures opener</button>
        <button>Another control</button>
        <Sidebar narrow pageNavigationKind="inbox" pageNavigationRef={controls} />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Captures opener' });
    const another = screen.getByRole('button', { name: 'Another control' });
    act(() => controls.current!.show(opener));
    const item = document.createElement('button');
    screen.getByTestId('page-navigation').append(item);
    item.focus();
    act(() => controls.current!.hide());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    act(() => controls.current!.show(opener));
    item.focus();
    act(() => {
      controls.current!.hide();
      another.focus();
    });
    await Promise.resolve();
    expect(document.activeElement).toBe(another);
  });
  it.each([false, true])(
    'Search and Assistant show catalog hints with collapsed=%s',
    async (collapsed) => {
      useUiStore.setState({ sidebarCollapsed: collapsed });
      render(<Sidebar />);
      for (const [label, spec] of [
        ['Search', 'mod+k'],
        ['Assistant', 'mod+j'],
      ]) {
        const button = screen.getByRole('button', { name: label });
        expect(button.getAttribute('title')).toBeNull();
        fireEvent.pointerEnter(button);
        await waitFor(() =>
          expect(
            screen.getByRole('tooltip').querySelector('[data-keys]')?.getAttribute('data-keys'),
          ).toBe(spec),
        );
        fireEvent.pointerLeave(button);
        await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
      }
      expect(
        [...document.querySelectorAll('[title]')].every(
          (node) => !/[⌘⇧⌥⌃]/.test(node.getAttribute('title') ?? ''),
        ),
      ).toBe(true);
    },
  );

  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entriesVault: '/demo-vault',
      entries: [project],
      views: [
        {
          id: 'urgent-work',
          project: null,
          collection: 'work',
          path: 'work/urgent-work.list.yml',
          definition: {
            name: 'Urgent work',
            icon: null,
            color: null,
            order: null,
            source: { type: null, project: null },
            views: [
              {
                id: 'view',
                name: 'View',
                icon: null,
                filters: null,
                presentation: {
                  type: 'list',
                  group: [{ field: 'status' }],
                  sort: [{ field: 'modifiedAt', dir: 'desc' }],
                  columns: [{ field: 'key' }, { field: 'status' }],
                },
              },
            ],
          },
        },
      ],
      status: 'ready',
      error: null,
    });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [navSeed({ kind: 'home' })],
      historyIndex: 0,
    });
    useUiStore.setState({
      typesOpen: true,
      inboxEnabled: true,
      aiPanelOpen: false,
      aiPanelPresentation: 'panel',
      sidebarCollapsed: false,
      pageTreeMode: 'collections',
      // The nav groups open (M42.2) — a fold left behind by another test is
      // state, not a default.
      navClosed: [],
    });
  });

  afterEach(cleanup);

  describe('contextual navigation without repeated sections', () => {
    const closedGroups = ['base', 'agents', 'work', 'pages', 'favorites', 'collections', 'recents'];
    const seedSubjects = () => {
      useVaultStore.setState({
        entries: [
          project,
          mkEntry({ path: 'knowledge/metrics/retention.md', title: 'Retention', type: 'Metric' }),
          mkEntry({ path: 'records/agents/scout.md', title: 'Scout', type: 'Agent' }),
        ],
      });
      useRootsStore.setState({
        roots: [
          {
            id: 'repo',
            label: 'Repo',
            path: '/repos/repo',
            alias: '',
            color: null,
            caps: { knowledge: false, git: false, writable: false },
          },
        ],
      });
    };

    it.each(['Knowledge', 'Agents', 'Databases', 'Work'])(
      '%s has one visible area label and direct subject rows',
      (area) => {
        seedSubjects();
        render(<Sidebar />);
        chooseArea(area);
        const sidebar = within(screen.getByRole('navigation', { name: 'Sidebar' }));
        // Include passive text as well as buttons: the former duplicate was
        // a plain area label above a second, identically named fold control.
        expect(
          sidebar.getAllByText(area, { exact: true }).filter((node) => !isInaccessible(node)),
        ).toHaveLength(1);
        expect(sidebar.getByRole('button', { name: area, expanded: true })).toBeTruthy();
        const subject =
          area === 'Knowledge'
            ? /^Metrics/
            : area === 'Agents'
              ? 'Scout'
              : area === 'Databases'
                ? /^Project/
                : 'Repo';
        expect(sidebar.getByRole('button', { name: subject })).toBeTruthy();
        expect(sidebar.queryByRole('button', { name: 'New' })).toBeNull();
        expect(railButton('New')).toBeTruthy();
      },
    );

    it.each([
      ['Knowledge', 'base', /^Metrics/, 'Open Knowledge'],
      ['Agents', 'agents', /^Scout$/, 'Open all agents'],
      ['Work', 'work', /^Repo$/, 'Open all repositories'],
    ] as const)(
      '%s retains its stored fold and action without changing the other folds',
      (area, key, subject, door) => {
        seedSubjects();
        useUiStore.setState({ navClosed: closedGroups });
        render(<Sidebar />);
        chooseArea(area);
        const sidebar = within(screen.getByRole('navigation', { name: 'Sidebar' }));
        const head = sidebar.getByRole('button', { name: area, expanded: false });
        expect(sidebar.queryByRole('button', { name: subject })).toBeNull();
        expect(sidebar.getByRole('button', { name: door })).toBeTruthy();
        const selection = useNavStore.getState().selection;
        fireEvent.click(head);
        expect(useNavStore.getState().selection).toEqual(selection);
        expect(useUiStore.getState().navClosed).toEqual(
          closedGroups.filter((group) => group !== key),
        );
        expect(sidebar.getByRole('button', { name: subject })).toBeTruthy();
        fireEvent.click(sidebar.getByRole('button', { name: area, expanded: true }));
        fireEvent.click(sidebar.getByRole('button', { name: door }));
        expect(useUiStore.getState().navClosed).toContain(key);
        expect(sidebar.queryByRole('button', { name: subject })).toBeNull();
        if (area === 'Agents') {
          fireEvent.click(sidebar.getByRole('button', { name: 'New agent' }));
          expect(useNavStore.getState().selection).toEqual({ kind: 'library', tab: 'agent' });
        }
      },
    );

    it('Databases keeps its separate persisted fold and every action while folded', () => {
      seedSubjects();
      useUiStore.setState({ typesOpen: false, navClosed: closedGroups });
      render(<Sidebar />);
      chooseArea('Databases');
      const sidebar = within(screen.getByRole('navigation', { name: 'Sidebar' }));
      const head = sidebar.getByRole('button', { name: 'Databases', expanded: false });
      expect(sidebar.queryByRole('button', { name: /^Project/ })).toBeNull();
      for (const action of ['Adopt vault schema', 'Import CSV', 'New database']) {
        expect(sidebar.getByRole('button', { name: action })).toBeTruthy();
      }
      fireEvent.click(head);
      expect(useUiStore.getState().typesOpen).toBe(true);
      expect(useUiStore.getState().navClosed).toEqual(closedGroups);
      expect(sidebar.getByRole('button', { name: /^Project/ })).toBeTruthy();
      fireEvent.click(sidebar.getByRole('button', { name: 'Databases', expanded: true }));
      fireEvent.click(sidebar.getByRole('button', { name: 'New database' }));
      expect(screen.getByRole('dialog', { name: 'New database' })).toBeTruthy();
      expect(useUiStore.getState().typesOpen).toBe(false);
    });

    it('Home keeps its destination row without repeating its name in a passive area heading', () => {
      render(<Sidebar />);
      const sidebar = within(screen.getByRole('navigation', { name: 'Sidebar' }));
      expect(
        sidebar.getAllByText('Home', { exact: true }).filter((node) => !isInaccessible(node)),
      ).toHaveLength(1);
      expect(sidebar.getByRole('button', { name: 'Home' })).toBeTruthy();
      expect(sidebar.queryByRole('button', { name: 'New' })).toBeNull();
      expect(railButton('New')).toBeTruthy();
    });

    it.each(['New page', 'New folder'])(
      '%s opens the tree dialog even when Folders was stored closed',
      async (action) => {
        useUiStore.setState({ navClosed: closedGroups });
        render(<Sidebar />);
        chooseArea('Pages');
        const sidebar = within(screen.getByRole('navigation', { name: 'Sidebar' }));
        expect(sidebar.getByRole('button', { name: 'Folders', expanded: false })).toBeTruthy();
        expect(sidebar.getByRole('button', { name: 'All pages' })).toBeTruthy();
        expect(sidebar.queryByRole('button', { name: 'Open pages' })).toBeNull();
        expect(sidebar.queryByRole('button', { name: 'Pages' })).toBeNull();
        expect(sidebar.queryByRole('button', { name: 'New' })).toBeNull();
        fireEvent.click(sidebar.getByRole('button', { name: action }));
        const dialog = await screen.findByRole('dialog', { name: action });
        // It opens as the fold arrives, so nothing it is drawn inside may be
        // moving: a moving ancestor would hold the fixed dialog in the sidebar.
        expect(dialog.closest('.cb-fold-in')).toBeNull();
        expect(useUiStore.getState().pageTreeMode).toBe('folders');
        expect(useUiStore.getState().navClosed).toEqual(
          closedGroups.filter((group) => group !== 'pages'),
        );
        // Opening a creation flow keeps the browser's current place.
        expect(useNavStore.getState().selection).toEqual({ kind: 'pages' });
      },
    );

    const seedOverlappingTrees = () => {
      useVaultStore.setState({
        entries: [
          mkEntry({ path: 'delivery/brief.md', title: 'Delivery brief' }),
          mkEntry({ path: 'strategy/plan.md', title: 'Strategy plan' }),
        ],
        folders: ['delivery', 'strategy'],
        views: [],
        collections: ['delivery', 'strategy'].map((folder) => ({
          folder,
          declared: true,
          definition: {
            name: folder === 'delivery' ? 'Delivery' : 'Strategy',
            icon: null,
            color: null,
            order: null,
            description: null,
          },
        })),
      });
      useUiStore.setState({ expandedFolders: {}, favorites: {} });
    };

    it('shows shared folder paths once while switching Collections and Folders without rewriting folds', () => {
      seedOverlappingTrees();
      const preserved = ['base', 'agents', 'favorites', 'recents'];
      useUiStore.setState({ navClosed: preserved });
      render(<Sidebar />);
      chooseArea('Pages');
      const sidebar = within(screen.getByRole('navigation', { name: 'Sidebar' }));
      const assertTree = (mode: 'collections' | 'folders') => {
        expect(useUiStore.getState().pageTreeMode).toBe(mode);
        expect(
          sidebar.getByRole('button', { name: 'Collections', expanded: mode === 'collections' }),
        ).toBeTruthy();
        expect(
          sidebar.getByRole('button', { name: 'Folders', expanded: mode === 'folders' }),
        ).toBeTruthy();
        for (const label of ['Delivery', 'Strategy']) {
          expect(
            sidebar.getAllByText(label, { exact: true }).filter((node) => !isInaccessible(node)),
          ).toHaveLength(1);
        }
        const visibleCollections = sidebar
          .queryAllByTestId('collection-node-collection')
          .filter((node) => !isInaccessible(node));
        const visibleFolders = sidebar
          .queryAllByTestId('tree-folder')
          .filter((node) => !isInaccessible(node));
        expect(visibleCollections).toHaveLength(mode === 'collections' ? 2 : 0);
        expect(visibleFolders).toHaveLength(mode === 'folders' ? 2 : 0);
        expect(useUiStore.getState().navClosed).toEqual(preserved);
      };
      assertTree('collections');
      fireEvent.click(sidebar.getByRole('button', { name: 'Folders', expanded: false }));
      assertTree('folders');
      fireEvent.click(sidebar.getByRole('button', { name: 'Collections', expanded: false }));
      assertTree('collections');
      expect(useNavStore.getState().selection).toEqual({ kind: 'pages' });
    });

    it('Home Collections remains independent of the selected Pages tree mode', () => {
      seedOverlappingTrees();
      useUiStore.setState({ pageTreeMode: 'folders' });
      render(<Sidebar />);
      const sidebar = within(screen.getByRole('navigation', { name: 'Sidebar' }));
      expect(sidebar.getByRole('button', { name: 'Collections', expanded: true })).toBeTruthy();
      expect(sidebar.getByRole('button', { name: 'Delivery' })).toBeTruthy();
      expect(sidebar.queryByRole('button', { name: 'Folders' })).toBeNull();
      fireEvent.click(sidebar.getByRole('button', { name: 'Collections', expanded: true }));
      expect(sidebar.queryByRole('button', { name: 'Delivery' })).toBeNull();
      expect(useUiStore.getState().pageTreeMode).toBe('folders');
      expect(useUiStore.getState().navClosed).toContain('collections');
      chooseArea('Pages');
      expect(sidebar.getByRole('button', { name: 'Folders', expanded: true })).toBeTruthy();
      expect(sidebar.getByRole('button', { name: 'Collections', expanded: false })).toBeTruthy();
      expect(sidebar.getByRole('button', { name: /^Delivery/ })).toBeTruthy();
      chooseArea('Home');
      expect(sidebar.getByRole('button', { name: 'Collections', expanded: false })).toBeTruthy();
      expect(sidebar.queryByRole('button', { name: 'Delivery' })).toBeNull();
      expect(useUiStore.getState().pageTreeMode).toBe('folders');
    });

    it.each(['New page', 'New folder'])(
      '%s selects Folders and opens its existing dialog while Collections is visible',
      async (action) => {
        seedOverlappingTrees();
        useUiStore.setState({ navClosed: ['base', 'pages', 'favorites'] });
        render(<Sidebar />);
        chooseArea('Pages');
        const sidebar = within(screen.getByRole('navigation', { name: 'Sidebar' }));
        expect(sidebar.getByRole('button', { name: 'Collections', expanded: true })).toBeTruthy();
        expect(sidebar.getByRole('button', { name: 'Delivery' })).toBeTruthy();
        fireEvent.click(sidebar.getByRole('button', { name: action }));
        expect(await screen.findByRole('dialog', { name: action })).toBeTruthy();
        expect(useUiStore.getState().pageTreeMode).toBe('folders');
        expect(useUiStore.getState().navClosed).toEqual(['base', 'favorites']);
        expect(useNavStore.getState().selection).toEqual({ kind: 'pages' });
      },
    );
  });

  /**
   * The shell's destinations, asserted rather than assumed.
   *
   * This contract lived in `Rail.test.tsx` from M33.4 until M37.3 retired the
   * rail; the flattened nav column inherits it whole. The list is the
   * assertion: adding or removing a destination is a decision, and a decision
   * belongs in a diff somebody reads.
   */
  describe('destinations contract (was Rail.test.tsx, M37.3)', () => {
    const surfaceLabels = () => {
      const labels: string[] = [];
      for (const group of screen.getAllByTestId('nav-surfaces')) {
        for (const button of within(group).getAllByRole('button')) {
          // The inbox label carries its count; the footer rows name
          // themselves by text. Everything else is a bare aria-label.
          labels.push(
            (button.getAttribute('aria-label') ?? button.textContent ?? '').replace(
              / \(\d+\)$/,
              '',
            ),
          );
        }
      }
      return labels;
    };

    it('Home carries no count, whatever its lanes hold (D9 b)', () => {
      render(<Sidebar />);
      const home = within(screen.getByTestId('nav-surfaces')).getByRole('button', { name: 'Home' });
      expect(home.textContent).toBe('Home');
    });

    it('carries exactly the destinations the shell has (M43)', () => {
      render(<Sidebar />);
      const labels = surfaceLabels();
      // M43: Inbox leads (the design's hot queue), My work is new, Library
      // came up from the footer, and the footer holds Theme + Settings.
      // M43.10: Work and Base left the destinations for SECTIONS — their
      // subjects list like every other shelf — so Studio and History stand
      // alone under My work.
      expect(labels).toEqual(['Inbox', 'Home', 'My work', 'Studio', 'History', 'Library']);
      // M33a.2 folded the Status hub into Knowledge; M37.2 spent the locked
      // names (Base was Knowledge, Work was Workspace); M38.3 retired Docs —
      // pages are a standing tree section, not a destination. M43 moved
      // Agents into a section and the Assistant onto the header zap. Each
      // merge that removes or renames a destination leaves the old name here,
      // because the failure mode is a label silently coming back.
      expect(labels).not.toContain('Status');
      expect(labels).not.toContain('Needs review');
      expect(labels).not.toContain('Background');
      expect(labels).not.toContain('Knowledge');
      expect(labels).not.toContain('Workspace');
      expect(labels).not.toContain('Docs');
      expect(labels).not.toContain('Agents');
      expect(labels).not.toContain('Assistant');
      expect(labels).not.toContain('Work');
      expect(labels).not.toContain('Base');
    });

    // M59.1 — the rows, doors and footer are engine/destinations.ts's.
    describe('read from the destination table (M59.1)', () => {
      const navRows = DESTINATIONS.filter((d) => d.nav === 'row');
      const rowButton = (label: string) =>
        screen
          .getAllByTestId('nav-surfaces')
          .map((group) => within(group).queryByRole('button', { name: new RegExp(`^${label}`) }))
          .find((button) => button != null);

      it("draws the table's nav rows, in its order", () => {
        render(<Sidebar />);
        expect(surfaceLabels().slice(0, navRows.length)).toEqual(navRows.map((d) => d.label));
      });

      it('has no Inbox row with the inbox workflow off', () => {
        useUiStore.setState({ inboxEnabled: false });
        render(<Sidebar />);
        expect(surfaceLabels()).not.toContain('Inbox');
        expect(surfaceLabels()[0]).toBe('Home');
      });

      it('lights History on Changes', () => {
        useNavStore.setState({ selection: { kind: 'changes' } });
        render(<Sidebar />);
        expect(rowButton('History')?.getAttribute('aria-current')).toBe('page');
      });

      it('names the Work, Knowledge and Agents sections and their doors from the table', () => {
        render(<Sidebar />);
        for (const kind of ['workspace', 'knowledge', 'agents'] as const) {
          const d = destination(kind);
          chooseArea(d.label);
          expect(screen.getByRole('button', { name: d.label, expanded: true })).toBeTruthy();
          expect(screen.getByRole('button', { name: d.door })).toBeTruthy();
        }
      });

      it("goes to each row's selection", () => {
        render(<Sidebar />);
        for (const d of navRows) {
          const button = rowButton(d.label);
          if (button == null) throw new Error(`no ${d.label} row`);
          fireEvent.click(button);
          expect(useNavStore.getState().selection, d.label).toEqual(d.selection);
        }
      });
    });

    it('renders on every surface — the SIDEBARLESS set retired with the rail (M37.3)', () => {
      // These six returned `null` while the sidebar was contextual: their
      // objection was Collections-and-Types-as-irrelevant-width. A nav that is
      // the whole shell is not irrelevant to any surface, and a one-column
      // shell with no column is no shell at all.
      const surfaces: Selection[] = [
        { kind: 'settings' },
        { kind: 'pulse' },
        { kind: 'inbox' },
        { kind: 'library' },
        { kind: 'workspace' },
        { kind: 'diagram', path: 'diagrams/pipeline.mmd' },
      ];
      for (const selection of surfaces) {
        useNavStore.setState({ selection });
        render(<Sidebar />);
        expect(screen.getByTestId('app-rail')).toBeTruthy();
        for (const name of [
          'Home',
          'Pages',
          'Databases',
          'Knowledge',
          'Agents',
          'Work',
          'Assistant',
          'Settings',
        ])
          expect(railButton(name)).toBeTruthy();
        cleanup();
      }
    });

    it('lets the Pages tree carry a doc page — no destination claims it (M38.3)', () => {
      // A doc used to light the Docs destination; with the surface gone the
      // open page is marked in the tree itself, and every destination row
      // stays dark rather than one of them lying about where you are.
      useNavStore.setState({ selection: { kind: 'doc', path: 'inbox/welcome.md' } });
      const { container } = render(<Sidebar />);
      expect(
        container.querySelectorAll('[data-testid="nav-surfaces"] [aria-current="page"]'),
      ).toHaveLength(0);
    });

    // M15: Home's active state used to be computed by negating every other
    // slot, so any kind nobody remembered to negate lit it up. M52: nor is it
    // the item world's front door any more — a Collection, a List and a Type
    // are rows of their own, and on the Epic table Home and Epic were both
    // current.
    it('leaves Home dark on the surfaces another row owns', () => {
      for (const selection of [
        { kind: 'settings' } as const,
        { kind: 'changes' } as const,
        { kind: 'knowledge' } as const,
        { kind: 'diagram', path: 'diagrams/pipeline.mmd' } as const,
        // M12.5: projects retired — a container selection is a Collection.
        { kind: 'collection', folder: 'projects/x' } as const,
        { kind: 'list', id: 'backlog', collection: 'work' } as const,
        { kind: 'type', name: 'Epic' } as const,
      ]) {
        useNavStore.setState({ selection });
        render(<Sidebar />);
        expect(railButton('Home').getAttribute('aria-current')).toBeNull();
        cleanup();
      }
    });

    it('keeps Settings selected while its floating assistant is open', () => {
      useNavStore.setState({ selection: { kind: 'settings' } });
      render(<Sidebar />);
      const rail = screen.getByTestId('app-rail');
      const selected = () => rail.querySelectorAll('[aria-current="page"], [aria-pressed="true"]');
      expect([...selected()]).toEqual([railButton('Settings')]);
      expect(rail.querySelectorAll('[data-active]')).toHaveLength(0);
      fireEvent.click(railButton('Assistant'));
      expect([...selected()]).toEqual([railButton('Assistant'), railButton('Settings')]);
      expect([...rail.querySelectorAll('[data-active]')]).toEqual([railButton('Assistant')]);
      fireEvent.click(railButton('Settings'));
      expect([...selected()]).toEqual([railButton('Assistant'), railButton('Settings')]);
    });

    it('marks the current destination with aria-current and the assistant with aria-pressed', () => {
      useNavStore.setState({ selection: { kind: 'studio' } });
      render(<Sidebar />);
      // Scoped to the destination containers: only the destination row wears
      // aria-current (M43.10 — Studio is a standalone row, lit for the whole
      // surface now that no prototype rows nest under it).
      const studio = screen
        .getAllByTestId('nav-surfaces')
        .map((group) => within(group).queryByRole('button', { name: 'Studio' }))
        .find((button) => button != null);
      expect(studio?.getAttribute('aria-current')).toBe('page');
      // A toggle is not a destination: it reports pressed, never current.
      const assistant = screen.getByRole('button', { name: 'Assistant' });
      expect(assistant.getAttribute('aria-pressed')).toBe('false');
      expect(assistant.getAttribute('aria-current')).toBeNull();
      fireEvent.click(assistant);
      expect(screen.getByRole('button', { name: 'Assistant' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
    });

    // M15: the badge counts what the Inbox will show. The Inbox has no period
    // to narrow it, so an old capture counts like a new one and a filed note
    // never counts.
    it('counts every capture the Inbox will show, however old', () => {
      const capture = (path: string, daysAgo: number): Entry =>
        mkEntry({
          path,
          folder: 'inbox',
          createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
          modifiedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
        });
      useVaultStore.setState({
        entries: [
          capture('inbox/a.md', 1),
          capture('inbox/b.md', 40),
          { ...capture('inbox/filed.md', 1), properties: { _organized: true } },
        ],
      });
      render(<Sidebar />);
      expect(screen.getByRole('button', { name: 'Inbox (2)' })).toBeTruthy();
    });

    it('keeps the Base rows available on every surface, lighting none while elsewhere (M42.2)', () => {
      // M37.3 nested these rows under Base only WHILE current; the Notion turn
      // makes them standing — "we see it all there, available" — and the
      // un-current nav elects no default row, because a highlight naming a
      // view that is not on screen is worse than none.
      useNavStore.setState({ selection: { kind: 'home' } });
      render(<Sidebar />);
      const rows = screen.getAllByTestId('knowledge-nav-row');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((row) => row.getAttribute('aria-current') === 'page')).toEqual([]);
    });

    // M52.3 — a concept is a page (M50.1), and reading one lit nothing: the
    // nav said you were nowhere in Knowledge.
    it("lights a concept page's folder row, and only while it is on screen", () => {
      const conceptAt = (path: string, title: string) =>
        mkEntry({ path, title, type: 'Metric', folder: path.slice(0, path.lastIndexOf('/')) });
      useVaultStore.setState({
        entries: [
          project,
          conceptAt('knowledge/metrics/sync-error-rate.md', 'Sync error rate'),
          conceptAt('knowledge/systems/drain.md', 'Drain time'),
        ],
      });
      useNavStore.setState({
        selection: { kind: 'doc', path: 'knowledge/metrics/sync-error-rate.md' },
      });
      render(<Sidebar />);
      const lit = () =>
        screen
          .getAllByTestId('knowledge-nav-row')
          .filter((row) => row.getAttribute('aria-current') === 'page')
          .map((row) => row.textContent);
      expect(lit()).toEqual(['Metrics1']);
      // Review stays the last row — the folders, then the queue (M51).
      const rows = screen.getAllByTestId('knowledge-nav-row');
      expect(rows[rows.length - 1].dataset.tab).toBe('review');
      cleanup();

      // An ordinary page is not Knowledge's canvas.
      useNavStore.setState({ selection: { kind: 'doc', path: 'projects/foundations/project.md' } });
      render(<Sidebar />);
      expect(lit()).toEqual([]);
      cleanup();

      useNavStore.setState({ selection: { kind: 'home' } });
      render(<Sidebar />);
      expect(lit()).toEqual([]);
    });

    // M52.4 — the bundle's own index is structure, not a root concept, so it
    // does not light "Ungrouped".
    it("lights no folder for the bundle's own index", () => {
      useVaultStore.setState({
        entries: [
          project,
          mkEntry({ path: 'knowledge/loose.md', title: 'Loose end', type: 'Concept' }),
          mkEntry({ path: 'knowledge/index.md', title: 'Index' }),
          mkEntry({ path: 'knowledge/metrics/index.md', title: 'Metrics index' }),
          mkEntry({ path: 'knowledge/metrics/sync-error-rate.md', title: 'Sync error rate' }),
        ],
      });
      useNavStore.setState({ selection: { kind: 'doc', path: 'knowledge/index.md' } });
      render(<Sidebar />);
      const rows = screen.getAllByTestId('knowledge-nav-row');
      expect(rows.map((row) => row.textContent)).toContain('Ungrouped1');
      expect(rows.filter((row) => row.getAttribute('aria-current') === 'page')).toEqual([]);
      cleanup();

      // A folder's own index still lights its folder.
      useNavStore.setState({ selection: { kind: 'doc', path: 'knowledge/metrics/index.md' } });
      render(<Sidebar />);
      expect(
        screen
          .getAllByTestId('knowledge-nav-row')
          .filter((row) => row.getAttribute('aria-current') === 'page')
          .map((row) => row.textContent),
      ).toEqual(['Metrics1']);
    });

    it('lists the vault agents in the Agents SECTION, whose header folds it (M43)', () => {
      useVaultStore.setState({
        entries: [
          project,
          mkEntry({ path: 'records/agents/scout.md', title: 'Scout', type: 'Agent' }),
        ],
      });
      render(<Sidebar />);
      // The row is a destination for ONE agent — its page (M55.12) — and it
      // lives outside the `nav-surfaces` containers, so an agent named after
      // a destination can never be caught by a spec scoped to them.
      fireEvent.click(screen.getByTestId('nav-agent'));
      expect(useNavStore.getState().selection).toEqual({
        kind: 'doc',
        path: 'records/agents/scout.md',
      });
      expect(screen.getByTestId('nav-agent').getAttribute('aria-current')).toBe('page');
      // The header's reveals: ↗ is the door to the fleet, ＋ starts a new
      // agent — the affordances the destination row and its nested "New
      // agent" row used to carry.
      fireEvent.click(screen.getByRole('button', { name: 'Open all agents' }));
      expect(useNavStore.getState().selection).toEqual({ kind: 'agents' });
      // Folding is not navigating: the header hides the rows and the
      // selection stays where it was.
      const head = within(screen.getByTestId('sidebar')).getByRole('button', {
        name: 'Agents',
        expanded: true,
      });
      expect(head.getAttribute('aria-expanded')).toBe('true');
      fireEvent.click(head);
      expect(screen.queryAllByTestId('nav-agent')).toEqual([]);
      expect(useNavStore.getState().selection).toEqual({ kind: 'agents' });
      // The header action survives the fold — creation is not membership —
      // and it is still the Library's create flow.
      fireEvent.click(screen.getByTestId('nav-agent-new'));
      expect(useNavStore.getState().selection).toEqual({ kind: 'library', tab: 'agent' });
    });

    it('the search row opens QuickOpen', () => {
      render(<Sidebar />);
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      expect(useUiStore.getState().quickOpenVisible).toBe(true);
    });
  });

  // M10: Collections are the top-level navigation, and the ONLY one — there is
  // no second grouping beside it, because a folder holding Lists is a
  // Collection so nothing can be orphaned. Projects are not a sidebar primitive.
  it('shows Collections as the only top-level grouping, and no project rows', () => {
    render(<Sidebar />);
    expect(screen.getByText('Collections')).toBeTruthy();
    // The folder holding the List is an implied Collection named after itself.
    // Scoped to the tree: the Work DESTINATION row (M37.2's locked name)
    // shares the accessible name now that both live in one column.
    expect(
      screen.getAllByTestId('collection-node-collection').some((n) => n.dataset.id === 'work'),
    ).toBe(true);
    expect(screen.queryByText('Lists')).toBeNull();
    expect(screen.queryByTestId('sidebar-project')).toBeNull();
    expect(screen.queryByText('New project')).toBeNull();
  });

  it('clicking a List navigates to it, carrying its collection', () => {
    useUiStore.setState({ expandedFolders: { 'collection:work': true } });
    render(<Sidebar />);
    fireEvent.click(screen.getByText('Urgent work'));
    // The collection is part of the key: ids are unique per folder only.
    expect(useNavStore.getState().selection).toEqual({
      kind: 'list',
      id: 'urgent-work',
      collection: 'work',
    });
  });

  // An implied Collection has no marker, so there is nothing to remove — and an
  // action that silently does nothing is worse than one that is absent.
  it('offers no Remove on an implied Collection, but does on a declared one', () => {
    render(<Sidebar />);
    const workNode = screen
      .getAllByTestId('collection-node-collection')
      .find((n) => n.dataset.id === 'work');
    if (workNode === undefined) throw new Error('implied Work collection not rendered');
    fireEvent.contextMenu(workNode);
    expect(screen.getByText('Rename…')).toBeTruthy();
    expect(screen.queryByText(/Remove collection/)).toBeNull();
  });

  it('the + button opens the new-collection dialog', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId('new-collection'));
    expect(screen.getByRole('textbox', { name: 'Collection name' })).toBeTruthy();
  });

  it('shows an empty hint when the vault has no collections and no lists', () => {
    useVaultStore.setState({ entries: [], views: [], collections: [] });
    render(<Sidebar />);
    expect(screen.getByText(/No collections yet/)).toBeTruthy();
  });

  // M10: the tree — a Collection expands to reveal its Lists and Docs, and its
  // hover + creates a List INTO that collection rather than at the top level.
  it('expands a Collection to reveal its Lists', () => {
    const roadmap = {
      id: 'roadmap',
      project: null,
      collection: 'product',
      path: 'product/roadmap.list.yml',
      definition: {
        name: 'Roadmap',
        icon: null,
        color: null,
        order: null,
        source: { type: null, project: null },
        views: [
          {
            id: 'view',
            name: 'View',
            icon: null,
            filters: null,
            presentation: {
              type: 'table' as const,
              group: [],
              sort: [{ field: 'modifiedAt', dir: 'desc' as const }],
              columns: [],
            },
          },
        ],
      },
    };
    useVaultStore.setState({
      views: [roadmap],
      collections: [
        {
          folder: 'product',
          declared: true,
          definition: { name: 'Product', icon: null, color: null, order: null, description: null },
        },
      ],
    });
    useUiStore.setState({ expandedFolders: {} });
    render(<Sidebar />);
    // Collapsed: the Collection shows, its contents do not.
    expect(screen.getByText('Product')).toBeTruthy();
    expect(screen.queryByText('Roadmap')).toBeNull();
    const caret = screen.getByRole('button', { name: 'Expand Product' });
    // One chevron, turned by its state rather than traded for another glyph.
    const chevron = () => caret.querySelector('[data-icon="chevron-right"]');
    expect(caret.querySelector('[data-icon="chevron-down"]')).toBeNull();
    expect(chevron()?.classList.contains('cb-chevron--open')).toBe(false);
    fireEvent.click(caret);
    expect(screen.getByText('Roadmap')).toBeTruthy();
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    expect(caret.querySelector('[data-icon="chevron-down"]')).toBeNull();
    expect(chevron()?.classList.contains('cb-chevron--open')).toBe(true);
    // What it holds drops in under it, the Collection's own row staying put.
    const fold = screen.getByText('Roadmap').closest('.cb-fold-in');
    expect(fold).not.toBeNull();
    expect(fold?.contains(screen.getByText('Product'))).toBe(false);
  });

  it("offers a page and a database, and no longer a list, from a Collection's +", () => {
    useVaultStore.setState({
      views: [],
      collections: [
        {
          folder: 'product',
          declared: true,
          definition: { name: 'Product', icon: null, color: null, order: null, description: null },
        },
      ],
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Product' }));
    // M47.5: the `+` opens a MENU now. It used to go straight to the New list
    // dialog, which is why a collection could hold nothing but lists and its
    // empty page could only tell you to come back here. A page comes first.
    // M47.6 took the third door away: a saved view belongs to the database it
    // queries, so there is nothing left that authors a `*.list.yml`.
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['New page', 'New database']);
  });

  // Enter or Space on the `+` reports clientX/clientY as 0, so a menu placed
  // at the pointer opened in the window's corner for keyboard users.
  it("anchors a Collection's add menu to the + itself, not the pointer", () => {
    useVaultStore.setState({
      views: [],
      collections: [
        {
          folder: 'product',
          declared: true,
          definition: { name: 'Product', icon: null, color: null, order: null, description: null },
        },
      ],
    });
    render(<Sidebar />);
    const plus = screen.getByRole('button', { name: 'Add to Product' });
    vi.spyOn(plus, 'getBoundingClientRect').mockReturnValue({
      left: 180,
      bottom: 240,
      top: 220,
      right: 200,
      width: 20,
      height: 20,
      x: 180,
      y: 220,
      toJSON: () => ({}),
    });
    fireEvent.click(plus, { clientX: 0, clientY: 0 });
    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('180px');
    expect(menu.style.top).toBe('240px');
  });

  // The context menu had its OWN "New list…" — a fourth entrance to the same
  // dialog. Asserted by absence because a menu that still offered it would
  // still be able to author the retired format.
  it("a Collection's context menu offers renaming and removal, not a new list", () => {
    useVaultStore.setState({
      views: [],
      collections: [
        {
          folder: 'product',
          declared: true,
          definition: { name: 'Product', icon: null, color: null, order: null, description: null },
        },
      ],
    });
    render(<Sidebar />);
    const row = screen
      .getAllByTestId('collection-node-collection')
      .find((el) => el.dataset.id === 'product');
    if (row === undefined) throw new Error('the Product row is missing from the tree');
    fireEvent.contextMenu(row, { clientX: 4, clientY: 4 });
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Rename…', 'Remove collection (keeps contents)']);
  });

  // M37.3 made the header answer "which vault"; M43 moved that answer onto
  // the tile (the slot the design gives an avatar) so the wordmark could take
  // the line — and no heading at all, so every page keeps its own h1 story.
  it('wears the vault as the header tile (M43)', () => {
    render(<Sidebar />);
    const tile = screen.getByTestId('vault-tile');
    expect(tile.parentElement?.getAttribute('title')).toBe('demo-vault');
    expect(tile.textContent).toBe('D');
    expect(screen.queryByRole('heading', { name: 'demo-vault' })).toBeNull();
  });

  // M15: `flex-none` here was what made the canvas absorb every pixel of a
  // narrow window. The sidebar has to be the column that yields.
  it('is shrinkable down to its minimum rather than fixed', () => {
    const { container } = render(<Sidebar />);
    const nav = container.querySelector<HTMLElement>('[data-testid=sidebar]');
    expect(nav?.className).not.toContain('flex-none');
    expect(nav?.style.minWidth).toBe('180px');
  });

  it('draws at its minimum and withdraws the resize handle while narrow', () => {
    useUiStore.setState({ sidebarWidth: 420 });
    render(<Sidebar narrow />);
    expect(screen.getByTestId('sidebar').className).toContain('max-[1048px]:hidden');
    fireEvent.click(railButton('Show sidebar'));
    expect(screen.getByTestId('sidebar').style.width).toBe('420px');
    expect(screen.getByTestId('sidebar').dataset.overlay).toBe('true');
    expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).toBeNull();
    cleanup();
    // The STORED preference is untouched — widening the window restores it.
    expect(useUiStore.getState().sidebarWidth).toBe(420);
    const wide = render(<Sidebar />);
    expect(wide.getByTestId('sidebar').style.width).toBe('420px');
  });

  // M52 — verified at 1440 beside a record and the assistant: the drag stored
  // 460 while the row drew 340, and the sidebar leapt when the record closed.
  it('stops its drag at the widest it can be drawn, and starts it from the drawn width', () => {
    useUiStore.setState({ sidebarWidth: 420 });
    render(<Sidebar maxWidth={340} />);
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' });
    expect(handle.getAttribute('aria-valuemax')).toBe('340');
    expect(handle.getAttribute('aria-valuenow')).toBe('340');
    // A step that cannot widen it keeps the stored width: writing the drawn
    // one narrowed the preference (verified at 1280, where a drag to widen
    // stored 180 over 264 and kept it once the room came back) …
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(useUiStore.getState().sidebarWidth).toBe(420);
    // … and one that narrows it stores what it draws.
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(useUiStore.getState().sidebarWidth).toBe(328);
  });

  /**
   * M52 — the rail: what the shell steps the sidebar down to beside a record
   * and the assistant, instead of parking the assistant. Derived, like
   * `narrow`: it must never write the user's collapsed flag.
   */
  describe('rail', () => {
    /** Mounted beside the column, and CSS shows one (jsdom applies no CSS). */
    const railShown = (nav: HTMLElement) => !nav.className.includes(':hidden');
    const drawerOpen = () => screen.getByTestId('sidebar').dataset.overlay === 'true';

    it('keeps expand, ask and search in a strip of its own', () => {
      render(<Sidebar rail railBand="band" />);
      const rail = screen.getByTestId('app-rail');
      // Both mounted; the media query shows the rail in 1094–1273 and the
      // column either side of it.
      expect(rail.className).toContain('m71-app-rail');
      expect(screen.getByTestId('sidebar').className).toContain('min-[1094px]:max-[1274px]:hidden');
      for (const name of ['Show sidebar', 'Assistant', 'Search']) {
        expect(within(rail).getByRole('button', { name })).toBeTruthy();
      }
      fireEvent.click(within(rail).getByRole('button', { name: 'Assistant' }));
      expect(useUiStore.getState().aiPanelOpen).toBe(true);
    });

    it('opens the whole sidebar as a drawer, and Escape closes it without collapsing', () => {
      render(<Sidebar rail railBand="band" />);
      const rail = screen.getByTestId('app-rail');
      fireEvent.click(within(rail).getByRole('button', { name: 'Show sidebar' }));
      const drawer = screen.getByTestId('sidebar');
      expect(drawer.dataset.overlay).toBe('true');
      // Out of the row, so no media query hides it.
      expect(railShown(drawer)).toBe(true);
      // Floating at the stored width, so no handle measures it against the row.
      expect(within(drawer).queryByRole('separator', { name: 'Resize sidebar' })).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(drawerOpen()).toBe(false);
      expect(screen.getByTestId('app-rail')).toBeTruthy();
      expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    });

    it('closes the drawer on a press past it, on its own hide control, and on going anywhere', () => {
      render(<Sidebar rail railBand="band" />);
      const open = () =>
        fireEvent.click(
          within(screen.getByTestId('app-rail')).getByRole('button', { name: 'Show sidebar' }),
        );

      open();
      fireEvent.click(screen.getByTestId('sidebar-drawer-scrim'));
      expect(drawerOpen()).toBe(false);

      open();
      fireEvent.click(within(screen.getByTestId('sidebar')).getByTestId('sidebar-collapse'));
      expect(drawerOpen()).toBe(false);
      expect(useUiStore.getState().sidebarCollapsed).toBe(false);

      open();
      const [surfaces] = screen.getAllByTestId('nav-surfaces');
      if (surfaces === undefined) throw new Error('no destinations');
      fireEvent.click(within(surfaces).getByRole('button', { name: 'My work' }));
      expect(useNavStore.getState().selection).toEqual({ kind: 'mywork' });
      expect(drawerOpen()).toBe(false);
    });

    it('gives way to the column the moment there is room, drawer closed', () => {
      const { rerender } = render(<Sidebar rail railBand="band" />);
      const nav = screen.getByTestId('sidebar');
      fireEvent.click(
        within(screen.getByTestId('app-rail')).getByRole('button', { name: 'Show sidebar' }),
      );
      rerender(<Sidebar />);
      // The same nav throughout: a drawer opening or closing never remounts it.
      expect(screen.getByTestId('sidebar')).toBe(nav);
      expect(nav.dataset.overlay).toBeUndefined();
      expect(screen.getByTestId('app-rail')).toBeTruthy();
      // And the next rail starts closed.
      rerender(<Sidebar rail railBand="band" />);
      expect(drawerOpen()).toBe(false);
    });

    it('holds the rail under all of 1274 once latched', () => {
      render(<Sidebar rail railBand="below" />);
      expect(screen.getByTestId('app-rail').className).toContain('m71-app-rail');
      expect(screen.getByTestId('sidebar').className).toMatch(/(^|\s)max-\[1274px\]:hidden(\s|$)/);
    });
  });

  // Task 14 / M38.3: the Drive-style file tree is the standing Pages section
  // now — the Docs destination died with its surface, and in a shell where
  // everything is a page the pages ARE navigation, not a mode.
  it('makes the Pages tree reachable from every surface', () => {
    const doc = mkEntry({
      path: 'inbox/welcome.md',
      filename: 'welcome.md',
      title: 'Welcome',
    });
    useVaultStore.setState({ entries: [project, doc], folders: ['inbox', 'projects'] });
    render(<Sidebar />);
    chooseArea('Pages');
    fireEvent.click(screen.getByRole('button', { name: 'Folders', expanded: false }));
    const fileTree = screen.getByTestId('file-tree');
    expect(screen.queryByTestId('sidebar-project')).toBeNull();
    // Scoped into the tree: the Inbox DESTINATION row shares the accessible
    // name with the inbox/ FOLDER row now that both live in one column.
    // Clicking a doc file opens it full-page; project.md routes to the project.
    // Rows show humanized folder names and note titles (M2.x feedback).
    fireEvent.click(within(fileTree).getByRole('button', { name: /^Inbox/ }));
    fireEvent.click(within(fileTree).getByRole('button', { name: /^Welcome/ }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'inbox/welcome.md' });
    cleanup();
    // The same selected Folders mode remains reachable when returning from
    // another surface through Pages; it does not silently revert to Collections.
    useNavStore.setState({ selection: { kind: 'settings' } });
    render(<Sidebar />);
    chooseArea('Pages');
    expect(screen.getByRole('button', { name: 'Folders', expanded: true })).toBeTruthy();
    expect(isInaccessible(screen.getByTestId('file-tree'))).toBe(false);
  });

  // M3: collapsible Types section above Views.
  describe('Types section', () => {
    beforeEach(() => useNavStore.setState({ selection: { kind: 'type', name: 'Recipe' } }));
    const recipeType = mkEntry({
      path: 'types/recipe.md',
      title: 'Recipe',
      type: 'Type',
      properties: { icon: 'chef-hat', color: '#DE8F0A' },
    });

    it('lists declared and referenced types with record counts', () => {
      useVaultStore.setState({
        entries: [
          project,
          recipeType,
          mkEntry({ path: 'recipes/pasta.md', title: 'Pasta', type: 'Recipe' }),
          mkEntry({ path: 'recipes/soup.md', title: 'Soup', type: 'Recipe' }),
        ],
      });
      render(<Sidebar />);
      const rows = screen.getAllByTestId('sidebar-type');
      const labels = rows.map((r) => r.textContent);
      // M12.2: no standing system rows — Project appears because a record
      // references it (ghost), Recipe because it is declared, Type because
      // the metamodel always exists. No phantom "Work item 0".
      expect(labels).toEqual(['Project1', 'Recipe2', 'Type1']);
    });

    it('clicking a type navigates to the type screen', () => {
      useVaultStore.setState({ entries: [project, recipeType] });
      render(<Sidebar />);
      fireEvent.click(screen.getByText('Recipe'));
      expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Recipe' });
    });

    // M52: Home stayed current beside the type's own row — two rows, one place.
    it("marks only the type's row current on its screen", () => {
      useVaultStore.setState({ entries: [project, recipeType] });
      useNavStore.setState({ selection: { kind: 'type', name: 'Recipe' } });
      const { container } = render(<Sidebar />);
      const current = [...container.querySelectorAll('[aria-current="page"]')];
      expect(current.map((el) => el.textContent)).toEqual(['Recipe0']);
    });

    // M39.2: the section wears the word it always meant — Databases. The
    // internal vocabulary (`type:`, TypeListing, the `type` kind, this very
    // testid) deliberately keeps the old word: labels spend, kinds stay.
    it('collapses via the section header', () => {
      render(<Sidebar />);
      fireEvent.click(screen.getByRole('button', { name: 'Databases', expanded: true }));
      expect(screen.queryAllByTestId('sidebar-type')).toEqual([]);
      expect(useUiStore.getState().typesOpen).toBe(false);
    });

    it('the + button opens the New-database dialog', () => {
      render(<Sidebar />);
      fireEvent.click(screen.getByRole('button', { name: 'New database' }));
      expect(screen.getByText('New database')).toBeTruthy();
    });

    it('opens Import CSV from the Databases header', () => {
      render(<Sidebar />);
      fireEvent.click(screen.getByRole('button', { name: 'Import CSV' }));
      expect(screen.getByTestId('csv-import-dialog')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Choose CSV' })).toBeTruthy();
    });

    // `listTypes` hides Collection, Skill and Agent, so the dialog's "taken"
    // check alone let it declare a schema over the app's own machinery.
    it('the New-database dialog refuses a name Cerebro reserves', () => {
      render(<Sidebar />);
      fireEvent.click(screen.getByRole('button', { name: 'New database' }));
      fireEvent.change(screen.getByPlaceholderText(/Recipe, Book/), {
        target: { value: 'Collection' },
      });
      expect(screen.getByText(/is a name Cerebro reserves/)).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });

    // Declared at birth, like the inline door: an implied home is shared by
    // Recipe and Recipes, so the dialog writes one no other database uses.
    it('the New-database dialog gives a plural twin a home of its own', async () => {
      const createItem = vi.fn(async () => 'types/recipes.md');
      useVaultStore.setState({ entries: [project, recipeType], createItem });
      render(<Sidebar />);
      fireEvent.click(screen.getByRole('button', { name: 'New database' }));
      fireEvent.change(screen.getByPlaceholderText(/Recipe, Book/), {
        target: { value: 'Recipes' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      await waitFor(() => expect(createItem).toHaveBeenCalled());
      const fm = (
        createItem.mock.calls[0] as unknown as [
          { frontmatter: { folder: string; statuses: unknown[]; fields: unknown } },
        ]
      )[0].frontmatter;
      expect(fm.folder).toBe('records/recipes-2');
      expect(fm.statuses.length).toBeGreaterThan(0);
      expect(fm.fields).toEqual({ status: { kind: 'status' } });
      await waitFor(() =>
        expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Recipes' }),
      );
    });

    it('right-click on a custom type offers rename and delete', () => {
      useVaultStore.setState({ entries: [project, recipeType] });
      render(<Sidebar />);
      fireEvent.contextMenu(screen.getByText('Recipe'));
      expect(screen.getByText('Change display name…')).toBeTruthy();
      expect(screen.getByText('Customize icon & color…')).toBeTruthy();
      expect(screen.getByText('Delete database')).toBeTruthy();
    });

    it('right-click on the metamodel only offers customize (locked)', () => {
      // M12.2: `Type` is the one remaining system type — the schema cannot
      // rename or delete itself. Every other type is fully editable.
      render(<Sidebar />);
      fireEvent.contextMenu(screen.getByText('Type'));
      expect(screen.getByText('Customize icon & color…')).toBeTruthy();
      expect(screen.queryByText('Change display name…')).toBeNull();
      expect(screen.queryByText('Delete database')).toBeNull();
    });
  });

  // Task 6: project-scoped views belong to their project's tabs, not here.
  // A project-scoped List is a project tab. It gets no sidebar node AND no
  // implied Collection for its folder — its home is the project, not a container.
  it('keeps project-scoped Lists out of the Collections tree entirely', () => {
    const scoped = {
      ...useVaultStore.getState().views[0],
      id: 'delivery',
      project: 'projects/foundations/project.md',
      collection: null,
      path: 'projects/foundations/views/delivery.yml',
      definition: { ...useVaultStore.getState().views[0].definition, name: 'Delivery' },
    };
    useVaultStore.setState({ views: [...useVaultStore.getState().views, scoped] });
    useUiStore.setState({ expandedFolders: { 'collection:work': true } });
    render(<Sidebar />);
    expect(screen.getByText('Urgent work')).toBeTruthy();
    expect(screen.queryByText('Delivery')).toBeNull();
    // No "Views"/"Foundations" container conjured from its folder either.
    expect(screen.queryByText('Views')).toBeNull();
  });
  // M43 — the new shelves.
  describe('M43 sections', () => {
    it("counts open work on the My work row — the page's own membership rule", () => {
      useVaultStore.setState({
        entries: [
          project,
          mkEntry({
            path: 'types/task.md',
            title: 'Task',
            type: 'Type',
            properties: {
              fields: { status: { kind: 'status' } },
              statuses: [
                { id: 'todo', group: 'active' },
                { id: 'done', group: 'done' },
              ],
            } as unknown as Entry['properties'],
          }),
          mkEntry({
            path: 'records/tasks/open.md',
            title: 'Open task',
            type: 'Task',
            properties: { status: 'todo' } as unknown as Entry['properties'],
          }),
          mkEntry({
            path: 'records/tasks/shipped.md',
            title: 'Shipped task',
            type: 'Task',
            properties: { status: 'done' } as unknown as Entry['properties'],
          }),
        ],
      });
      render(<Sidebar />);
      const row = screen.getByRole('button', { name: 'My work (1)' });
      fireEvent.click(row);
      expect(useNavStore.getState().selection).toEqual({ kind: 'mywork' });
    });

    it('says the empty Favorites in words — nobody pinned anything is a real zero', () => {
      useUiStore.setState({ favorites: {} });
      render(<Sidebar />);
      expect(screen.getByText('No favorites yet')).toBeTruthy();
    });

    it('renders a pinned page as a row and prunes a pointer whose file is gone', () => {
      useVaultStore.setState({
        entries: [project, mkEntry({ path: 'notes/keep.md', title: 'Keep me' })],
      });
      useUiStore.setState({ favorites: { '/demo-vault': ['notes/keep.md', 'notes/gone.md'] } });
      render(<Sidebar />);
      const rows = screen.getAllByTestId('nav-favorite');
      expect(rows.map((r) => r.textContent)).toEqual(['Keep me']);
      // The dead pointer left the STORE, not just the render — the list is
      // truthful, and the next session does not resurrect it.
      expect(useUiStore.getState().favorites['/demo-vault']).toEqual(['notes/keep.md']);
      fireEvent.click(rows[0]);
      expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'notes/keep.md' });
    });

    it.each([
      { status: 'scanning' as const, entriesVault: '/demo-vault' },
      { status: 'error' as const, entriesVault: '/demo-vault' },
      { status: 'ready' as const, entriesVault: '/previous-vault' },
    ])('keeps saved favorites until the current vault has a successful scan: %j', (scan) => {
      useVaultStore.setState({ ...scan, entries: [] });
      useUiStore.setState({ favorites: { '/demo-vault': ['notes/keep.md', 'notes/gone.md'] } });
      render(<Sidebar />);
      expect(useUiStore.getState().favorites['/demo-vault']).toEqual([
        'notes/keep.md',
        'notes/gone.md',
      ]);
      act(() =>
        useVaultStore.setState({
          status: 'ready',
          entriesVault: '/demo-vault',
          entries: [mkEntry({ path: 'notes/keep.md', title: 'Keep me' })],
        }),
      );
      expect(useUiStore.getState().favorites['/demo-vault']).toEqual(['notes/keep.md']);
    });

    // M55.11 — a page's own icon on its nav rows: the pinned page, and the
    // doc row a Collection lists.
    it('a favourite and a Collections doc row whose page has an icon both draw it', () => {
      const ROCKET = '\u{1F680}';
      const brief = mkEntry({
        path: 'work/brief.md',
        title: 'Brief',
        properties: { icon: ROCKET } as unknown as Entry['properties'],
      });
      useVaultStore.setState({ entries: [project, brief] });
      useUiStore.setState({
        favorites: { '/demo-vault': ['work/brief.md'] },
        expandedFolders: { 'collection:work': true },
      });
      render(<Sidebar />);
      const [fav] = screen.getAllByTestId('nav-favorite');
      expect(fav.querySelector('[role="img"]')?.textContent).toBe(ROCKET);
      const docRow = screen
        .getAllByTestId('collection-node-doc')
        .find((n) => n.dataset.id === 'work/brief.md');
      if (docRow === undefined) throw new Error('the Collection did not list its doc');
      expect(docRow.querySelector('[role="img"]')?.textContent).toBe(ROCKET);
      expect(docRow.querySelector('[data-icon="file-text"]')).toBeNull();
    });

    it('a pinned agent keeps its bot and opens its page (M55.12)', () => {
      useVaultStore.setState({
        entries: [
          project,
          mkEntry({ path: 'records/agents/scout.md', title: 'Scout', type: 'Agent' }),
        ],
      });
      useUiStore.setState({ favorites: { '/demo-vault': ['records/agents/scout.md'] } });
      render(<Sidebar />);
      const [row] = screen.getAllByTestId('nav-favorite');
      expect(row.querySelector('.lucide-bot')).toBeTruthy();
      fireEvent.click(row);
      expect(useNavStore.getState().selection).toEqual({
        kind: 'doc',
        path: 'records/agents/scout.md',
      });
    });

    it("creates pages from the Folders header through the tree's own dialog", async () => {
      render(<Sidebar />);
      chooseArea('Pages');
      fireEvent.click(screen.getByRole('button', { name: 'New page' }));
      // The FileTree's dialog — one creation flow, now opened from the header.
      expect(await screen.findByRole('dialog', { name: 'New page' })).toBeTruthy();
    });

    it('lists mounted repos in the Work SECTION, whose ↗ opens the surface (M43.10)', () => {
      useRootsStore.setState({
        roots: [
          {
            id: 'cerebro',
            label: 'cerebro',
            path: '/repos/cerebro',
            alias: '',
            color: null,
            caps: { knowledge: false, git: false, writable: false },
          },
        ],
      });
      render(<Sidebar />);
      // Each mounted folder is a row, like every other shelf's subjects.
      fireEvent.click(screen.getByTestId('nav-root'));
      expect(useNavStore.getState().selection).toEqual({ kind: 'workspace', root: 'cerebro' });
      // The ↗ is the door to the whole surface — the destination row died.
      fireEvent.click(screen.getByRole('button', { name: 'Open all repositories' }));
      expect(useNavStore.getState().selection).toEqual({ kind: 'workspace' });
    });

    it('says the empty Work section in words — nothing mounted is a real zero', () => {
      useRootsStore.setState({ roots: [] });
      render(<Sidebar />);
      expect(screen.getByText('No repositories mounted')).toBeTruthy();
    });

    // M50.5: the section is Knowledge now — one word for what agents learned.
    it('opens the Knowledge home from the section’s ↗ (M43.10)', () => {
      render(<Sidebar />);
      chooseArea('Knowledge');
      fireEvent.click(screen.getByRole('button', { name: 'Open Knowledge' }));
      expect(useNavStore.getState().selection).toEqual({ kind: 'knowledge' });
    });

    it('cycles the theme from the footer', () => {
      useUiStore.setState({ themeMode: 'system' });
      render(<Sidebar />);
      const theme = screen.getByRole('button', { name: 'Theme: system' });
      fireEvent.click(theme);
      expect(useUiStore.getState().themeMode).toBe('light');
      fireEvent.click(theme);
      expect(useUiStore.getState().themeMode).toBe('dark');
      fireEvent.click(theme);
      expect(useUiStore.getState().themeMode).toBe('system');
    });
  });

  /**
   * Arriving and leaving (owner, 2026-10-19). jsdom plays nothing, so these
   * hold the DOM the motion keys on — and, where a case stands in for Web
   * Animations, the drawer's way out (app/shellMotion.ts).
   */
  describe('motion', () => {
    /** A window that plays motion: Web Animations present, none of them running. */
    const allowMotion = () =>
      Object.defineProperty(Element.prototype, 'getAnimations', {
        configurable: true,
        writable: true,
        value: () => [],
      });
    afterEach(() => {
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
      delete (document.documentElement as { animate?: unknown }).animate;
      delete (document as { startViewTransition?: unknown }).startViewTransition;
      // A case that changed the theme leaves none behind, pass or fail.
      document.documentElement.removeAttribute('data-theme-reveal');
      document.documentElement.removeAttribute('data-theme');
    });

    it('drops a section’s contents in under a header that turns one chevron', () => {
      useUiStore.setState({ favorites: {} });
      render(<Sidebar />);
      const header = within(screen.getByTestId('sidebar')).getByRole('button', {
        name: 'Favorites',
        expanded: true,
      });
      expect(header.querySelector('[data-icon="chevron-down"]')).toBeNull();
      expect(header.querySelector('.cb-chevron--open [data-icon="chevron-right"]')).not.toBeNull();
      const body = () => screen.queryByText('No favorites yet')?.closest('.cb-fold-in');
      expect(body()?.contains(header)).toBe(false);
      fireEvent.click(header);
      expect(header.getAttribute('aria-expanded')).toBe('false');
      expect(header.querySelector('.cb-chevron--open')).toBeNull();
      expect(body()).toBeUndefined();
      fireEvent.click(header);
      expect(body()).not.toBeNull();
    });

    it('brings the docked column back in only after it has been away', () => {
      useUiStore.setState({ sidebarWidth: 300 });
      render(<Sidebar />);
      const nav = screen.getByTestId('sidebar');
      // The app's first draw is not a return.
      expect(nav.dataset.returns).toBeUndefined();
      fireEvent.click(within(nav).getByTestId('sidebar-collapse'));
      expect(nav.hidden).toBe(true);
      fireEvent.click(railButton('Show sidebar'));
      expect(nav.hidden).toBe(false);
      expect(nav.dataset.returns).toBe('true');
      // Only the drawing changes: the stored width and the fold are the user's.
      expect(useUiStore.getState().sidebarWidth).toBe(300);
      expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    });

    it('leaves the drawer as a copy once it has closed, and never as it opens', async () => {
      // A window that plays motion, where the drawer's copy plays its way
      // out until the case ends it.
      let end: () => void = () => undefined;
      const finished = new Promise<void>((done) => (end = done));
      const exit = {
        playState: 'running',
        finished,
        finish: () => undefined,
        effect: { getComputedTiming: () => ({ iterations: 1 }) },
      } as unknown as Animation;
      Object.defineProperty(Element.prototype, 'getAnimations', {
        configurable: true,
        writable: true,
        value(this: Element) {
          return this.classList.contains('m71-sidebar-leave') ? [exit] : [];
        },
      });
      render(
        <StrictMode>
          <Sidebar rail railBand="band" />
        </StrictMode>,
      );
      const nav = screen.getByTestId('sidebar');
      const copy = () => document.querySelector<HTMLElement>('.m71-sidebar-leave');
      fireEvent.click(railButton('Show sidebar'));
      expect(nav.dataset.overlay).toBe('true');
      // Development mode unmounts and remounts on mount: no copy for that.
      await act(async () => {
        await Promise.resolve();
      });
      expect(copy()).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });
      await act(async () => {
        await Promise.resolve();
      });
      // The real nav closed in the commit (so the scrim, Escape and focus
      // return are as before); a nameless copy of the drawer plays the exit.
      expect(nav.dataset.overlay).toBeUndefined();
      expect(screen.queryByTestId('sidebar-drawer-scrim')).toBeNull();
      // Under the nav, which draws over it if opened again at once.
      expect(copy()?.nextElementSibling).toBe(nav);
      expect(copy()?.classList.contains('m71-sidebar-drawer')).toBe(true);
      expect(copy()?.hasAttribute('inert')).toBe(true);
      expect(screen.getAllByTestId('sidebar')).toHaveLength(1);
      end();
      await act(async () => {
        await finished;
        await Promise.resolve();
      });
      expect(copy()).toBeNull();
    });

    it('changes the theme inside the reveal its control starts, not before it', () => {
      allowMotion();
      useUiStore.setState({ themeMode: 'light' });
      document.documentElement.setAttribute('data-theme', 'light');
      let update: () => void = () => undefined;
      const start = vi.fn((callback: () => void) => {
        update = callback;
        return { ready: new Promise(() => undefined), finished: new Promise(() => undefined) };
      });
      Object.defineProperty(document, 'startViewTransition', {
        configurable: true,
        writable: true,
        value: start,
      });
      render(<Sidebar />);
      fireEvent.click(railButton('Theme: light'));
      expect(start).toHaveBeenCalledOnce();
      expect(useUiStore.getState().themeMode).toBe('light');
      act(() => update());
      expect(useUiStore.getState().themeMode).toBe('dark');
      expect(railButton('Theme: dark')).toBeTruthy();
    });
  });
});

it('a modified destination click opens beside without moving the original page', () => {
  useNavStore.getState().reset();
  useNavStore.getState().setPaneCapacity(2);
  const first = useNavStore.getState().active;
  const stop = installOpenIntent();
  try {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }), { ctrlKey: true });
    expect(useNavStore.getState().paneIds).toHaveLength(2);
    expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
    expect(useNavStore.getPaneState(first).selection).toEqual({ kind: 'home' });
  } finally {
    stop();
    cleanup();
  }
});

it('keeps a favorite through the batch rescan until the rename hook moves it', () => {
  cleanup();
  useVaultStore.setState({
    vaultPath: '/pins',
    entriesVault: '/pins',
    status: 'ready',
    entries: [mkEntry({ path: 'old.md', title: 'Old' })],
    collections: [],
    views: [],
  });
  useUiStore.setState({ favorites: { '/pins': ['old.md'] }, pendingRenames: {} });
  render(<Sidebar />);
  let finish!: () => void;
  act(() => {
    finish = beginPointerRename('/pins');
  });
  act(() => useVaultStore.setState({ entries: [mkEntry({ path: 'new.md', title: 'New' })] }));
  expect(useUiStore.getState().favorites['/pins']).toEqual(['old.md']);
  act(() => {
    followRename('/pins', 'old.md', 'new.md');
    finish();
  });
  expect(useUiStore.getState().favorites['/pins']).toEqual(['new.md']);
  cleanup();
});
