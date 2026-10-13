import { useMemo } from 'react';
import { Icon } from '@/components/ui/Icon';
import { knowledgeOf, type Concept } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { useReviewStart } from '@/knowledge/ReviewQueue';
import { useConcepts } from '@/knowledge/useConcepts';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** How many concepts the strip names before it says "+N". */
const SHOWN = 3;

/**
 * What Knowledge holds about this page, said where the page is read (M50.2).
 *
 * The knowledge was always there — a collapsed section on a record, the
 * fourth tab of a doc's side panel — and never where anyone was looking: a
 * page the agents had learned from, or learned about, gave no sign of it.
 * This is one quiet line under the page header, and it is SILENT when there
 * is nothing: the rule that nothing speaks first (M8) is about the chrome
 * volunteering, not about a page saying what is attached to it.
 *
 * Both directions count: concepts ABOUT this page (it is their subject) and
 * concepts learned FROM it (it is their source) — `knowledgeOf`, the read
 * the AI panel's snapshot makes too (M52.3); the two used to count different
 * things on the same page. Each opens as its page; the rest open the side
 * panel's Knowledge tab.
 */
export function KnowledgeStrip({ entry }: { entry: Entry }) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const setDocPanelOpen = useUiStore((s) => s.setDocPanelOpen);
  const setDocPanelTab = useUiStore((s) => s.setDocPanelTab);
  const all = useConcepts();
  const related: Concept[] = useMemo(() => {
    const { about, from } = knowledgeOf(entry.path, all, entries);
    // A replaced concept is not what Knowledge holds any more.
    return [...about, ...from].filter((c) => c.supersededBy === null);
  }, [all, entries, entry.path]);
  // M52.3 — the page's own concepts that wait on a person, in the order the
  // queue works them, so "to review" opens the one the Review tab would —
  // and the pager then walks this page's concepts, not the bundle (M52.5).
  const { waiting, start } = useReviewStart(all, related, {
    label: entry.title,
    back: { kind: 'doc', path: entry.path },
  });

  if (related.length === 0) return null;
  const openPanel = () => {
    setDocPanelTab('knowledge');
    setDocPanelOpen(true);
  };

  return (
    <div
      data-testid="knowledge-strip"
      className="mb-3 ml-[54px] flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-n-500"
    >
      <button
        type="button"
        onClick={openPanel}
        className="inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1 py-0.5 font-medium text-n-600 hover:bg-n-50 hover:text-n-900"
      >
        <Icon name="brain" size={13} color="var(--synapse-500)" />
        Knowledge
      </button>
      {related.slice(0, SHOWN).map((c) => (
        <button
          key={c.entry.path}
          type="button"
          data-testid="knowledge-strip-concept"
          data-path={c.entry.path}
          onClick={() => navigate({ kind: 'doc', path: c.entry.path })}
          className="max-w-[240px] truncate rounded-md border border-n-200 bg-n-0 px-1.5 py-px text-xs text-n-700 hover:border-n-300 hover:text-n-900"
        >
          {c.title}
        </button>
      ))}
      {related.length > SHOWN && (
        <button
          type="button"
          onClick={openPanel}
          className="rounded-md border-0 bg-transparent px-1 py-px text-xs text-n-500 hover:text-n-800"
        >
          +{related.length - SHOWN} more
        </button>
      )}
      {/* M52.3 — a count you could not act on. It opens the first of them
          as its page, where the review bar and its pager take over. */}
      {waiting.length > 0 && (
        <button
          type="button"
          data-testid="knowledge-strip-waiting"
          title="Review the first of them"
          onClick={start}
          className="rounded-md border-0 bg-transparent px-1 py-px text-2xs text-n-400 hover:bg-n-50 hover:text-n-800"
        >
          · {waiting.length} to review
        </button>
      )}
    </div>
  );
}
