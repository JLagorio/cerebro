import { useMemo, useRef, useState } from 'react';
import { useEntryScroll, useEntryState } from '@/app/useEntryState';
import { useOpenPath } from '@/app/useOpenPath';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { MenuItem, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { Select } from '@/components/ui/Select';
import { StateMessage } from '@/components/ui/StateMessage';
import { isBrowserPage } from '@/engine/pageBrowser';
import { typeStyle } from '@/engine/typeCatalog';
import { useLauncherStore } from '@/stores/launcherStore';
import { useOpenLogStore } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import './pagesBrowser.css';

type Shelf = 'all' | 'recent' | 'favorites';
interface BrowserState {
  shelf: Shelf;
  display: 'list' | 'grid';
  sort: 'modified' | 'title';
}
const DEFAULT_BROWSER: BrowserState = { shelf: 'all', display: 'list', sort: 'modified' };
const SORTS = [
  { value: 'modified', label: 'Last edited' },
  { value: 'title', label: 'Name' },
];
const EMPTY_PATHS: string[] = [];

function editedLabel(value: string): string {
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) return 'Not recorded';
  const date = new Date(stamp);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
}

export function PagesPage() {
  const entries = useVaultStore((s) => s.entries);
  const vault = useVaultStore((s) => s.vaultPath);
  const entriesVault = useVaultStore((s) => s.entriesVault);
  const status = useVaultStore((s) => s.status);
  const error = useVaultStore((s) => s.error);
  const rescan = useVaultStore((s) => s.rescan);
  const favorites = useUiStore((s) =>
    vault === null ? EMPTY_PATHS : (s.favorites[vault] ?? EMPTY_PATHS),
  );
  const toggleFavorite = useUiStore((s) => s.toggleFavorite);
  const log = useOpenLogStore((s) => (vault === null ? undefined : s.logs[vault]));
  const schema = useSchema();
  const openPath = useOpenPath('navigate', { fullPage: true });
  const startCreate = useLauncherStore((s) => s.startCreate);
  const [browser, setBrowser] = useEntryState('pages.browser', DEFAULT_BROWSER);
  const [search, setSearch] = useEntryState('view.search', '');
  const newButton = useRef<HTMLButtonElement>(null);
  const [newAnchor, setNewAnchor] = useState<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEntryScroll(scrollRef, 'canvas.scroll');
  const pages = useMemo(() => entries.filter(isBrowserPage), [entries]);
  const pinned = useMemo(() => new Set(favorites), [favorites]);
  const recent = useMemo(() => new Map(log?.map((row, i) => [row.path, i]) ?? []), [log]);
  const shown = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return pages
      .filter((entry) => {
        if (browser.shelf === 'favorites' && !pinned.has(entry.path)) return false;
        if (browser.shelf === 'recent' && !recent.has(entry.path)) return false;
        return (
          query === '' ||
          `${entry.title} ${entry.folder} ${entry.type ?? ''}`.toLocaleLowerCase().includes(query)
        );
      })
      .sort((a, b) => {
        if (browser.shelf === 'recent')
          return (recent.get(a.path) ?? Infinity) - (recent.get(b.path) ?? Infinity);
        if (browser.sort === 'title') return a.title.localeCompare(b.title);
        return (
          (Date.parse(b.modifiedAt) || 0) - (Date.parse(a.modifiedAt) || 0) ||
          a.title.localeCompare(b.title)
        );
      });
  }, [pages, browser, pinned, recent, search]);
  const ready = status === 'ready' && entriesVault === vault;

  return (
    <section
      className="cb-pages-browser cb-composition"
      data-testid="pages-browser"
      data-section="pages-browser"
      aria-label="Pages"
    >
      <PageHeader
        className="cb-pages-browser-header"
        title="Pages"
        composition="collection"
        actions={
          <div className="cb-pages-browser-actions">
            <label className="cb-pages-search">
              <Icon name="search" size={16} />
              <input
                aria-label="Search pages"
                placeholder="Search pages"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search !== '' && (
                <button
                  type="button"
                  tabIndex={0}
                  aria-label="Clear page search"
                  onClick={() => setSearch('')}
                >
                  <Icon name="x" size={14} />
                </button>
              )}
            </label>
            <button
              ref={newButton}
              type="button"
              tabIndex={0}
              disabled={!ready}
              className="cb-pages-new"
              aria-haspopup="menu"
              aria-expanded={newAnchor !== null}
              onClick={(event) => {
                event.currentTarget.focus();
                setNewAnchor(newAnchor === null ? event.currentTarget : null);
              }}
            >
              New <Icon name="chevron-down" size={15} />
            </button>
            {newAnchor !== null && (
              <Popover anchorRef={newButton} onClose={() => setNewAnchor(null)}>
                <MenuSurface width={224}>
                  {(
                    [
                      ['page', 'Page', 'file-text'],
                      ['whiteboard', 'Whiteboard', 'shapes'],
                      ['database', 'Database', 'table-2'],
                      ['collection', 'Collection', 'folder'],
                      ['sheet', 'Sheet', 'sheet'],
                      ['template', 'Template', 'layout-template'],
                    ] as const
                  ).map(([id, label, icon]) => (
                    <MenuItem
                      key={id}
                      label={label}
                      icon={icon}
                      onSelect={() => {
                        setNewAnchor(null);
                        startCreate(id);
                      }}
                    />
                  ))}
                </MenuSurface>
              </Popover>
            )}
          </div>
        }
      />

      <div className="cb-composition-content cb-pages-browser-content">
        <div className="cb-pages-browser-controls">
          <div className="cb-pages-shelves" role="group" aria-label="Page collections">
            {(
              [
                ['all', 'All pages'],
                ['recent', 'Recently opened'],
                ['favorites', 'Favorites'],
              ] as const
            ).map(([shelf, label]) => (
              <button
                key={shelf}
                type="button"
                tabIndex={0}
                aria-pressed={browser.shelf === shelf}
                onClick={() => setBrowser({ ...browser, shelf })}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="cb-pages-display">
            {browser.shelf !== 'recent' && (
              <Select
                ariaLabel="Sort pages"
                variant="ghost"
                size="sm"
                value={browser.sort}
                options={SORTS}
                onChange={(sort) =>
                  setBrowser({ ...browser, sort: sort === 'title' ? 'title' : 'modified' })
                }
              />
            )}
            <span className="cb-pages-display-divider" />
            {(['grid', 'list'] as const).map((display) => (
              <button
                key={display}
                type="button"
                tabIndex={0}
                aria-label={`${display === 'grid' ? 'Grid' : 'List'} view`}
                aria-pressed={browser.display === display}
                onClick={() => setBrowser({ ...browser, display })}
              >
                <Icon name={display === 'grid' ? 'layout-grid' : 'list'} size={17} />
              </button>
            ))}
          </div>
        </div>

        {status === 'error' ? (
          <StateMessage
            state="unavailable"
            title="Pages couldn’t be loaded"
            action={
              <Button size="sm" onClick={() => void rescan()}>
                Try again
              </Button>
            }
          >
            {error}
          </StateMessage>
        ) : !ready ? (
          <StateMessage state="loading" title="Loading pages…" />
        ) : shown.length === 0 ? (
          <StateMessage
            state="empty"
            title={
              search.trim() !== ''
                ? 'No matching pages'
                : browser.shelf === 'favorites'
                  ? 'Your favorite pages, close at hand'
                  : browser.shelf === 'recent'
                    ? 'Pick up where you left off'
                    : 'A place for your ideas'
            }
            action={
              browser.shelf === 'all' && search.trim() === '' ? (
                <Button onClick={() => startCreate('page')}>New page</Button>
              ) : undefined
            }
          >
            {search.trim() !== ''
              ? 'Try a different name or folder.'
              : browser.shelf === 'favorites'
                ? 'Star a page to keep it here.'
                : browser.shelf === 'recent'
                  ? 'Pages you open will appear here.'
                  : 'Create your first page to start writing.'}
          </StateMessage>
        ) : (
          <div ref={scrollRef} className="cb-pages-browser-scroll">
            {browser.display === 'list' && (
              <div className="cb-pages-columns" aria-hidden="true">
                <span>Name</span>
                <span>Location</span>
                <span>Last edited</span>
                <span />
              </div>
            )}
            <div
              className={`cb-pages-items cb-pages-items--${browser.display}`}
              role="list"
              aria-label="Pages"
            >
              {shown.map((entry) => {
                const icon = typeStyle(entry.type, schema).icon;
                return (
                  <article
                    key={entry.path}
                    role="listitem"
                    className="cb-pages-item"
                    data-testid="page-browser-item"
                  >
                    <button
                      type="button"
                      tabIndex={0}
                      className="cb-pages-open"
                      aria-label={`Open ${entry.title}`}
                      onClick={() => openPath(entry.path)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && event.shiftKey) {
                          event.preventDefault();
                          event.stopPropagation();
                          openPath(entry.path, { newPane: true });
                        }
                      }}
                    >
                      <span className="cb-pages-name">
                        <span className="cb-pages-file-icon">
                          <Icon name={icon} size={browser.display === 'list' ? 16 : 19} />
                        </span>
                        <span className="cb-pages-title">{entry.title}</span>
                      </span>
                      {browser.display === 'grid' && (
                        <span className="cb-pages-excerpt">
                          {entry.parseError !== null
                            ? 'Page has a reading error. Open for details.'
                            : entry.snippet || 'No preview text.'}
                        </span>
                      )}
                      <span className="cb-pages-location" title={entry.folder || 'Workspace'}>
                        {entry.folder || 'Workspace'}
                      </span>
                      <span className="cb-pages-edited" title={entry.modifiedAt || 'Not recorded'}>
                        {editedLabel(entry.modifiedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      tabIndex={0}
                      className="cb-pages-star"
                      aria-label={`${pinned.has(entry.path) ? 'Remove' : 'Add'} ${entry.title} ${pinned.has(entry.path) ? 'from' : 'to'} favorites`}
                      aria-pressed={pinned.has(entry.path)}
                      onClick={() => vault !== null && toggleFavorite(vault, entry.path)}
                    >
                      <Icon name="star" size={16} />
                    </button>
                  </article>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
