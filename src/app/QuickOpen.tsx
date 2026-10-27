import { flushSync } from 'react-dom';
import { useSourceNavigation, sourceVisitOrigin } from './sourceOpen';
import { kindFor } from '@/engine/fileKinds';
import { openBesideIntent, withOpenBesideIntent } from '@/app/openIntent';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useContentSearch } from '@/app/useContentSearch';
import { useOpenPath } from '@/app/useOpenPath';
import { quickOpenAsk, sendAsk, type Ask } from '@/agent/elements/decisionsAsks';
import { Suggestion } from '@/components/ai/Suggestion';
import { Dialog } from '@/components/ui/Dialog';
import { PageIconGlyph } from '@/components/PageIcon';
import { Keycaps } from '@/components/ui/Keycaps';
import { activeChain } from '@/lib/keys/root';
import { availableCommands, runCommand } from '@/lib/keys/registry';
import { previewTheme } from '@/hooks/useTheme';
import {
  CATEGORIES,
  cycle,
  defaultActive,
  filterRows,
  type Category,
  type Level,
  type RowCategory,
} from './palette/model';
import { commandRows } from './palette/commandRows';
import { chooserRows, CHOOSER_TITLES } from './palette/choosers';
import { Input } from '@/components/ui/Input';
import { UNTYPED_LABEL, visibleDestinations } from '@/engine/destinations';
import { libraryIcon, libraryKind, libraryLabel } from '@/engine/library';
import { pageIconOf, type PageIcon } from '@/engine/pageChrome';
import { listTypes, typeStyle } from '@/engine/typeCatalog';
import type { VaultHit } from '@/lib/ipc';
import { rankNames } from '@/lib/nameRank';
import { useNavStore } from '@/stores/navStore';
import { pruneOpenLogToSnapshot, useOpenLogStore, useRecency } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import type { Entry, Selection } from '@/engine/types';

/**
 * One result, whatever kind of thing it points at (M9.6).
 *
 * QuickOpen found notes and nothing else, so reaching a list or a type
 * screen meant leaving the keyboard for the sidebar. Everything navigable is
 * findable here now, alongside live commands and nested choosers.
 */
interface Target {
  category: RowCategory;
  command?: string;
  mode?: import('@/stores/uiStore').ThemeMode;
  id: string;
  label: string;
  icon: string;
  color: string | null;
  /** A page's own icon (M55.11), drawn in place of `icon` when set; `icon`
   *  and `color` are then only its fallback. */
  pageIcon?: PageIcon | null;
  /**
   * The record's own identifier, rendered as a mono chip. Only records have
   * one — it used to double as "a count" and "a folder name", which put three
   * unrelated things in one slot styled identically to the kind label.
   */
  hint: string;
  /** Plain-language qualifier: where it lives, or how big it is. */
  meta: string;
  kindLabel: string;
  /** Text the query is matched against, beyond the label. */
  alias: string;
  /** The page it opens, for the open log's ranking (M59.3); notes only. */
  path?: string;
  run: () => void;
}

/** How many logged pages the empty palette lists under Recent (M59.3). */
const RECENT_ROWS = 8;
const MAX_MATCHES = 12;
/** How many page-text hits show under In pages before "All N matches". */
const CONTENT_ROWS = 5;

/** A row, and the group it is drawn under: Recent and Go to on an empty
 * query; the names, then In pages (its hits, and the row that expands them)
 * on a typed one. */
interface Row {
  key: string;
  target: Target;
  group: 'recent' | 'go' | 'match' | 'commands' | 'pages' | 'all';
  /** A page-text hit (M59.4), drawn with its excerpt. */
  hit?: VaultHit;
  /** The ask row's Ask (M91.14), drawn as a Suggestion. */
  ask?: Ask;
}

export function QuickOpen() {
  const visible = useUiStore((s) => s.quickOpenVisible);
  return visible ? <QuickOpenBody /> : null;
}

function QuickOpenBody() {
  const [resume] = useState(() => useNavStore.getState().quickOpenResume);
  useEffect(() => {
    useNavStore.setState({ quickOpenResume: null });
  }, []);
  const { openSource } = useSourceNavigation();
  const listRef = useRef<HTMLDivElement>(null);
  const resumeRow = useRef(resume?.activeRowKey ?? null);

  // Capture the live page scope before autofocus and the modal layer mount.
  const [snapshot] = useState(() => {
    const chain = activeChain();
    return { chain, commands: availableCommands(chain) };
  });
  const listId = useId();
  const [category, setCategory] = useState<Category>(resume?.category ?? 'all');
  const [level, setLevel] = useState<Level>(resume?.level ?? { kind: 'root' });
  const moved = useRef(false);
  const setQuickOpen = useUiStore((s) => s.setQuickOpen);
  const askAgent = useUiStore((s) => s.askAgent);
  const inboxEnabled = useUiStore((s) => s.inboxEnabled);
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const schema = useSchema();
  const navigate = useNavStore((s) => s.navigate);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const openLog = useOpenLogStore((s) => (vaultPath === null ? undefined : s.logs[vaultPath]));
  const [query, setQuery] = useState(resume?.query ?? '');
  const [activeIndex, setActiveIndex] = useState(0);
  // The query the highlight was last reset for (M59.4): it resets when the
  // query changes, never when rows arrive.
  const highlightKey = `${level.kind}:${category}:${query}`;
  const [highlightedFor, setHighlightedFor] = useState(highlightKey);
  // The query "All N matches" was chosen for: the expansion lasts until the
  // query changes.
  const [expandedFor, setExpandedFor] = useState<string | null>(resume?.expandedFor ?? null);
  // Page text under the names (M59.4), once typing pauses.
  const content = useContentSearch(
    vaultPath,
    query,
    level.kind === 'root' && (category === 'all' || category === 'pages'),
  );
  // The moment the palette opened: one clock for the whole visit, so the
  // order does not shift under the keyboard while you type.
  const [openedAt] = useState(() => Date.now());
  const favorites = useUiStore((s) => s.favorites);
  const recency = useRecency(openedAt);

  // useCallback because `close` sits in the results memo's deps (M42.5).
  const close = useCallback(() => {
    previewTheme(null);
    setQuickOpen(false);
  }, [setQuickOpen]);
  const go = (selection: Selection) => {
    close();
    if (openBesideIntent()) useNavStore.getState().openPane(selection);
    else navigate(selection);
  };

  // One routing rule for the whole app (M12.1): records panel over a backdrop,
  // docs open full-page. QuickOpen keeps the navigate mode deliberately: there
  // may be no relevant canvas behind it (M9.3).
  const openPath = useOpenPath();
  const openEntry = (entry: Entry) => {
    close();
    openPath(entry.path);
  };

  const targets = useMemo<Target[]>(() => {
    const noteTargets: Target[] = entries.map((e) => {
      const style = typeStyle(e.type, schema);
      const key = typeof e.properties.key === 'string' ? e.properties.key : '';
      // M18: a library entry has no Type doc to take an icon from any more, so
      // it would fall back to the generic page glyph and read as an ordinary
      // note in the one list where telling them apart matters most.
      const kind = libraryKind(e);
      const fileKind = kindFor(e.path);
      const diagram = fileKind.kind === 'diagram';
      const board = fileKind.kind === 'whiteboard';
      return {
        id: `note:${e.path}`,
        category: 'pages',
        label: e.title,
        icon: board
          ? fileKind.icon
          : diagram
            ? 'waypoints'
            : kind === null
              ? style.icon
              : libraryIcon(kind),
        color: kind === null ? style.color : 'var(--synapse-500)',
        pageIcon: diagram || board ? null : pageIconOf(e),
        hint: key,
        meta: '',
        kindLabel: board
          ? 'Whiteboard'
          : diagram
            ? 'Diagram'
            : kind === null
              ? (e.type ?? UNTYPED_LABEL)
              : libraryLabel(kind),
        alias: key,
        path: e.path,
        run: () => openEntry(e),
      };
    });

    const viewTargets: Target[] = views.map((v) => ({
      // Ids are unique per folder, so the collection is part of the target's
      // identity AND of where it navigates — otherwise two collections'
      // "roadmap" lists collapse into one entry that opens the wrong one.
      id: `list:${v.collection ?? ''}:${v.id}`,
      category: 'databases',
      label: v.definition.name,
      icon: v.definition.icon ?? 'layout-list',
      color: v.definition.color,
      hint: '',
      meta: v.collection ?? '',
      kindLabel: 'List',
      alias: v.id,
      run: () => go({ kind: 'list', id: v.id, collection: v.collection }),
    }));

    const typeTargets: Target[] = listTypes(entries, schema).map((t) => ({
      id: `type:${t.name}`,
      category: 'databases',
      label: t.name,
      icon: t.icon,
      color: t.color,
      hint: '',
      meta: `${t.count} ${t.count === 1 ? 'record' : 'records'}`,
      // The label a type wears everywhere a person reads it (M39).
      kindLabel: 'Database',
      alias: '',
      run: () => go({ kind: 'type', name: t.name }),
    }));

    // The places, from engine/destinations.ts (M59.1): the same rows, words
    // and order the nav has, Inbox only with its workflow. Pages are reached
    // by name here, and by their text under In pages (M59.4).
    const surfaces: Target[] = visibleDestinations({ inboxEnabled }).map((d) => ({
      id: `go:${d.id}`,
      category: 'places',
      command: `go.${d.id}`,
      label: d.label,
      icon: d.icon,
      color: null,
      hint: '',
      meta: '',
      kindLabel: 'Go to',
      alias: d.aliases,
      run: () => go(d.selection),
    }));

    return [...noteTargets, ...viewTargets, ...typeTargets, ...surfaces];
    // `go`/`openEntry` are navigation closures reborn each render; depending
    // on them would rebuild every target per keystroke for the same behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, views, schema, inboxEnabled]);

  // An empty query lists Recent — your own last opens that still exist, in
  // log order — then the places in table order (M59.3), so ↑↓/↵ work on open
  // and Enter goes back to the page you were just on.
  const places = useMemo(() => targets.filter((t) => t.kindLabel === 'Go to'), [targets]);
  const recent = useMemo(() => {
    const byPath = new Map(targets.filter((t) => t.path !== undefined).map((t) => [t.path, t]));
    const rows: Target[] = [];
    for (const record of openLog ?? []) {
      const target = byPath.get(record.path);
      if (target !== undefined) rows.push(target);
      if (rows.length === RECENT_ROWS) break;
    }
    return rows;
  }, [targets, openLog]);

  const rootResults = useMemo<Row[]>(() => {
    const commands: Row[] = commandRows(snapshot.commands, query, category).map((row) => ({
      key: row.id,
      group: 'commands',
      target: {
        id: row.id,
        category: 'commands',
        label: row.label,
        command: row.command,
        icon:
          row.chooser === 'theme'
            ? 'sun'
            : row.chooser === 'favorites'
              ? 'star'
              : row.chooser === 'agents'
                ? 'zap'
                : 'command',
        color: null,
        hint: '',
        meta: '',
        kindLabel: row.chooser ? 'Choose' : 'Command',
        alias: '',
        run: () => {
          if (row.chooser) {
            setLevel({ kind: row.chooser, query, active: activeIndex, category });
            setQuery('');
          } else if (row.command) {
            close();
            queueMicrotask(() => runCommand(row.command!, snapshot.chain));
          }
        },
      },
    }));
    const q = query.trim();
    if (q === '') {
      if (category === 'commands') return commands;
      if (category === 'databases')
        return targets
          .filter((target) => target.category === 'databases')
          .map((target) => ({ key: target.id, target, group: 'match' as const }));
      return [
        ...recent.map((target) => ({
          key: `recent:${target.id}`,
          target,
          group: 'recent' as const,
        })),
        ...places.map((target) => ({ key: target.id, target, group: 'go' as const })),
      ];
    }
    // The DS ask-bar contract (M42.5): one synapse-tinted "ask" row at the
    // top — a row, not a mode. It hands the typed words to the assistant
    // panel, which is the one chat there is: a Suggestion (M91.14) whose
    // label says where the words go and whose prompt is the words.
    const said = quickOpenAsk(q);
    const ask: Row = {
      key: 'ask:assistant',
      group: 'match',
      ask: said,
      target: {
        id: 'ask:assistant',
        category: 'ask',
        label: said.label,
        icon: 'sparkles',
        color: 'var(--synapse-500)',
        hint: '',
        meta: '',
        kindLabel: 'Ask',
        alias: '',
        run: () => {
          close();
          sendAsk(said, askAgent)(said.prompt);
        },
      },
    };
    // One ranker for every name picker (M59.3): the match tier first, then
    // your own recent opens within it.
    const matches = rankNames({
      query: q,
      items: targets.filter((target) => category === 'all' || target.category === category),
      texts: (t) => [t.label, t.alias],
      path: (t) => t.path,
      recency,
      limit: MAX_MATCHES,
    }).items;
    const names: Row[] = [
      ask,
      ...matches.map((target) => ({ key: target.id, target, group: 'match' as const })),
      ...commands,
    ];
    // In pages (M59.4): page text below the names, from the content search.
    // Five hits, then "All N matches", which expands in place to every hit
    // returned (Q7: there is no search page to hand off to).
    if (content.status !== 'ready') return names;
    const { hits, total, capped } = content.result;
    const expanded = expandedFor === query;
    const shown = expanded ? hits : hits.slice(0, CONTENT_ROWS);
    const pages: Row[] = shown.map((hit) => ({
      key: `page:${hit.path}`,
      group: 'pages',
      hit,
      target: {
        id: `page:${hit.path}`,
        category: 'pages',
        label: hit.title,
        icon: 'file-text',
        color: null,
        hint: '',
        meta: hit.path,
        kindLabel: 'In pages',
        alias: '',
        path: hit.path,
        run: () => {
          if (hit.location) {
            const origin = {
              ...sourceVisitOrigin(hit.location.vaultId),
              kind: 'QuickOpen' as const,
              snapshot: {
                query,
                category,
                level,
                expandedFor,
                activeRowKey: `page:${hit.path}`,
                scrollTop: listRef.current?.scrollTop ?? 0,
              },
            };
            // Finish Dialog's existing opener restoration before the source
            // request captures focus ownership. Later focus moves cancel it.
            const intent = openBesideIntent() ? 'beside' : 'default';
            flushSync(close);
            void openSource({
              requestId: crypto.randomUUID(),
              locator: hit.location,
              origin,
              intent,
            });
          } else {
            close();
            openPath(hit.path);
            useUiStore
              .getState()
              .toast('Source context opened. This result has no supported passage location.');
          }
        },
      },
    }));
    if (!expanded && total > shown.length) {
      const part = capped > 0 ? ` · ${capped} long pages searched in part` : '';
      pages.push({
        key: 'all-matches',
        group: 'all',
        target: {
          id: 'all-matches',
          category: 'pages',
          label: `All ${total} matches${part}`,
          icon: 'list',
          color: null,
          hint: '',
          meta: '',
          kindLabel: '',
          alias: '',
          run: () => setExpandedFor(query),
        },
      });
    }
    return [...names, ...pages];
    // `openPath` is a navigation closure reborn each render, as `go` is above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    targets,
    places,
    recent,
    recency,
    query,
    askAgent,
    close,
    content,
    expandedFor,
    category,
    snapshot,
    activeIndex,
  ]);

  const results: Row[] =
    level.kind === 'root'
      ? filterRows(
          rootResults.map((row) => ({ ...row, category: row.target.category })),
          category,
        )
      : chooserRows(level.kind, entries, favorites[vaultPath ?? ''] ?? [], query).map((choice) => ({
          key: choice.id,
          group: 'match',
          target: {
            id: choice.id,
            category: 'commands',
            label: choice.label,
            mode: choice.mode,
            icon: choice.mode ? 'sun' : level.kind === 'agents' ? 'zap' : 'star',
            color: null,
            hint: '',
            meta: choice.hint,
            alias: '',
            kindLabel: '',
            run: () => {
              if (choice.mode) useUiStore.getState().setThemeMode(choice.mode);
              close();
              if (choice.path) openPath(choice.path);
            },
          },
        }));
  // Ask is pinned, not preferred. A late first match may take an untouched
  // empty highlight; a highlight the person moved never moves on arrival.
  const preferred = defaultActive(results.map((row) => ({ category: row.target.category })));
  if (highlightedFor !== highlightKey) {
    setHighlightedFor(highlightKey);
    moved.current = false;
    setActiveIndex(preferred);
  } else if (activeIndex === -1 && !moved.current && preferred >= 0) {
    setActiveIndex(preferred);
  }
  const resumedIndex =
    resumeRow.current === null ? -1 : results.findIndex((row) => row.key === resumeRow.current);
  const active = resumedIndex >= 0 ? resumedIndex : Math.min(activeIndex, results.length - 1);
  useEffect(() => {
    if (!resume || query !== resume.query || content.status === 'pending') return;
    if (listRef.current) listRef.current.scrollTop = resume.scrollTop;
  }, [resume, query, content.status]);
  // Rows can move under a stationary cursor as the query changes. Only an
  // actual mouse move changes the keyboard highlight; enter alone does not.
  const mark = (index: number) => {
    resumeRow.current = null;
    moved.current = true;
    setActiveIndex(index);
  };
  const back = () => {
    if (level.kind === 'root') {
      close();
      return;
    }
    previewTheme(null);
    setQuery(level.query);
    setCategory(level.category);
    setActiveIndex(level.active);
    setHighlightedFor(`root:${level.category}:${level.query}`);
    moved.current = true;
    setLevel({ kind: 'root' });
  };
  const preview = level.kind === 'theme' ? results[active]?.target.mode : undefined;
  useEffect(() => {
    previewTheme(preview ?? null);
  }, [preview]);
  useEffect(() => () => previewTheme(null), []);
  useEffect(() => {
    pruneOpenLogToSnapshot();
  }, []);

  return (
    <Dialog
      open
      onClose={close}
      title={level.kind === 'root' ? 'Quick open' : CHOOSER_TITLES[level.kind]}
      width={580}
      footerNote={
        <span className="inline-flex items-center gap-2">
          <Keycaps keys="arrowdown" /> Navigate · <Keycaps keys="enter" /> Open ·{' '}
          <Keycaps command="list.openBeside" /> Open beside ·{' '}
          <kbd className="font-mono text-xs">Esc</kbd> Close
        </span>
      }
    >
      <Input
        autoFocus
        role="combobox"
        ariaLabel={level.kind === 'root' ? 'Quick open' : CHOOSER_TITLES[level.kind]}
        ariaExpanded
        ariaAutocomplete="list"
        ariaControls={listId}
        ariaActivedescendant={active < 0 ? undefined : `${listId}-${active}`}
        testId="quick-open-input"
        icon="search"
        placeholder={
          level.kind === 'root'
            ? 'Search pages, databases, and places…'
            : `Search ${CHOOSER_TITLES[level.kind].toLowerCase()}…`
        }
        value={query}
        onChange={(e) => {
          resumeRow.current = null;
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            if (level.kind === 'root') setCategory(cycle(category, e.shiftKey));
          }
          if (e.key === 'Backspace' && query === '' && level.kind !== 'root') {
            e.preventDefault();
            back();
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            mark(Math.min(active + 1, results.length - 1));
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            mark(Math.max(active - 1, 0));
          }
          if (e.key === 'Enter' && results[active]) {
            e.preventDefault();
            const target = results[active].target;
            withOpenBesideIntent(e.shiftKey && target.category !== 'commands', () => target.run());
          }
          if (e.key === 'Escape') {
            // Step back from a chooser; stopPropagation avoids closing TWO layers (M29.53). React
            // flushes a discrete-event state update synchronously, so this
            // Dialog unmounts and pops its layer BEFORE the same native
            // keydown reaches the document-level listeners — by which point
            // `ownsEscape` answers true for whatever was underneath, and a
            // full-screen diagram editor closed along with the palette that
            // was covering it. MEASURED 3/3 runs: scrims 2 -> 0 on one press,
            // while dismissing with the mouse correctly left one standing.
            e.stopPropagation();
            back();
          }
        }}
        width="100%"
      />
      {level.kind === 'root' && (
        <div role="tablist" aria-label="Search category" className="mt-3 flex gap-1">
          {CATEGORIES.map((chip) => (
            <button
              key={chip.id}
              type="button"
              role="tab"
              tabIndex={-1}
              aria-selected={category === chip.id}
              data-testid={`palette-category-${chip.id}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setCategory(chip.id)}
              className={`rounded-sm px-2.5 py-1 text-xs ${category === chip.id ? 'bg-n-100 text-n-900' : 'text-(--text-meta)'}`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
      <div
        id={listId}
        ref={listRef}
        role="listbox"
        aria-label="Quick open results"
        className="mt-1.5 max-h-[380px] overflow-y-auto"
      >
        {query.trim() === '' &&
        level.kind === 'root' &&
        category !== 'databases' &&
        category !== 'commands'
          ? (['recent', 'go'] as const).map((group) => {
              const rows = results.flatMap((r, i) => (r.group === group ? [{ r, i }] : []));
              if (rows.length === 0) return null;
              const label = group === 'recent' ? 'Recent' : 'Go to';
              return (
                <div key={group} role="group" aria-label={label} data-section={group}>
                  <div
                    aria-hidden
                    className="mt-1 px-2.5 pb-1 pt-1.5 text-metadata font-medium text-[var(--text-meta)]"
                  >
                    {label}
                  </div>
                  {rows.map(({ r, i }) => renderRow(r, i))}
                </div>
              );
            })
          : renderTyped()}
      </div>
    </Dialog>
  );

  /** A typed query's rows: the names, then In pages (M59.4). */
  function renderTyped() {
    const pages = results.flatMap((r, i) =>
      r.group === 'pages' || r.group === 'all' ? [{ r, i }] : [],
    );
    const ready = content.status === 'ready' ? content.result : null;
    const unshown = ready === null ? 0 : ready.total - ready.hits.length;
    return (
      <>
        {results.map((r, i) => (r.group === 'match' ? renderRow(r, i) : null))}
        {results.some((row) => row.group === 'commands') && (
          <div role="group" aria-label="Commands" data-section="commands">
            <div
              aria-hidden
              className="mt-1 px-2.5 py-1.5 text-metadata font-medium text-[var(--text-meta)]"
            >
              Commands
            </div>
            {results.map((row, i) => (row.group === 'commands' ? renderRow(row, i) : null))}
          </div>
        )}
        {level.kind !== 'root' && results.length === 0 && (
          <p className="px-2.5 py-2 text-sm text-(--text-meta)">
            No {level.kind === 'theme' ? 'themes' : level.kind} match.
          </p>
        )}
        {level.kind === 'root' &&
          (category === 'all' || category === 'pages') &&
          content.status === 'unavailable' && (
            // A failed read is never "no matches" (CV-05): the names above
            // were found, and the page text was not searched.
            <p
              data-testid="section-unavailable"
              className="m-0 px-2.5 py-2 text-ui text-(--text-meta)"
            >
              Page text couldn't be searched. Names above are complete.
            </p>
          )}
        {ready !== null && pages.length > 0 && (
          <div role="group" aria-label="In pages" data-section="pages">
            <div
              aria-hidden
              className="mt-1 px-2.5 pb-1 pt-1.5 text-metadata font-medium text-[var(--text-meta)]"
            >
              {ready.widened ? 'In pages · closest matches' : 'In pages'}
            </div>
            {pages.map(({ r, i }) => (r.hit ? renderContentRow(r, r.hit, i) : renderRow(r, i)))}
            {expandedFor === query && unshown > 0 && (
              <p className="m-0 px-2.5 py-1.5 text-2xs text-[var(--text-meta)]">
                {unshown} more not shown — add a word to narrow it
              </p>
            )}
          </div>
        )}
      </>
    );
  }

  /** A page-text hit: its title and path, then its excerpt with the query
   * marked. Parts are drawn as text, never as HTML. */
  function renderContentRow(r: Row, hit: VaultHit, i: number) {
    return (
      <button
        key={r.key}
        type="button"
        data-testid="quick-open-content-result"
        role="option"
        id={`${listId}-${i}`}
        tabIndex={-1}
        aria-selected={i === active}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => r.target.run()}
        onMouseMove={() => mark(i)}
        className="flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left"
        style={{ background: i === active ? 'var(--n-50)' : 'transparent' }}
      >
        <span className="flex w-full min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-none truncate text-ui text-n-900">{hit.title}</span>
          <span className="min-w-0 flex-1 truncate text-2xs text-[var(--text-meta)]">
            {hit.path}
          </span>
        </span>
        {hit.parts.length > 0 && (
          <span className="line-clamp-2 w-full text-xs text-n-600">
            {hit.parts.map((part, k) =>
              part.mark ? (
                <mark key={k} className="rounded-xs bg-[var(--synapse-100)] text-[inherit]">
                  {part.text}
                </mark>
              ) : (
                <span key={k}>{part.text}</span>
              ),
            )}
          </span>
        )}
      </button>
    );
  }

  /** The ask row: a Suggestion that is one of the list's options, picked as
   *  any other — by Enter on the highlight, or a press — and drawn as a row. */
  function renderAskRow(r: Row, ask: Ask, i: number) {
    return (
      <Suggestion
        key={r.key}
        suggestion={ask.prompt}
        icon={null}
        // An OFFER, not a result: it repeats whatever was typed, so a spec
        // (or anything else) picking "the result whose text is X" must never
        // land on it.
        data-testid="quick-open-ask"
        role="option"
        id={`${listId}-${i}`}
        tabIndex={-1}
        aria-selected={i === active}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => r.target.run()}
        onMouseMove={() => mark(i)}
        // The suggestion's own row look gives way to the list's: its label
        // is the whole row, glyph, words and kind.
        className="h-9 rounded-md text-left [&>.cb-ai-suggestion-text]:flex-1 [&_.cb-ai-suggestion-label]:flex [&_.cb-ai-suggestion-label]:min-w-0 [&_.cb-ai-suggestion-label]:items-center [&_.cb-ai-suggestion-label]:gap-2.5"
        style={{ padding: '0 10px', background: i === active ? 'var(--n-50)' : 'transparent' }}
      >
        <span className="inline-flex flex-none" style={{ color: r.target.color ?? 'var(--n-500)' }}>
          <PageIconGlyph icon={null} fallback={{ name: r.target.icon }} size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui text-n-900">{ask.label}</span>
        <span className="w-[84px] flex-none truncate text-right text-2xs text-[var(--text-meta)]">
          {r.target.kindLabel}
        </span>
      </Suggestion>
    );
  }

  function renderRow(r: Row, i: number) {
    if (r.ask !== undefined) return renderAskRow(r, r.ask, i);
    return (
      <button
        key={r.key}
        type="button"
        // "All N matches" is no result either (M59.4): a spec picking "the
        // result whose text is X" must never land on it. The ask row draws
        // itself (renderAskRow).
        data-testid={
          r.group === 'all'
            ? 'quick-open-all-matches'
            : r.group === 'commands'
              ? 'quick-open-command'
              : 'quick-open-result'
        }
        role="option"
        id={`${listId}-${i}`}
        tabIndex={-1}
        aria-selected={i === active}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => r.target.run()}
        onMouseMove={() => mark(i)}
        className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left"
        style={{ background: i === active ? 'var(--n-50)' : 'transparent' }}
      >
        <span className="inline-flex flex-none" style={{ color: r.target.color ?? 'var(--n-500)' }}>
          <PageIconGlyph
            icon={r.target.pageIcon ?? null}
            fallback={{ name: r.target.icon }}
            size={14}
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui text-n-900">{r.target.label}</span>
        {/* The record's key: a mono chip, because it is an identifier you
                might have typed. Distinct from the kind label, which used to
                sit beside it in the identical style and read as one phrase. */}
        {r.target.hint !== '' && (
          <span className="flex-none rounded-xs bg-n-100 px-1 py-px [font-family:var(--font-mono)] text-2xs text-[var(--text-meta)]">
            {r.target.hint}
          </span>
        )}
        {r.target.meta !== '' && (
          <span className="max-w-[40%] flex-none truncate text-2xs text-[var(--text-meta)]">
            {r.target.meta}
          </span>
        )}
        {r.target.command && <Keycaps command={r.target.command} />}
        {/* Fixed column so the category aligns down the whole list. */}
        <span className="w-[84px] flex-none truncate text-right text-2xs text-[var(--text-meta)]">
          {r.target.kindLabel}
        </span>
      </button>
    );
  }
}
