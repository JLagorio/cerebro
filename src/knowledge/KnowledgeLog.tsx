import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { KNOWLEDGE_DIR, parseLog, type LogEntry, type LogKind } from '@/engine/okf';
import { readNote } from '@/lib/ipc';
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

/** Entry prose with its markdown links promoted to real, clickable links. */
function EntryText({
  entry,
  onOpenConcept,
}: {
  entry: LogEntry;
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
              className="text-[var(--cortex-600)] underline decoration-[var(--cortex-200)] underline-offset-2"
            >
              {match[1]}
            </a>
          );
        }
        if (link?.path == null) return <span key={i}>{match[1]}</span>;
        const path = link.path;
        return (
          <button
            key={i}
            type="button"
            data-testid="log-concept-link"
            onClick={() => onOpenConcept(path)}
            className="cursor-pointer border-0 bg-transparent p-0 text-[13px] text-[var(--cortex-600)] underline decoration-[var(--cortex-200)] underline-offset-2 hover:decoration-[var(--cortex-500)]"
          >
            {match[1]}
          </button>
        );
      })}
    </>
  );
}

export function KnowledgeLog({ onOpenConcept }: { onOpenConcept: (path: string) => void }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const [markdown, setMarkdown] = useState<string | null>(null);

  useEffect(() => {
    if (vaultPath === null) return;
    let cancelled = false;
    readNote(vaultPath, LOG_PATH)
      .then((text) => {
        if (!cancelled) setMarkdown(text);
      })
      // A bundle with no log yet is not an error — it is a bundle nobody has
      // written to.
      .catch(() => {
        if (!cancelled) setMarkdown('');
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

  const days = markdown === null ? [] : parseLog(markdown);

  if (markdown !== null && days.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          icon="history"
          title="Nothing logged yet"
          description="When the assistant creates or revises a concept it records the change here, with what it read to make it."
        />
      </div>
    );
  }

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-10 pt-6" data-testid="knowledge-log">
      <div className="mx-auto w-full max-w-[720px] px-6">
        <h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em] text-[var(--n-900)]">
          Update log
        </h1>
        <p className="mb-6 mt-1.5 text-[13px] leading-[19px] text-[var(--n-600)]">
          What the assistant has learned, and when. Every entry names the concept it touched.
        </p>

        {days.map((day) => (
          <section key={day.date} data-testid="log-day" className="mb-5">
            <div className="sticky top-0 flex items-center gap-2 bg-[var(--n-0)] pb-2 pt-1">
              <span className="text-[12px] font-semibold tabular-nums text-[var(--n-700)]">
                {day.date}
              </span>
              <span className="h-px flex-1 bg-[var(--n-100)]" />
            </div>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {day.entries.map((entry, i) => {
                const style = KIND_STYLE[entry.kind];
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
                      {style.label !== '' && (
                        <span
                          className="mr-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em]"
                          style={{ color: style.color }}
                        >
                          {style.label}
                        </span>
                      )}
                      <span className="text-[13px] leading-[20px] text-[var(--n-700)]">
                        <EntryText entry={entry} onOpenConcept={onOpenConcept} />
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
