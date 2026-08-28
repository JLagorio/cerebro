import React from 'react';
import { Icon } from '@/components/ui/Icon';
import { readThread, type Concept, type Subject, type ThreadReading } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { relativeDay } from '@/knowledge/KnowledgePanel';

/**
 * One subject, read as one thing (M33a.4).
 *
 * The Knowledge tab could open a thread and then show you a concept — the head
 * of a list, picked by filename. That answers "what is the first thing filed
 * under this", which is nobody's question. The reader's question is what the
 * base believes about this subject, and answering it means reading the whole
 * thread at once: what is in dispute, what has expired, what moved lately,
 * what is settled, and what any of it rests on.
 *
 * The order is deliberate and contested comes FIRST. A summary that leads with
 * what it is confident about, and mentions the disagreements at the bottom if
 * at all, is the confident-and-wrong shape that makes people stop trusting the
 * whole surface. Nothing here is a queue and nothing counts up at you: the
 * sections are findings, in the order they change what you would do.
 *
 * Every section renders even when it is empty, because "nothing is in dispute"
 * is a finding and omitting the heading turns it into silence. Every count is
 * measured — the concepts no timestamp could place and the concepts citing
 * nothing are carried out and named rather than absorbed, per the absence rule
 * in AGENTS.md.
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

function Contested({
  reading,
  onOpen,
}: {
  reading: ThreadReading;
  onOpen: (path: string) => void;
}) {
  return (
    <Section id="thread-contested" icon="git-compare" title="What's contested">
      {reading.contested.length === 0 ? (
        <Nothing text="Nothing in this thread is in dispute — no concept here has been replaced or contradicted." />
      ) : (
        reading.contested.map(({ concept, reason, others }) => {
          const named = others.map((o) => o.title).join(', ');
          return (
            <ConceptLine
              key={concept.entry.path}
              concept={concept}
              tone="warn"
              trailing={
                reason === 'replaced'
                  ? named === ''
                    ? 'No longer believed'
                    : `No longer believed — replaced by ${named}`
                  : // Never resolved for you: which of two claims is right is
                    // the judgement this whole model reserves for a person.
                    `Disagrees with ${named}`
              }
              onOpen={onOpen}
            />
          );
        })
      )}
    </Section>
  );
}

function Stale({
  reading,
  today,
  onOpen,
}: {
  reading: ThreadReading;
  today: string;
  onOpen: (path: string) => void;
}) {
  return (
    <Section id="thread-stale" icon="clock-alert" title="What's stale">
      {reading.stale.length === 0 ? (
        <Nothing text="Nothing here is past its recheck date." />
      ) : (
        reading.stale.map((concept) => {
          const since = relativeDay(concept.staleAfter, today);
          return (
            <ConceptLine
              key={concept.entry.path}
              concept={concept}
              tone="warn"
              trailing={`Due a recheck since ${concept.staleAfter}${since === null ? '' : ` · ${since}`}`}
              onOpen={onOpen}
            />
          );
        })
      )}
    </Section>
  );
}

function Changed({
  reading,
  today,
  onOpen,
}: {
  reading: ThreadReading;
  today: string;
  onOpen: (path: string) => void;
}) {
  const { changed, undated } = reading;
  return (
    <Section id="thread-changed" icon="activity" title="What changed">
      {changed.length === 0 ? (
        <Nothing text="No concept in this thread records when it was written." />
      ) : (
        changed.map(({ concept, at }) => (
          <ConceptLine
            key={concept.entry.path}
            concept={concept}
            trailing={relativeDay(at, today) ?? at}
            onOpen={onOpen}
          />
        ))
      )}
      {undated.length > 0 && (
        <>
          {/* Skipped, and said so. An absent `generated` stamp is NOT an old
              one, so these cannot be sorted into the list above without
              handing them a date they never carried. */}
          <p data-testid="thread-undated" className="m-0 mt-1.5 text-xs text-n-500">
            {plural(undated.length, 'concept is', 'concepts are')} not placed above: when{' '}
            {undated.length === 1 ? 'it was' : 'they were'} written is not recorded.
          </p>
          {undated.map((concept) => (
            <ConceptLine
              key={concept.entry.path}
              concept={concept}
              trailing="Written — not recorded"
              onOpen={onOpen}
            />
          ))}
        </>
      )}
    </Section>
  );
}

function Known({ reading, onOpen }: { reading: ThreadReading; onOpen: (path: string) => void }) {
  return (
    <Section id="thread-known" icon="brain" title="What's known">
      {reading.known.length === 0 ? (
        <Nothing text="Nothing here is settled: every concept in this thread is contested or stale." />
      ) : (
        reading.known.map((group) => (
          <div key={group.conceptType} className="flex flex-col gap-0.5 pt-1">
            <div className="px-2 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
              {group.conceptType}
            </div>
            {group.concepts.map((concept) => (
              <ConceptLine key={concept.entry.path} concept={concept} onOpen={onOpen} />
            ))}
          </div>
        ))
      )}
    </Section>
  );
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
      <p className="m-0 text-xs text-n-500">
        What the base holds about {subject.label}, in{' '}
        {plural(subject.concepts.length, 'concept', 'concepts')}.
      </p>
      <Contested reading={reading} onOpen={onOpenConcept} />
      <Stale reading={reading} today={today} onOpen={onOpenConcept} />
      <Changed reading={reading} today={today} onOpen={onOpenConcept} />
      <Known reading={reading} onOpen={onOpenConcept} />
      <Provenance reading={reading} />
    </div>
  );
}
