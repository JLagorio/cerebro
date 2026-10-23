import { useMemo } from 'react';
import { useLedgerReview, useQuarantine } from '@/stores/ledgerStore';
import { askBaseAsk, sendAsk, type Ask } from '@/agent/elements/decisionsAsks';
import { Suggestion, Suggestions } from '@/components/ai/Suggestion';
import { Icon } from '@/components/ui/Icon';
import { listConcepts, relatedConcepts } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { ReviewChip } from '@/knowledge/ReviewChip';
import { useNavStore } from '@/stores/navStore';
import { askedAbout, AUGMENT_LABEL } from '@/lib/prompts';
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
 * M33a.5 made the read INVOCABLE: asking the base hands the assistant the
 * same question this list renders, and the assistant answers it with the
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
  /**
   * 'section' sits in a page; 'panel' is the narrower side-panel variant.
   * 'embedded' is one group of a page's Knowledge (M52.3, `PageKnowledge`):
   * the rows alone, without the heading, the empty sentence or the asks its
   * host already carries.
   */
  variant?: 'section' | 'panel' | 'embedded';
}

export function RelatedKnowledge({
  entry,
  limit = 5,
  askPrompt,
  askSubject,
  askLabel = AUGMENT_LABEL,
  variant = 'section',
}: RelatedKnowledgeProps) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const askAgent = useUiStore((s) => s.askAgent);
  const closeDetail = useUiStore((s) => s.closeDetail);

  const quarantine = useQuarantine();
  const ledgerReview = useLedgerReview();
  const today = todayIso();
  const related = useMemo(
    () => relatedConcepts(entry, listConcepts(entries, today, quarantine, ledgerReview), entries),
    [entry, entries, today, quarantine, ledgerReview],
  );

  // M33a.6 — a replaced concept sorts BELOW everything still standing.
  //
  // `relatedConcepts` scores by how many anchors match, which says how
  // relevant a concept is and nothing at all about whether the bundle still
  // believes it. So the workspace could lead with a claim the base retired,
  // rendered identically to a live one. That is the confident-and-wrong shape
  // M15 killed on the reading pane and the dossier has never had; this is the
  // last surface that still had it.
  const ordered = useMemo(
    () => [
      ...related.filter((c) => c.supersededBy === null),
      ...related.filter((c) => c.supersededBy !== null),
    ],
    [related],
  );
  const shown = ordered.slice(0, limit);
  const rest = ordered.length - shown.length;

  // The host's own question about the draft, under the label it gives.
  const ask: Ask | null =
    askPrompt === undefined
      ? null
      : {
          label: askLabel,
          prompt: askPrompt,
          subject: askSubject ?? null,
          bubble: askedAbout(askLabel, entry.title),
        };

  // The record travels WITH the prompt (M17.6) — it becomes a context chip,
  // so the agent reads this record rather than whatever surface the user
  // happened to be standing on when they pressed the button.
  const askBase = askBaseAsk(entry);
  const embedded = variant === 'embedded';

  // An empty state that still offers the ask: "nothing yet" is exactly when
  // asking is most useful, and a section that vanishes teaches nobody it
  // exists.
  return (
    <section
      data-testid="related-knowledge"
      data-count={related.length}
      className={variant === 'section' ? 'mt-8 border-t border-n-100 pt-5' : ''}
    >
      {!embedded && (
        <div className="flex items-center gap-2">
          <Icon name="brain" size={14} color="var(--cortex-500)" />
          <h3 className="m-0 text-xs font-semibold uppercase tracking-[0.06em] text-n-500">
            Knowledge
          </h3>
          {related.length > 0 && (
            <span className="[font-family:var(--font-mono)] text-2xs text-n-400">
              {related.length}
            </span>
          )}
        </div>
      )}

      {shown.length === 0 ? (
        !embedded && (
          <p className="m-0 mt-2 text-sm leading-[18px] text-n-500">Nothing yet about this.</p>
        )
      ) : (
        // Embedded, the inspector's rows (owner, 2026-10-18): the text on the
        // section's edge, the hover washing past it.
        <ul
          className={
            embedded ? '-mx-2 flex flex-col gap-px' : 'm-0 mt-2 flex list-none flex-col gap-1 p-0'
          }
        >
          {shown.map((concept) => {
            const replaced = concept.supersededBy !== null;
            // M52.3 — the Concepts list's rule: only the review states worth
            // reading.
            const reviewed = !replaced && concept.review !== 'unreviewed';
            const open = () => {
              // Same rule as the dossier (M14.2): following a concept
              // leaves the record, so the panel goes with it.
              closeDetail();
              navigate({ kind: 'doc', path: concept.entry.path });
            };
            if (embedded) {
              // One line in the inspector's voice (owner, 2026-10-18), like
              // the dossier's rows beside it: the summary is the tooltip.
              return (
                <li key={concept.entry.path}>
                  <button
                    type="button"
                    data-testid="related-concept"
                    data-path={concept.entry.path}
                    title={replaced ? undefined : (concept.description ?? undefined)}
                    onClick={open}
                    className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md bg-transparent px-2 text-left hover:bg-n-50"
                  >
                    <Icon name="lightbulb" size={14} color="var(--n-400)" />
                    <span
                      className={`min-w-0 flex-1 truncate text-ui ${
                        replaced ? 'text-n-400 line-through' : 'text-n-800'
                      }`}
                    >
                      {concept.title}
                    </span>
                    {/* A strikethrough alone is a legend nobody has (M15): the
                        word is what makes it readable. */}
                    {replaced ? (
                      <span data-testid="related-replaced" className="flex-none text-xs text-n-400">
                        Replaced
                      </span>
                    ) : (
                      <>
                        {reviewed && (
                          <ReviewChip
                            status={concept.review}
                            by={concept.reviewedBy}
                            size="glyph"
                          />
                        )}
                        {concept.stale && (
                          <span title="Due a recheck" className="flex flex-none">
                            <Icon name="clock-alert" size={14} color="var(--warn-600)" />
                          </span>
                        )}
                      </>
                    )}
                  </button>
                </li>
              );
            }
            const review = reviewed && (
              <ReviewChip status={concept.review} by={concept.reviewedBy} size="sm" />
            );
            return (
              <li key={concept.entry.path}>
                <button
                  type="button"
                  data-testid="related-concept"
                  data-path={concept.entry.path}
                  onClick={open}
                  className="flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left hover:bg-n-50"
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm font-medium ${
                        replaced ? 'text-n-400 line-through' : 'text-n-800'
                      }`}
                    >
                      {concept.title}
                    </span>
                    {concept.description !== null && !replaced && variant !== 'panel' && (
                      <span className="block truncate text-xs text-n-500">
                        {concept.description}
                      </span>
                    )}
                  </span>
                  {/* A strikethrough alone is a legend nobody has (M15): deleted,
                      deprecated, done and filtered-out all look like this. The
                      word is what makes it readable. */}
                  {replaced ? (
                    <span
                      data-testid="related-replaced"
                      className="flex-none rounded-sm bg-n-100 px-1 text-2xs text-n-500"
                    >
                      Replaced
                    </span>
                  ) : (
                    <>
                      {review}
                      {concept.stale && (
                        <Icon name="clock-alert" size={11} color="var(--warn-600)" />
                      )}
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {rest > 0 && (
        <p className={`mt-1.5 text-xs text-n-400 ${embedded ? 'leading-4' : 'm-0 px-2'}`}>
          and {rest} more
        </p>
      )}

      {/* Two questions, and they are genuinely different. Asking the base
          goes to the SUBJECT — knowledge_about answers by anchor, so it
          reaches concepts this list cannot, the ones filed under entities the
          record only reaches through its project or a link it never made. The
          optional second button goes to the DRAFT. Both are buttons, pressed
          by a person; neither counts up at anyone (M8.1). Embedded (M52.3),
          the host's asks carry them. */}
      {!embedded && (
        <Suggestions aria-label="Ask Knowledge" className="mt-2.5">
          <Suggestion suggestion={askBase.prompt} onClick={sendAsk(askBase, askAgent)}>
            {askBase.label}
          </Suggestion>
          {ask !== null && (
            <Suggestion suggestion={ask.prompt} onClick={sendAsk(ask, askAgent)}>
              {ask.label}
            </Suggestion>
          )}
        </Suggestions>
      )}
    </section>
  );
}
