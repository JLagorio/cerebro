import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { StatusSection } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';

/**
 * The hub's own navigation (M33.10).
 *
 * The Status hub used to be one section and four doors, so it borrowed
 * Home's sidebar — the types-and-views list, which describes the RECORD
 * corpus and has nothing to say about runs, budgets or queued proposals.
 * M33.3–M33.5 turned the doors into bodies, and a five-section page in one
 * scrolling column needs a way to get to its fifth section that is not
 * scrolling past the other four.
 *
 * So the hub is sidebarless like the other destinations that answer their own
 * question (Settings, History, Inbox, Library, Workspace) and carries this
 * instead: its own contents, driving the `section` the Selection already
 * knows how to hold.
 *
 * **The list is fixed and the page's sections are not.** The attention lanes
 * arrive named by Rust and vary; they are reached under one "Attention" entry
 * rather than enumerated here, because a nav that spelled the lane names
 * would be a second copy of a list Rust owns.
 */

const ENTRIES: { id: StatusSection; label: string; icon: string; hint: string }[] = [
  { id: 'changed', label: 'What changed', icon: 'activity', hint: 'Since anybody last looked' },
  { id: 'needs-review', label: 'Needs review', icon: 'gavel', hint: 'Waiting on your decision' },
  { id: 'fleet', label: 'What has run', icon: 'history', hint: 'Every run, and what it cost' },
  { id: 'system', label: 'Background', icon: 'gauge', hint: 'Running, spending, holding' },
  { id: 'gates', label: 'Deferral gates', icon: 'scan-eye', hint: 'What stays unbuilt, and why' },
];

/**
 * Which section the reader is actually looking at.
 *
 * Observed rather than tracked: the page is one scroll container and the user
 * can arrive at a section by scrolling as easily as by clicking, so a nav
 * that only highlighted what was last CLICKED would be wrong most of the time.
 */
function useVisibleSection(fallback: StatusSection): StatusSection {
  const [visible, setVisible] = useState<StatusSection>(fallback);
  useEffect(() => {
    const targets = ENTRIES.map((entry) => ({
      id: entry.id,
      node: document.querySelector(`[data-section="${entry.id}"]`),
    })).filter((t): t is { id: StatusSection; node: Element } => t.node !== null);
    if (targets.length === 0) return;

    const seen = new Map<StatusSection, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const match = targets.find((t) => t.node === entry.target);
          if (match !== undefined) seen.set(match.id, entry.intersectionRatio);
        }
        // The most-visible section wins, and ties break toward the top of the
        // page — scrolling down should not flicker between two halves.
        let best: StatusSection | null = null;
        let bestRatio = 0;
        for (const entry of ENTRIES) {
          const ratio = seen.get(entry.id) ?? 0;
          if (ratio > bestRatio) {
            best = entry.id;
            bestRatio = ratio;
          }
        }
        if (best !== null) setVisible(best);
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const target of targets) observer.observe(target.node);
    return () => observer.disconnect();
    // Re-observed when the page's sections change identity, which they do
    // once each feed resolves and replaces its loading state.
  }, [fallback]);
  return visible;
}

export function StatusNav() {
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);
  const asked = selection.kind === 'status' ? selection.section : undefined;
  const visible = useVisibleSection(asked ?? 'changed');
  const active = asked ?? visible;

  return (
    <nav
      data-testid="status-nav"
      aria-label="Status sections"
      className="flex w-[200px] flex-none flex-col gap-0.5 border-r border-n-200 p-2"
    >
      <div className="flex items-center gap-2 px-2 pb-2 pt-1">
        <Icon name="brain" size={14} color="var(--n-600)" />
        <h2 className="text-xs font-semibold text-n-800">Status</h2>
      </div>
      {ENTRIES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          data-testid="status-nav-row"
          // `data-target`, NOT `data-section`: that attribute addresses the
          // SECTIONS, and a nav row claiming it made every section locator in
          // the suite ambiguous (two matches, strict-mode violation). One
          // attribute, one meaning.
          data-target={entry.id}
          data-active={entry.id === active}
          aria-current={entry.id === active ? 'true' : undefined}
          onClick={() => {
            navigate({ kind: 'status', section: entry.id });
            document.querySelector(`[data-section="${entry.id}"]`)?.scrollIntoView({
              block: 'start',
            });
          }}
          className={`flex flex-col gap-0.5 rounded px-2 py-1.5 text-left ${
            entry.id === active ? 'bg-n-100' : 'hover:bg-n-50'
          }`}
        >
          <span className="flex items-center gap-1.5">
            <Icon name={entry.icon} size={12} color="var(--n-500)" />
            <span className="text-xs text-n-800">{entry.label}</span>
          </span>
          <span className="pl-[18px] text-2xs text-n-500">{entry.hint}</span>
        </button>
      ))}
      <p className="mt-auto px-2 pb-1 text-2xs text-n-400">
        {/* The M8 rule, said once where it is easy to break: this nav carries
            no counts. A badge here would be the chrome nagging somebody to
            drain a queue. */}
        Nothing here speaks first.
      </p>
    </nav>
  );
}
