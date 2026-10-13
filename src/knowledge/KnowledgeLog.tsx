import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { KNOWLEDGE_DIR, parseLog, type Concept, type LogEntry, type LogKind } from '@/engine/okf';
import { useConcepts } from '@/knowledge/useConcepts';
import { relativeDay } from '@/knowledge/KnowledgePanel';
import { readNote } from '@/lib/ipc';
import { todayIso } from '@/lib/templates';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The bundle's update log (M8.1).
 *
 * `knowledge/log.md` has existed since M5 and rendered nowhere, which meant
 * the one question a machine-written corpus has to answer — is this thing
 * actually learning anything — had no surface. A timeline answers it in the
 * shape it is asked: by date, by what kind of change, and by which concept
 * moved.
 *
 * It reads the file rather than deriving from frontmatter because the log is
 * the agent's own account of its work. Deriving it would replace what the
 * agent said it did with what we can infer it did, which is a different and
 * much weaker claim.
 */

const LOG_PATH = `${KNOWLEDGE_DIR}/log.md`;

const KIND_STYLE: Record<LogKind, { icon: string; color: string; label: string }> = {
  creation: { icon: 'sparkles', color: 'var(--cortex-500)', label: 'New' },
  update: { icon: 'pencil-line', color: 'var(--synapse-500)', label: 'Revised' },
  deprecation: { icon: 'archive', color: 'var(--n-400)', label: 'Deprecated' },
  verification: { icon: 'shield-check', color: 'var(--success-600)', label: 'Verified' },
  note: { icon: 'dot', color: 'var(--n-400)', label: '' },
};

/**
 * The word an entry leads with (M52.3). A deprecation whose concept something
 * newer has since retired reads "Replaced" — the tag its row under Concepts
 * wears — because "Deprecated" beside "was replaced by" said one change in
 * two vocabularies. The concept is the entry's first link into the bundle,
 * the one the entry is written about.
 */
function labelOf(entry: LogEntry, byPath: ReadonlyMap<string, Concept>): string {
  if (entry.kind !== 'deprecation') return KIND_STYLE[entry.kind].label;
  const subject = entry.links.find((link) => link.path !== null && byPath.has(link.path));
  const concept = subject?.path == null ? undefined : byPath.get(subject.path);
  return concept?.supersededBy != null ? 'Replaced' : KIND_STYLE.deprecation.label;
}

/** A day heading in the table's words — "today", "yesterday", "4d ago" — or,
 * for a heading that is no date, the heading as the log wrote it. */
function dayLabel(date: string, today: string): string {
  const label = /^\d{4}-\d{2}-\d{2}$/.test(date) ? relativeDay(date, today) : null;
  return label === null ? date : label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Entry prose with its markdown links promoted to real, clickable links. A
 * link to a concept reads as the concept's title NOW (M52.5): the log keeps
 * the words the agent wrote on the day, and "Warehouse cutover" beside a row
 * titled "Warehouse cutover: go-live and rollback" named one page twice. A
 * link to anything else keeps its own words.
 */
function EntryText({
  entry,
  byPath,
  onOpenConcept,
}: {
  entry: LogEntry;
  byPath: ReadonlyMap<string, Concept>;
  onOpenConcept: (path: string) => void;
}) {
  const parts = entry.text.split(/(\[[^\]^]+\]\([^)]+\))/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = /^\[([^\]^]+)\]\(([^)]+)\)$/.exec(part);
        if (match === null) return <span key={i}>{part}</span>;
        const link = entry.links.find((l) => l.label === match[1]);
        if (link?.url != null) {
          return (
            <a
              key={i}
              href={link.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-cortex-600 underline decoration-cortex-200 underline-offset-2"
            >
              {match[1]}
            </a>
          );
        }
        if (link?.path == null) return <span key={i}>{match[1]}</span>;
        const path = link.path;
        const title = byPath.get(path)?.title ?? match[1];
        return (
          <button
            key={i}
            type="button"
            data-testid="log-concept-link"
            data-path={path}
            // What the log itself wrote, where it differs, one hover away.
            title={title === match[1] ? undefined : `Logged as "${match[1]}"`}
            onClick={() => onOpenConcept(path)}
            className="cursor-pointer border-0 bg-transparent p-0 text-sm text-cortex-600 underline decoration-cortex-200 underline-offset-2 hover:decoration-cortex-500"
          >
            {title}
          </button>
        );
      })}
    </>
  );
}

export function KnowledgeLog({ onOpenConcept }: { onOpenConcept: (path: string) => void }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  // The log's own scan entry: whether it exists at all, and its stamp, so a
  // new entry re-reads the log (M49.6, K27) instead of waiting for a remount.
  const logStamp = useVaultStore(
    (s) => s.entries.find((e) => e.path === LOG_PATH)?.modifiedAt ?? null,
  );
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const concepts = useConcepts();
  const byPath = useMemo(() => new Map(concepts.map((c) => [c.entry.path, c])), [concepts]);

  useEffect(() => {
    if (vaultPath === null) return;
    let cancelled = false;
    readNote(vaultPath, LOG_PATH)
      .then((text) => {
        if (cancelled) return;
        setMarkdown(text);
        setUnavailable(false);
      })
      .catch(() => {
        if (cancelled) return;
        // A bundle with no log yet is not an error — it is a bundle nobody
        // has written to. A log the scan FOUND and the read could not open
        // is: "Nothing logged yet" would be a claim about this vault that
        // nothing here can make (M49.6, K27).
        if (logStamp === null) {
          setMarkdown('');
          setUnavailable(false);
        } else {
          setMarkdown(null);
          setUnavailable(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath, logStamp]);

  const days = markdown === null ? [] : parseLog(markdown);
  const today = todayIso();

  // A section of Activity since M51 — it was a tab of its own, with a page
  // title and its own scroll, and the page around it now owns both.
  const heading = (
    <>
      <h2 className="m-0 text-sm font-semibold text-n-800">Update log</h2>
      <p className="mb-3 mt-1 text-xs text-n-500">
        What agents have learned, and when. Every entry names the concept it touched.
      </p>
    </>
  );

  if (unavailable) {
    return (
      <section data-testid="knowledge-log">
        {heading}
        <p data-testid="section-unavailable" className="text-xs text-n-500">
          The update log could not be read, so nothing here is a statement about what has been
          learned.
        </p>
      </section>
    );
  }

  if (markdown !== null && days.length === 0) {
    return (
      <section data-testid="knowledge-log">
        {heading}
        <EmptyState
          icon="history"
          title="Nothing logged yet"
          description="When an agent creates or revises a concept it records the change here, with what it read to make it."
        />
      </section>
    );
  }

  return (
    <section data-testid="knowledge-log">
      <div>
        {heading}

        {days.map((day) => (
          <section key={day.date} data-testid="log-day" className="mb-5">
            <div className="sticky top-0 flex items-center gap-2 bg-n-0 pb-2 pt-1">
              {/* The day as the Concepts table's Updated says it (M52.5) —
                  "yesterday", "4d ago" — and the date itself on hover. */}
              <time
                dateTime={day.date}
                title={day.date}
                className="text-xs font-semibold tabular-nums text-n-700"
              >
                {dayLabel(day.date, today)}
              </time>
              <span className="h-px flex-1 bg-n-100" />
            </div>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {day.entries.map((entry, i) => {
                const style = KIND_STYLE[entry.kind];
                const label = labelOf(entry, byPath);
                return (
                  <li
                    key={i}
                    data-testid="log-entry"
                    data-kind={entry.kind}
                    className="flex gap-2.5"
                  >
                    <span className="mt-[3px] flex-none">
                      <Icon name={style.icon} size={14} color={style.color} />
                    </span>
                    <span className="min-w-0 flex-1">
                      {label !== '' && (
                        <span
                          data-testid="log-entry-label"
                          className="mr-1.5 text-xs font-semibold"
                          style={{ color: style.color }}
                        >
                          {label}
                        </span>
                      )}
                      <span className="text-sm leading-[20px] text-n-700">
                        <EntryText entry={entry} byPath={byPath} onOpenConcept={onOpenConcept} />
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}
