import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { usePaneId } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import './inspector.css';

/** The newest reveal (`inspectorReveal.seq`) each pane's section has scrolled
 *  to, so a section that mounts again later — Details chosen again — stays
 *  where it is instead of jumping back to an ask already answered. Keyed by
 *  pane: another pane's inspector never answers this pane's ask. */
const answered = new Map<string, number>();

/**
 * One folding section of the inspector's Details panel: a hairline above it, a
 * quiet header that folds it, its count, and optional actions beside the
 * header. The fold is the person's, kept in uiStore by `id` and shared by
 * every page: `inspectorCollapsed` for a section that starts open,
 * `inspectorExpanded` for one that starts folded (`defaultOpen={false}`).
 * A section can say what it holds in a few words at the header's end
 * (`summary`), folded or not. `revealInspectorSection(id, pane)` unfolds it
 * and scrolls it into view in the pane that asked.
 */
export function InspectorSection({
  id,
  label,
  count,
  summary,
  defaultOpen = true,
  actions,
  testId,
  children,
}: {
  /** The section's identity: its fold, its reveal, and `data-section`. */
  id: string;
  label: string;
  /** How many rows it holds, said beside its label. */
  count?: number;
  /** What the section holds in a few words, at the end of its header —
   *  read whether it is folded or open, so its body needs no sentence. */
  summary?: ReactNode;
  /** Folded until the person opens it: reference a page rarely needs. */
  defaultOpen?: boolean;
  /** Controls beside the header, outside the fold toggle. */
  actions?: ReactNode;
  testId?: string;
  /** None: a header that says it all (`summary`), with nothing to unfold. */
  children?: ReactNode;
}) {
  const pane = usePaneId();
  const open = useUiStore((s) =>
    defaultOpen ? !s.inspectorCollapsed.includes(id) : s.inspectorExpanded.includes(id),
  );
  const setOpen = useUiStore((s) => s.setInspectorSectionOpen);
  const reveal = useUiStore((s) => {
    const asked = s.inspectorReveal;
    return asked !== null && asked.id === id && (asked.pane === null || asked.pane === pane)
      ? asked.seq
      : null;
  });
  const ref = useRef<HTMLElement | null>(null);
  // Whether the person has unfolded it here, which is when its body drops
  // in (inspector.css); open from the start, it is simply there.
  const [unfolded, setUnfolded] = useState(false);
  const base = useId();
  const headId = `${base}-head`;
  const bodyId = `${base}-body`;
  const summaryId = `${base}-summary`;
  const summarized = summary !== undefined && summary !== null;

  useEffect(() => {
    if (reveal === null || reveal <= (answered.get(pane) ?? 0)) return;
    answered.set(pane, reveal);
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [pane, reveal]);

  return (
    <section
      ref={ref}
      className="cb-inspector-section"
      data-section={id}
      data-open={open}
      data-unfolded={unfolded || undefined}
      data-empty={children === undefined || undefined}
      data-testid={testId}
      aria-labelledby={headId}
    >
      <h3 className="cb-inspector-section-head">
        {children === undefined ? (
          // Nothing to unfold: the header is the whole section, so it is a
          // heading, not a toggle, and its summary is read with its label.
          <span id={headId} className="cb-inspector-section-toggle" data-static="">
            <span className="cb-inspector-section-label">{label}</span>
            {count !== undefined && <span className="cb-inspector-section-count">{count}</span>}
            {summarized && <span className="cb-inspector-section-summary">{summary}</span>}
          </span>
        ) : (
          <button
            type="button"
            id={headId}
            className="cb-inspector-section-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            // The summary is said, not named: the toggle's name stays its label.
            aria-describedby={summarized ? summaryId : undefined}
            onClick={() => {
              if (!open) setUnfolded(true);
              setOpen(id, !open);
            }}
          >
            <span className="cb-inspector-section-label">{label}</span>
            {count !== undefined && <span className="cb-inspector-section-count">{count}</span>}
            {summarized && (
              <span id={summaryId} aria-hidden="true" className="cb-inspector-section-summary">
                {summary}
              </span>
            )}
            <Icon name="chevron-down" size={14} className="cb-inspector-section-chevron" />
          </button>
        )}
        {actions}
      </h3>
      {children !== undefined && (
        <div id={bodyId} className="cb-inspector-section-body" hidden={!open}>
          {children}
        </div>
      )}
    </section>
  );
}
