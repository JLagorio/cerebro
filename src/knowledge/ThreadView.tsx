import React from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  readThread,
  recheckLine,
  type Concept,
  type Subject,
  type ThreadReading,
} from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { relativeDay } from '@/knowledge/KnowledgePanel';

/**
 * One subject, read as one thing (M33a.4; one list since M51).
 *
 * The reader's question is what Knowledge believes about this subject, so
 * the whole thread is read at once. M33a.4 answered it in five sections —
 * contested, stale, changed, known, sources — and every concept with a date
 * appeared in "changed" AND in whichever other section held it: the same
 * three concepts, printed seven times, under headings that were mostly
 * empty. The owner could not follow it.
 *
 * Now each concept appears ONCE, on the line that most changes what you would
 * do — contested first, then due a recheck, then newest writing — and the
 * findings the empty sections used to state stand in one sentence at the top
 * ("nothing contested" is still said out loud, it just no longer takes a
 * heading to say it). Every count is measured: undated and uncited concepts
 * are named, never absorbed.
 *
 * Reads nothing. Everything on screen is derived by `readThread` from the
 * bundle the page already holds, so there is no failure state to render.
 */

const HEADING = 'm-0 text-sm font-semibold text-n-800';

function Section({
  id,
  icon,
  title,
  children,
}: {
  id: string;
  icon: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid="thread-section" data-section={id} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Icon name={icon} size={13} color="var(--n-500)" />
        <h2 className={HEADING}>{title}</h2>
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

/** What a section says when it has nothing — a sentence, never a blank. */
function Nothing({ text }: { text: string }) {
  return (
    <p data-testid="thread-nothing" className="m-0 text-xs text-n-500">
      {text}
    </p>
  );
}

function ConceptLine({
  concept,
  trailing,
  tone = 'plain',
  onOpen,
}: {
  concept: Concept;
  /** The one fact this section is about — when it changed, what replaced it. */
  trailing?: string;
  tone?: 'plain' | 'warn';
  onOpen: (path: string) => void;
}) {
  return (
    <button
      type="button"
      data-testid="thread-concept"
      data-path={concept.entry.path}
      onClick={() => onOpen(concept.entry.path)}
      className="flex w-full min-w-0 flex-col gap-0.5 rounded-md border-0 bg-transparent px-2 py-1.5 text-left hover:bg-n-50"
    >
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium text-n-900">{concept.title}</span>
        <span className="text-2xs uppercase tracking-[0.04em] text-n-400">
          {concept.conceptType}
        </span>
        {trailing !== undefined && (
          <span className={`text-2xs ${tone === 'warn' ? 'text-warn-600' : 'text-n-500'}`}>
            {trailing}
          </span>
        )}
      </span>
      {/* M33a.0 made `description` a requirement; concepts written before it
          have none, and saying so is how that stays visible. */}
      <span className="text-xs leading-[17px] text-n-500">
        {concept.description ?? 'No description recorded.'}
      </span>
    </button>
  );
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

interface Line {
  concept: Concept;
  trailing: string;
  tone: 'plain' | 'warn';
}

/** Every concept once, on its most consequential line. */
function linesOf(reading: ThreadReading, today: string): Line[] {
  const lines: Line[] = [];
  const seen = new Set<string>();
  const push = (concept: Concept, trailing: string, tone: Line['tone']) => {
    if (seen.has(concept.entry.path)) return;
    seen.add(concept.entry.path);
    lines.push({ concept, trailing, tone });
  };
  for (const { concept, reason, others } of reading.contested) {
    const named = others.map((o) => o.title).join(', ');
    push(
      concept,
      reason === 'replaced'
        ? named === ''
          ? 'Replaced'
          : `Replaced by ${named}`
        : // Never resolved for you: which of two claims is right is the
          // judgement this whole model reserves for a person.
          `Disagrees with ${named}`,
      'warn',
    );
  }
  // How late, once — the line the review bar and the Knowledge table say.
  for (const concept of reading.stale) push(concept, recheckLine(concept, today), 'warn');
  for (const { concept, at } of reading.changed) {
    push(concept, `Written ${relativeDay(at, today) ?? at}`, 'plain');
  }
  // An absent `generated` stamp is NOT an old one, so these are said to be
  // unplaced rather than sorted to the bottom as if they were.
  for (const concept of reading.undated)
    push(concept, 'When it was written is not recorded', 'plain');
  return lines;
}

/** The findings, as one sentence: how much, what is in dispute, what is due. */
function summaryOf(subject: Subject, reading: ThreadReading): string {
  const parts = [plural(subject.concepts.length, 'concept', 'concepts')];
  parts.push(
    reading.contested.length === 0
      ? 'nothing contested'
      : `${reading.contested.length} contested or replaced`,
  );
  if (reading.stale.length > 0) parts.push(`${reading.stale.length} due a recheck`);
  return parts.join(' · ');
}

function Provenance({ reading }: { reading: ThreadReading }) {
  return (
    <Section id="thread-sources" icon="book-open" title="Where it came from">
      {reading.sources.length === 0 ? (
        <Nothing text="No concept in this thread cites a source." />
      ) : (
        reading.sources.map((source) => (
          <div
            key={source.resource}
            data-testid="thread-source"
            className="flex min-w-0 items-baseline gap-2 px-2 py-1"
          >
            <span className="min-w-0 flex-1 truncate text-xs text-n-700">
              {source.title ?? source.resource}
            </span>
            <span className="flex-none text-2xs text-n-500">
              cited by {plural(source.citedBy, 'concept', 'concepts')}
            </span>
          </div>
        ))
      )}
      {reading.uncited.length > 0 && (
        // Never folded into the totals above: a claim resting on nothing is
        // the fact a reading list most needs to admit.
        <p data-testid="thread-uncited" className="m-0 mt-1.5 text-xs text-n-500">
          {plural(
            reading.uncited.length,
            'concept in this thread cites',
            'concepts in this thread cite',
          )}{' '}
          no source at all.
        </p>
      )}
    </Section>
  );
}

export function ThreadView({
  subject,
  concepts,
  entries,
  today,
  onOpenConcept,
}: {
  subject: Subject;
  /**
   * The WHOLE bundle, not just the thread. An edge that leaves the subject is
   * still an edge — a concept contradicted from outside would otherwise hide
   * by crossing a boundary the reader cannot see.
   */
  concepts: Concept[];
  entries: Entry[];
  today: string;
  onOpenConcept: (path: string) => void;
}) {
  const reading = readThread(subject, concepts, entries);
  return (
    <div data-testid="thread-view" className="flex flex-col gap-5">
      <p data-testid="thread-summary" className="m-0 px-2 text-xs text-n-500">
        What Knowledge holds about {subject.label}: {summaryOf(subject, reading)}.
      </p>
      <div className="flex flex-col gap-0.5">
        {linesOf(reading, today).map((line) => (
          <ConceptLine
            key={line.concept.entry.path}
            concept={line.concept}
            trailing={line.trailing}
            tone={line.tone}
            onOpen={onOpenConcept}
          />
        ))}
      </div>
      <Provenance reading={reading} />
    </div>
  );
}
