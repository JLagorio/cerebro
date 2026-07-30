import { useEffect, useMemo, useState } from 'react';
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
 * QuickOpen found notes and nothing else, so reaching a saved view or a type
 * screen meant leaving the keyboard for the sidebar. Everything navigable is
 * findable here now, under one ranking.
 */
interface Target {
  id: string;
  label: string;
  icon: string;
  color: string | null;
  /** Right-aligned qualifier — the record's key, or what kind of thing this is. */
  hint: string;
  kindLabel: string;
  /** Text the query is matched against, beyond the label. */
  alias: string;
  run: () => void;
}

export function QuickOpen() {
  const visible = useUiStore((s) => s.quickOpenVisible);
  const setQuickOpen = useUiStore((s) => s.setQuickOpen);
  const openDetail = useUiStore((s) => s.openDetail);
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

  const openEntry = (entry: Entry) => {
    close();
    if (entry.type === 'Project') {
      navigate({ kind: 'project', path: entry.path });
      return;
    }
    // Work items open in the detail panel on their project canvas (v2
    // containment); every other markdown file is a document (Task 10).
    // QuickOpen keeps the navigate mode deliberately: there may be no
    // relevant canvas behind it (M9.3).
    if (entry.type === 'Work item') {
      if (entry.project !== null) navigate({ kind: 'project', path: entry.project });
      openDetail(entry.path);
      return;
    }
    navigate({ kind: 'doc', path: entry.path });
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
        kindLabel: e.type ?? 'Note',
        alias: key,
        run: () => openEntry(e),
      };
    });

    const viewTargets: Target[] = views
      .filter((v) => v.project === null)
      .map((v) => ({
        id: `view:${v.id}`,
        label: v.definition.name,
        icon: v.definition.icon ?? 'layout-list',
        color: v.definition.color,
        hint: '',
        kindLabel: 'View',
        alias: v.id,
        run: () => go({ kind: 'view', id: v.id }),
      }));

    const typeTargets: Target[] = listTypes(entries, schema).map((t) => ({
      id: `type:${t.name}`,
      label: t.name,
      icon: t.icon,
      color: t.color,
      hint: String(t.count),
      kindLabel: 'Type',
      alias: '',
      run: () => go({ kind: 'type', name: t.name }),
    }));

    // Destinations that are surfaces rather than records. Aliases carry the
    // words people actually reach for — "history" for Pulse, "git" for both.
    const places: { id: string; label: string; icon: string; alias: string; sel: Selection }[] = [
      { id: 'go:home', label: 'Home', icon: 'house', alias: 'my tasks', sel: { kind: 'home' } },
      { id: 'go:inbox', label: 'Inbox', icon: 'inbox', alias: 'capture queue', sel: { kind: 'inbox' } },
      { id: 'go:docs', label: 'Docs', icon: 'library', alias: 'documents pages', sel: { kind: 'docs' } },
      { id: 'go:knowledge', label: 'Knowledge', icon: 'brain', alias: 'concepts base', sel: { kind: 'knowledge' } },
      { id: 'go:changes', label: 'Changes', icon: 'file-diff', alias: 'git uncommitted diff', sel: { kind: 'changes' } },
      { id: 'go:pulse', label: 'Pulse', icon: 'activity', alias: 'git history commits', sel: { kind: 'pulse' } },
      { id: 'go:settings', label: 'Settings', icon: 'settings', alias: 'preferences', sel: { kind: 'settings' } },
    ];
    const surfaces: Target[] = places.map((s) => ({
      id: s.id,
      label: s.label,
      icon: s.icon,
      color: null,
      hint: '',
      kindLabel: 'Go to',
      alias: s.alias,
      run: () => go(s.sel),
    }));

    return [...noteTargets, ...viewTargets, ...typeTargets, ...surfaces];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, views, schema]);

  const results = useMemo(() => {
    const q = query.trim();
    if (q === '') return [];
    return targets
      .map((t) => ({
        target: t,
        score: Math.max(quickOpenScore(q, t.label), quickOpenScore(q, t.alias)),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  }, [targets, query]);

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
    <Dialog open onClose={close} title="Quick open" width={580}>
      <Input
        autoFocus
        testId="quick-open-input"
        icon="search"
        placeholder="Search notes, views, types, and places…"
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
      <div role="listbox" aria-label="Quick open results" className="mt-1.5 max-h-[380px] overflow-y-auto">
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
            <span className="inline-flex flex-none" style={{ color: r.target.color ?? 'var(--n-400)' }}>
              <Icon name={r.target.icon} size={14} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--n-900)]">
              {r.target.label}
            </span>
            {r.target.hint !== '' && (
              <span className="[font-family:var(--font-mono)] text-[10px] text-[var(--n-400)]">
                {r.target.hint}
              </span>
            )}
            <span className="flex-none [font-family:var(--font-mono)] text-[10px] text-[var(--n-400)]">
              {r.target.kindLabel}
            </span>
          </button>
        ))}
        {query.trim() === '' && (
          <div className="px-3 py-4 text-[12px] text-[var(--n-500)]">
            Type to search notes, saved views, types, and places to go.
          </div>
        )}
        {query.trim() !== '' && results.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-[var(--n-500)]">No matches. Try a different term.</div>
        )}
      </div>
    </Dialog>
  );
}
