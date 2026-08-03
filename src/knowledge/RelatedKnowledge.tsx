import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { listConcepts, relatedConcepts } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { TrustChip } from '@/knowledge/TrustChip';
import { useNavStore } from '@/stores/navStore';
import { todayIso } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * What the assistant knows that bears on the note you are looking at (M8.3).
 *
 * This is the payoff of anchoring concepts with `about:` — knowledge stops
 * being somewhere you go and starts appearing beside the work it describes.
 *
 * It is deliberately PASSIVE. Nothing here interrupts, animates, or asks; it
 * sits below the fold and waits to be scrolled to. The one active affordance
 * is a button the user presses, because the difference between an assistant
 * and a nag is who started the conversation.
 */

export interface RelatedKnowledgeProps {
  entry: Entry;
  /** How many to show before the rest are summarised. */
  limit?: number;
  /** Prompt to hand the assistant when the user asks it to look harder. */
  askPrompt?: string;
  askLabel?: string;
  /** 'section' sits in a page; 'panel' is the narrower side-panel variant. */
  variant?: 'section' | 'panel';
}

export function RelatedKnowledge({
  entry,
  limit = 5,
  askPrompt,
  askLabel = 'Ask what is missing',
  variant = 'section',
}: RelatedKnowledgeProps) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const setAiPanelOpen = useUiStore((s) => s.setAiPanelOpen);
  const setPendingPrompt = useUiStore((s) => s.setAgentPendingPrompt);
  const closeDetail = useUiStore((s) => s.closeDetail);

  const today = todayIso();
  const related = useMemo(
    () => relatedConcepts(entry, listConcepts(entries, today), entries),
    [entry, entries, today],
  );

  const shown = related.slice(0, limit);
  const rest = related.length - shown.length;

  const ask = () => {
    if (askPrompt === undefined) return;
    setAiPanelOpen(true);
    setPendingPrompt(askPrompt);
  };

  // An empty state that still offers the ask: "nothing yet" is exactly when
  // asking is most useful, and a section that vanishes teaches nobody it
  // exists.
  return (
    <section
      data-testid="related-knowledge"
      data-count={related.length}
      className={variant === 'panel' ? '' : 'mt-8 border-t border-n-100 pt-5'}
    >
      <div className="flex items-center gap-2">
        <Icon name="brain" size={14} color="var(--cortex-500)" />
        <h3 className="m-0 text-[12px] font-semibold uppercase tracking-[0.06em] text-n-500">
          What the assistant knows
        </h3>
        {related.length > 0 && (
          <span className="[font-family:var(--font-mono)] text-[11px] text-n-400">
            {related.length}
          </span>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="m-0 mt-2 text-[12.5px] leading-[18px] text-n-500">Nothing yet about this.</p>
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
          {shown.map((concept) => (
            <li key={concept.entry.path}>
              <button
                type="button"
                data-testid="related-concept"
                data-path={concept.entry.path}
                onClick={() => {
                  // Same rule as the dossier (M14.2): following a concept
                  // leaves the record, so the panel goes with it.
                  closeDetail();
                  navigate({ kind: 'knowledge', nav: { tab: 'all' }, path: concept.entry.path });
                }}
                className="flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left hover:bg-n-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-n-800">
                    {concept.title}
                  </span>
                  {concept.description !== null && variant === 'section' && (
                    <span className="block truncate text-[11.5px] text-n-500">
                      {concept.description}
                    </span>
                  )}
                </span>
                <TrustChip tier={concept.trust} size="sm" />
                {concept.stale && <Icon name="clock-alert" size={11} color="var(--warn-600)" />}
              </button>
            </li>
          ))}
        </ul>
      )}

      {rest > 0 && <p className="m-0 mt-1.5 px-2 text-[11.5px] text-n-400">and {rest} more</p>}

      {askPrompt !== undefined && (
        <div className="mt-2.5">
          <Button variant="secondary" size="sm" icon="sparkles" onClick={ask}>
            {askLabel}
          </Button>
        </div>
      )}
    </section>
  );
}
