import { useEffect, useMemo, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { listTypes, typeStyle } from '@/engine/typeCatalog';
import { quickOpenScore } from '@/lib/quickOpenScore';
import { useNavStore } from '@/stores/navStore';
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
  run: () => void;
}

export function QuickOpen() {
  const visible = useUiStore((s) => s.quickOpenVisible);
  const setQuickOpen = useUiStore((s) => s.setQuickOpen);
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const schema = useSchema();
  const navigate = useNavStore((s) => s.navigate);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const close = () => setQuickOpen(false);
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
      return {
        id: `note:${e.path}`,
        label: e.title,
        icon: style.icon,
        color: style.color,
        hint: key,
        meta: '',
        kindLabel: e.type ?? 'Note',
        alias: key,
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
      kindLabel: 'Type',
      alias: '',
      run: () => go({ kind: 'type', name: t.name }),
    }));

    // Destinations that are surfaces rather than records. Aliases carry the
    // words people actually reach for — "history" for Pulse, "git" for both.
    const places: { id: string; label: string; icon: string; alias: string; sel: Selection }[] = [
      { id: 'go:home', label: 'Home', icon: 'house', alias: 'my tasks', sel: { kind: 'home' } },
      {
        id: 'go:inbox',
        label: 'Inbox',
        icon: 'inbox',
        alias: 'capture queue',
        sel: { kind: 'inbox' },
      },
      {
        id: 'go:docs',
        label: 'Docs',
        icon: 'library',
        alias: 'documents pages',
        sel: { kind: 'docs' },
      },
      {
        id: 'go:knowledge',
        label: 'Knowledge',
        icon: 'brain',
        alias: 'concepts base',
        sel: { kind: 'knowledge' },
      },
      {
        id: 'go:changes',
        label: 'Changes',
        icon: 'file-diff',
        alias: 'git uncommitted diff',
        sel: { kind: 'changes' },
      },
      {
        id: 'go:pulse',
        label: 'Pulse',
        icon: 'activity',
        alias: 'git history commits',
        sel: { kind: 'pulse' },
      },
      {
        id: 'go:settings',
        label: 'Settings',
        icon: 'settings',
        alias: 'preferences',
        sel: { kind: 'settings' },
      },
    ];
    const surfaces: Target[] = places.map((s) => ({
      id: s.id,
      label: s.label,
      icon: s.icon,
      color: null,
      hint: '',
      meta: '',
      kindLabel: 'Go to',
      alias: s.alias,
      run: () => go(s.sel),
    }));

    return [...noteTargets, ...viewTargets, ...typeTargets, ...surfaces];
    // `go`/`openEntry` are navigation closures reborn each render; depending
    // on them would rebuild every target per keystroke for the same behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, views, schema]);

  // On an empty query the panel used to restate the placeholder verbatim and
  // offer nothing to press. The places — Home, Inbox, Docs… — are already
  // targets, so showing them costs nothing and makes ↑↓/↵ work on open.
  const places = useMemo(() => targets.filter((t) => t.kindLabel === 'Go to'), [targets]);

  const results = useMemo(() => {
    const q = query.trim();
    if (q === '') return places.map((target) => ({ target, score: 0 }));
    return targets
      .map((t) => ({
        target: t,
        score: Math.max(quickOpenScore(q, t.label), quickOpenScore(q, t.alias)),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  }, [targets, places, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setActiveIndex(0);
    }
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
        placeholder="Search notes, lists, types, and places…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
          }
          if (e.key === 'Enter' && results[activeIndex]) results[activeIndex].target.run();
          if (e.key === 'Escape') close();
        }}
        width="100%"
      />
      {query.trim() === '' && results.length > 0 && (
        <div className="mt-2.5 px-2.5 text-2xs font-semibold uppercase tracking-[var(--track-caps)] text-[var(--text-meta)]">
          Go to
        </div>
      )}
      <div
        role="listbox"
        aria-label="Quick open results"
        className="mt-1.5 max-h-[380px] overflow-y-auto"
      >
        {results.map((r, i) => (
          <button
            key={r.target.id}
            type="button"
            data-testid="quick-open-result"
            role="option"
            aria-selected={i === activeIndex}
            onClick={() => r.target.run()}
            onMouseEnter={() => setActiveIndex(i)}
            className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left"
            style={{ background: i === activeIndex ? 'var(--n-50)' : 'transparent' }}
          >
            <span
              className="inline-flex flex-none"
              style={{ color: r.target.color ?? 'var(--n-500)' }}
            >
              <Icon name={r.target.icon} size={14} />
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
        ))}
        {query.trim() !== '' && results.length === 0 && (
          <div className="px-3 py-4 text-xs text-[var(--text-meta)]">
            No matches. Try a different term.
          </div>
        )}
      </div>
    </Dialog>
  );
}
