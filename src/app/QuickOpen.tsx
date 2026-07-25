import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { quickOpenScore } from '@/lib/quickOpenScore';
import { resolveTarget } from '@/engine/wikilink';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { Entry } from '@/engine/types';

export function QuickOpen() {
  const visible = useUiStore((s) => s.quickOpenVisible);
  const setQuickOpen = useUiStore((s) => s.setQuickOpen);
  const openDetail = useUiStore((s) => s.openDetail);
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(() => {
    const q = query.trim();
    if (q === '') return [];
    return entries
      .map((e) => ({
        entry: e,
        score: Math.max(
          quickOpenScore(q, e.title),
          quickOpenScore(q, typeof e.properties.key === 'string' ? e.properties.key : ''),
        ),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }, [entries, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [visible]);

  const close = () => setQuickOpen(false);

  const pick = (entry: Entry) => {
    close();
    if (entry.type === 'Space') {
      navigate({ kind: 'space', path: entry.path });
      return;
    }
    if (entry.type === 'Project') {
      navigate({ kind: 'project', path: entry.path });
      return;
    }
    const target = entry.relationships.project?.[0];
    const project = target ? resolveTarget(target, entries) : null;
    if (project) navigate({ kind: 'project', path: project.path });
    openDetail(entry.path);
  };

  if (!visible) return null;

  return (
    <Dialog open onClose={close} title="Quick open" width={580}>
      <Input
        autoFocus
        icon="search"
        placeholder="Search items, projects, and spaces…"
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
          if (e.key === 'Enter' && results[activeIndex]) pick(results[activeIndex].entry);
          if (e.key === 'Escape') close();
        }}
        width="100%"
      />
      <div role="listbox" aria-label="Quick open results" className="mt-1.5 max-h-[380px] overflow-y-auto">
        {results.map((r, i) => (
          <button
            key={r.entry.path}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            onClick={() => pick(r.entry)}
            onMouseEnter={() => setActiveIndex(i)}
            className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left"
            style={{ background: i === activeIndex ? 'var(--n-50)' : 'transparent' }}
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--n-900)]">{r.entry.title}</span>
            {typeof r.entry.properties.key === 'string' && (
              <span className="[font-family:var(--font-mono)] text-[10px] text-[var(--n-400)]">
                {r.entry.properties.key}
              </span>
            )}
            <span className="flex-none [font-family:var(--font-mono)] text-[10px] text-[var(--n-400)]">
              {r.entry.type ?? 'Note'}
            </span>
          </button>
        ))}
        {query.trim() === '' && (
          <div className="px-3 py-4 text-[12px] text-[var(--n-500)]">Type to search every entry in the vault.</div>
        )}
        {query.trim() !== '' && results.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-[var(--n-500)]">No matches. Try a different term.</div>
        )}
      </div>
    </Dialog>
  );
}
