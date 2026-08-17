import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { listConcepts, relatedConcepts } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { ReviewChip } from '@/knowledge/ReviewChip';
import { useNavStore } from '@/stores/navStore';
import { askBasePrompt } from '@/lib/prompts';
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
 * sits below the fold and waits to be scrolled to. Every active affordance on
 * it is a button the user presses, because the difference between an
 * assistant and a nag is who started the conversation.
 *
 * M33a.5 made the read INVOCABLE: `Ask the base` hands the assistant the same
 * question this list renders, and the assistant answers it with the
 * `knowledge_about` tool rather than by guessing at the bundle.
 */

export interface RelatedKnowledgeProps {
  entry: Entry;
  /** How many to show before the rest are summarised. */
  limit?: number;
  /** Prompt to hand the assistant when the user asks it to look harder. */
  askPrompt?: string;
  /** The record that prompt is ABOUT (M17.6) — attached as a context chip
   * so the agent reads it rather than inferring it from the prompt text. */
  askSubject?: string | null;
  askLabel?: string;
  /** 'section' sits in a page; 'panel' is the narrower side-panel variant. */
  variant?: 'section' | 'panel';
}

export function RelatedKnowledge({
  entry,
  limit = 5,
  askPrompt,
  askSubject,
  askLabel = 'Ask what is missing',
  variant = 'section',
}: RelatedKnowledgeProps) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const askAgent = useUiStore((s) => s.askAgent);
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
    askAgent(askPrompt, askSubject ?? null);
  };

  // The record travels WITH the prompt (M17.6) — it becomes a context chip,
  // so the agent reads this record rather than whatever surface the user
  // happened to be standing on when they pressed the button.
  const askBase = () => {
    askAgent(askBasePrompt(entry.path, entry.title), entry.path);
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
        <h3 className="m-0 text-xs font-semibold uppercase tracking-[0.06em] text-n-500">
          What the assistant knows
        </h3>
        {related.length > 0 && (
          <span className="[font-family:var(--font-mono)] text-2xs text-n-400">
            {related.length}
          </span>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="m-0 mt-2 text-sm leading-[18px] text-n-500">Nothing yet about this.</p>
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
                  <span className="block truncate text-sm font-medium text-n-800">
                    {concept.title}
                  </span>
                  {concept.description !== null && variant === 'section' && (
                    <span className="block truncate text-xs text-n-500">{concept.description}</span>
                  )}
                </span>
                <ReviewChip status={concept.review} by={concept.reviewedBy} size="sm" />
                {concept.stale && <Icon name="clock-alert" size={11} color="var(--warn-600)" />}
              </button>
            </li>
          ))}
        </ul>
      )}

      {rest > 0 && <p className="m-0 mt-1.5 px-2 text-xs text-n-400">and {rest} more</p>}

      {/* Two questions, and they are genuinely different. "Ask the base" goes
          to the SUBJECT — knowledge_about answers by anchor, so it reaches
          concepts this list cannot, the ones filed under entities the record
          only reaches through its project or a link it never made. The
          optional second button goes to the DRAFT. Both are buttons, pressed
          by a person; neither counts up at anyone (M8.1). */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" icon="sparkles" onClick={askBase}>
          Ask the base
        </Button>
        {askPrompt !== undefined && (
          <Button variant="secondary" size="sm" icon="sparkles" onClick={ask}>
            {askLabel}
          </Button>
        )}
      </div>
    </section>
  );
}
