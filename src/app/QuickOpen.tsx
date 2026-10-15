import { useCallback, useEffect, useMemo, useState } from 'react';
import { useContentSearch } from '@/app/useContentSearch';
import { useOpenPath } from '@/app/useOpenPath';
import { Dialog } from '@/components/ui/Dialog';
import { PageIconGlyph } from '@/components/PageIcon';
import { Input } from '@/components/ui/Input';
import { UNTYPED_LABEL, visibleDestinations } from '@/engine/destinations';
import { libraryIcon, libraryKind, libraryLabel } from '@/engine/library';
import { pageIconOf, type PageIcon } from '@/engine/pageChrome';
import { listTypes, typeStyle } from '@/engine/typeCatalog';
import type { VaultHit } from '@/lib/ipc';
import { rankNames } from '@/lib/nameRank';
import { askAssistantLabel } from '@/lib/prompts';
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
 * findable here now, under one ranking.
 */
interface Target {
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
  group: 'recent' | 'go' | 'match' | 'pages' | 'all';
  /** A page-text hit (M59.4), drawn with its excerpt. */
  hit?: VaultHit;
}

export function QuickOpen() {
  const visible = useUiStore((s) => s.quickOpenVisible);
  const setQuickOpen = useUiStore((s) => s.setQuickOpen);
  const askAgent = useUiStore((s) => s.askAgent);
  const inboxEnabled = useUiStore((s) => s.inboxEnabled);
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const schema = useSchema();
  const navigate = useNavStore((s) => s.navigate);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const openLog = useOpenLogStore((s) => (vaultPath === null ? undefined : s.logs[vaultPath]));
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  // The query the highlight was last reset for (M59.4): it resets when the
  // query changes, never when rows arrive.
  const [highlightedFor, setHighlightedFor] = useState(query);
  // The query "All N matches" was chosen for: the expansion lasts until the
  // query changes.
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  // Page text under the names (M59.4), once typing pauses.
  const content = useContentSearch(vaultPath, query, visible);
  // The moment the palette opened: one clock for the whole visit, so the
  // order does not shift under the keyboard while you type.
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  const recency = useRecency(openedAt);

  // useCallback because `close` sits in the results memo's deps (M42.5).
  const close = useCallback(() => setQuickOpen(false), [setQuickOpen]);
  const go = (selection: Selection) => {
    close();
    navigate(selection);
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
      // M29.21: a .mmd entry is a standalone diagram — the generic page glyph
      // and "Page" would hide the one thing worth knowing about it here.
      const diagram = e.path.endsWith('.mmd');
      return {
        id: `note:${e.path}`,
        label: e.title,
        icon: diagram ? 'waypoints' : kind === null ? style.icon : libraryIcon(kind),
        color: kind === null ? style.color : 'var(--synapse-500)',
        pageIcon: diagram ? null : pageIconOf(e),
        hint: key,
        meta: '',
        kindLabel: diagram
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

  const results = useMemo<Row[]>(() => {
    const q = query.trim();
    if (q === '') {
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
    // panel, which is the one chat there is.
    const ask: Row = {
      key: 'ask:assistant',
      group: 'match',
      target: {
        id: 'ask:assistant',
        label: askAssistantLabel(q),
        icon: 'sparkles',
        color: 'var(--synapse-500)',
        hint: '',
        meta: '',
        kindLabel: 'Ask',
        alias: '',
        run: () => {
          close();
          askAgent(q);
        },
      },
    };
    // One ranker for every name picker (M59.3): the match tier first, then
    // your own recent opens within it.
    const matches = rankNames({
      query: q,
      items: targets,
      texts: (t) => [t.label, t.alias],
      path: (t) => t.path,
      recency,
      limit: MAX_MATCHES,
    }).items;
    const names: Row[] = [
      ask,
      ...matches.map((target) => ({ key: target.id, target, group: 'match' as const })),
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
        label: hit.title,
        icon: 'file-text',
        color: null,
        hint: '',
        meta: hit.path,
        kindLabel: 'In pages',
        alias: '',
        path: hit.path,
        run: () => {
          close();
          openPath(hit.path);
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
  }, [targets, places, recent, recency, query, askAgent, close, content, expandedFor]);

  // The highlight resets when the query changes, and only then (M59.4): set
  // here during render, so rows that arrive later (the page text) never move
  // a highlight the person set. The ask row is pinned, not preferred: with
  // matches on screen the default highlight is the best MATCH, so Enter keeps
  // meaning "open the thing I named" and asking is one ↑ away. With nothing
  // else to offer, the ask row takes the highlight — Enter on a query nothing
  // matches is exactly the moment to hand the words to the assistant.
  if (highlightedFor !== query) {
    setHighlightedFor(query);
    setActiveIndex(query.trim() === '' ? 0 : Math.min(1, results.length - 1));
  }
  // Rows can shrink under the highlight; it clamps to the last one.
  const active = Math.min(activeIndex, Math.max(results.length - 1, 0));

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setActiveIndex(0);
      return;
    }
    setOpenedAt(Date.now());
    // A deleted page leaves the log here, and only on a ready snapshot of
    // this vault: FileTree's moves rescan before they remap, so pruning on
    // every scan would drop the history the remap still needs.
    pruneOpenLogToSnapshot();
  }, [visible]);

  if (!visible) return null;

  return (
    <Dialog
      open
      onClose={close}
      title="Quick open"
      width={580}
      footerNote="↑↓ navigate · ↵ open · esc close"
    >
      <Input
        autoFocus
        testId="quick-open-input"
        icon="search"
        placeholder="Search pages, databases, and places…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex(Math.min(active + 1, Math.max(results.length - 1, 0)));
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex(Math.max(active - 1, 0));
          }
          if (e.key === 'Enter' && results[active]) results[active].target.run();
          if (e.key === 'Escape') {
            // stopPropagation, or this closes TWO layers (M29.53). React
            // flushes a discrete-event state update synchronously, so this
            // Dialog unmounts and pops its layer BEFORE the same native
            // keydown reaches the document-level listeners — by which point
            // `ownsEscape` answers true for whatever was underneath, and a
            // full-screen diagram editor closed along with the palette that
            // was covering it. MEASURED 3/3 runs: scrims 2 -> 0 on one press,
            // while dismissing with the mouse correctly left one standing.
            e.stopPropagation();
            close();
          }
        }}
        width="100%"
      />
      <div
        role="listbox"
        aria-label="Quick open results"
        className="mt-1.5 max-h-[380px] overflow-y-auto"
      >
        {query.trim() === ''
          ? (['recent', 'go'] as const).map((group) => {
              const rows = results.flatMap((r, i) => (r.group === group ? [{ r, i }] : []));
              if (rows.length === 0) return null;
              const label = group === 'recent' ? 'Recent' : 'Go to';
              return (
                <div key={group} role="group" aria-label={label} data-section={group}>
                  <div
                    aria-hidden
                    className="mt-1 px-2.5 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-[var(--track-caps)] text-[var(--text-meta)]"
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
        {content.status === 'unavailable' && (
          // A failed read is never "no matches" (CV-05): the names above
          // were found, and the page text was not searched.
          <p data-testid="section-unavailable" className="m-0 px-2.5 py-2 text-2xs text-n-500">
            Page text couldn't be searched. Names above are complete.
          </p>
        )}
        {ready !== null && pages.length > 0 && (
          <div role="group" aria-label="In pages" data-section="pages">
            <div
              aria-hidden
              className="mt-1 px-2.5 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-[var(--track-caps)] text-[var(--text-meta)]"
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
        aria-selected={i === active}
        onClick={() => r.target.run()}
        onMouseEnter={() => setActiveIndex(i)}
        className="flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left"
        style={{ background: i === active ? 'var(--n-50)' : 'transparent' }}
      >
        <span className="flex w-full min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-none truncate text-sm text-n-900">{hit.title}</span>
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

  function renderRow(r: Row, i: number) {
    return (
      <button
        key={r.key}
        type="button"
        // The ask row is an OFFER, not a result: it repeats whatever was
        // typed, so a spec (or anything else) picking "the result whose
        // text is X" must never land on it. Nor is "All N matches" (M59.4).
        data-testid={
          r.target.id === 'ask:assistant'
            ? 'quick-open-ask'
            : r.group === 'all'
              ? 'quick-open-all-matches'
              : 'quick-open-result'
        }
        role="option"
        aria-selected={i === active}
        onClick={() => r.target.run()}
        onMouseEnter={() => setActiveIndex(i)}
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
        <span className="min-w-0 flex-1 truncate text-sm text-n-900">{r.target.label}</span>
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
        {/* Fixed column so the category aligns down the whole list. */}
        <span className="w-[84px] flex-none truncate text-right text-2xs text-[var(--text-meta)]">
          {r.target.kindLabel}
        </span>
      </button>
    );
  }
}
