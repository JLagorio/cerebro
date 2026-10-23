import { useMemo } from 'react';
import { pageKnowledgeAsks, sendAsk } from '@/agent/elements/decisionsAsks';
import { InspectorActions, InspectorAsk, InspectorSubhead } from '@/detail/InspectorParts';
import { commitOf, conceptsAbout, relatedConcepts } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { EntityDossier } from '@/knowledge/EntityDossier';
import { KnowledgeCommit, useLearnQueued } from '@/knowledge/KnowledgeCommit';
import { relativeDay } from '@/knowledge/KnowledgePanel';
import { RelatedKnowledge } from '@/knowledge/RelatedKnowledge';
import { useConcepts } from '@/knowledge/useConcepts';
import { todayIso } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * What Knowledge holds about one page, and the three things to ask of it
 * (M52.3) — one anatomy wherever a page is read. The record peek's Knowledge
 * section and the Knowledge section of a page's inspector both render exactly
 * this.
 *
 * They were two stacks, each with its own heading, its own empty sentence and
 * its own Learn button, so one record could say "Not in Knowledge" above
 * "Nothing yet about this" in one place and something else in the other,
 * with two buttons that did the same thing. Now: two groups — what was
 * learned FROM the page, what the base holds ABOUT it — one sentence when
 * both are empty, and the three asks, drawn as rows the way the inspector
 * draws every act (owner, 2026-10-18) — Suggestions, each showing its label
 * and sending its prompt (M91.14).
 *
 * About is capability-gated, not type-gated (M14.2): when the base holds
 * concepts ABOUT this entry, the entry is a subject and gets its dossier —
 * believed, unsettled, read-from, retired. Otherwise the wide-net related
 * list, which is the right shape for a page the base only knows *around*
 * (via its project or its links).
 *
 * Still passive (M8.3): it renders when a person opens it, and every act on
 * it is a button they press.
 */
export function PageKnowledge({ entry }: { entry: Entry }) {
  const entries = useVaultStore((s) => s.entries);
  const askAgent = useUiStore((s) => s.askAgent);
  const concepts = useConcepts();
  const commit = useMemo(() => commitOf(entry, concepts), [entry, concepts]);
  const about = useMemo(
    () => conceptsAbout(entry.path, concepts, entries),
    [entry.path, concepts, entries],
  );
  const related = useMemo(
    () => (about.length > 0 ? [] : relatedConcepts(entry, concepts, entries)),
    [about.length, entry, concepts, entries],
  );
  // A concept that cites this page AND is anchored to it is about it, and
  // listed there once (M52.4, `knowledgeOf`'s rule) — the dossier carries its
  // review and its standing, which a learned-from row does not.
  const anchored = useMemo(() => new Set(about.map((c) => c.entry.path)), [about]);
  const learnedOnly = commit.concepts.filter((c) => !anchored.has(c.entry.path));
  // One read of the scheduler for the queued line AND the Learn button.
  const queue = useLearnQueued(entry);
  const learned = commit.concepts.length > 0 || queue.queued;
  const empty = !learned && about.length === 0 && related.length === 0;

  // The page travels WITH every ask (M17.6) as a context chip, and the bubble
  // names the act and the page rather than the prompt behind it.
  const [askBase, augment, distill] = pageKnowledgeAsks(entry);

  return (
    <div data-testid="page-knowledge" className="flex flex-col gap-3">
      {/* Always in the DOM, because `data-state` says whether the page was
          ever learned from; drawn only when there is something to read — a
          row the dossier below does not already hold, the queued line, or
          the line saying the base read an older version. The heading names
          rows, so it waits for one. */}
      <div hidden={!(learnedOnly.length > 0 || queue.queued || commit.state === 'behind')}>
        {learnedOnly.length > 0 && (
          <InspectorSubhead
            label="Learned from this page"
            count={relativeDay(commit.at, todayIso())}
          />
        )}
        <KnowledgeCommit entry={entry} variant="embedded" queue={queue} exclude={anchored} />
      </div>
      {about.length > 0 ? (
        <div>
          <InspectorSubhead label="About this page" />
          <EntityDossier entry={entry} variant="embedded" />
        </div>
      ) : (
        related.length > 0 && (
          <div>
            <InspectorSubhead label="Related to this page" />
            <RelatedKnowledge entry={entry} variant="embedded" />
          </div>
        )
      )}
      {empty && (
        <p data-testid="page-knowledge-empty" className="text-metadata text-n-400">
          Knowledge holds nothing about this page yet.
        </p>
      )}
      {/* Nothing yet is exactly when asking is most useful, so the asks stay
          on an empty page. Reading asks first; the one act that writes last,
          and held while the base is already reading this page. */}
      <InspectorActions label="Ask Knowledge">
        <InspectorAsk
          icon="sparkles"
          label={askBase.label}
          prompt={askBase.prompt}
          onAsk={sendAsk(askBase, askAgent)}
        />
        <InspectorAsk
          icon="sparkles"
          label={augment.label}
          prompt={augment.prompt}
          onAsk={sendAsk(augment, askAgent)}
        />
        <InspectorAsk
          icon="brain"
          label={distill.label}
          prompt={distill.prompt}
          disabled={queue.queued}
          title={
            queue.reading
              ? 'Knowledge is reading this page now.'
              : queue.queued
                ? 'Knowledge has this page queued to read.'
                : undefined
          }
          onAsk={sendAsk(distill, askAgent)}
        />
      </InspectorActions>
    </div>
  );
}
