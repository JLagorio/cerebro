import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { commitOf, conceptsAbout, relatedConcepts } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { EntityDossier } from '@/knowledge/EntityDossier';
import { KnowledgeCommit, useLearnQueued } from '@/knowledge/KnowledgeCommit';
import { relativeDay } from '@/knowledge/KnowledgePanel';
import { RelatedKnowledge } from '@/knowledge/RelatedKnowledge';
import { useConcepts } from '@/knowledge/useConcepts';
import {
  ASK_BASE_LABEL,
  askBasePrompt,
  askedAbout,
  AUGMENT_LABEL,
  augmentDocPrompt,
  DISTILL_LABEL,
  distillPrompt,
} from '@/lib/prompts';
import { todayIso } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

function GroupLabel({ label, aside = null }: { label: string; aside?: string | null }) {
  return (
    <div className="mb-1 flex items-baseline gap-2 px-2">
      <span className="text-xs font-medium text-n-700">{label}</span>
      {aside !== null && (
        <span className="[font-family:var(--font-mono)] text-2xs text-n-400">{aside}</span>
      )}
    </div>
  );
}

/**
 * What Knowledge holds about one page, and the three things to ask of it
 * (M52.3) — one anatomy wherever a page is read. The record peek's Knowledge
 * section and a page's Knowledge tab both render exactly this.
 *
 * They were two stacks, each with its own heading, its own empty sentence and
 * its own Learn button, so one record could say "Not in Knowledge" above
 * "Nothing yet about this" in one place and something else in the other,
 * with two buttons that did the same thing. Now: two groups — what was
 * learned FROM the page, what the base holds ABOUT it — one sentence when
 * both are empty, and one row of asks.
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
  const ask = (label: string, text: string) =>
    askAgent(text, entry.path, askedAbout(label, entry.title));

  return (
    <div data-testid="page-knowledge" className="flex flex-col gap-3.5">
      {/* Always in the DOM, because `data-state` says whether the page was
          ever learned from; drawn only when there is something to read — a
          row the dossier below does not already hold, the queued line, or
          the line saying the base read an older version. The heading names
          rows, so it waits for one. */}
      <div hidden={!(learnedOnly.length > 0 || queue.queued || commit.state === 'behind')}>
        {learnedOnly.length > 0 && (
          <GroupLabel label="Learned from this page" aside={relativeDay(commit.at, todayIso())} />
        )}
        <KnowledgeCommit entry={entry} variant="embedded" queue={queue} exclude={anchored} />
      </div>
      {about.length > 0 ? (
        <div>
          <GroupLabel label="About this page" />
          <EntityDossier entry={entry} variant="embedded" />
        </div>
      ) : (
        related.length > 0 && (
          <div>
            <GroupLabel label="Related to this page" />
            <RelatedKnowledge entry={entry} variant="embedded" />
          </div>
        )
      )}
      {empty && (
        <p
          data-testid="page-knowledge-empty"
          className="m-0 px-2 text-sm leading-[18px] text-n-500"
        >
          Knowledge holds nothing about this page yet.
        </p>
      )}
      {/* Nothing yet is exactly when asking is most useful, so the row stays
          on an empty page. Reading asks first; the one act that writes last,
          and held while the base is already reading this page. */}
      <div className="flex flex-wrap items-center gap-1.5 px-1">
        <Button
          variant="secondary"
          size="sm"
          icon="sparkles"
          onClick={() => ask(ASK_BASE_LABEL, askBasePrompt(entry.path, entry.title))}
        >
          {ASK_BASE_LABEL}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon="sparkles"
          onClick={() => ask(AUGMENT_LABEL, augmentDocPrompt(entry.path, entry.title))}
        >
          {AUGMENT_LABEL}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon="brain"
          disabled={queue.queued}
          onClick={() => ask(DISTILL_LABEL, distillPrompt(entry.path, entry.title))}
        >
          {DISTILL_LABEL}
        </Button>
      </div>
    </div>
  );
}
