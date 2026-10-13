import { useEffect, useMemo, useState } from 'react';
import { useLedgerReview, useQuarantine } from '@/stores/ledgerStore';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { isBeingRead } from '@/agent/runs';
import { commitOf, listConcepts, type CommitState } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { relativeDay } from '@/knowledge/KnowledgePanel';
import { ingestItemState } from '@/lib/ipc';
import { askedAbout, DISTILL_LABEL, distillPrompt } from '@/lib/prompts';
import { todayIso } from '@/lib/templates';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Whether THIS note has been committed to the knowledge base, and the button
 * that commits it (M8.5).
 *
 * Two things were wrong before. Distilling was reachable only from the Inbox,
 * so a note that arrived any other way — written in place, filed months ago,
 * fetched by a connector — could never be learned from, which quietly meant
 * the base could only ever grow from the newest thing you dropped in. And
 * nothing anywhere said what the base had already taken, so committing felt
 * like shouting into a folder.
 *
 * So this lives beside the note rather than in one screen, and it always
 * answers the same question first: what did the vault keep from this? The
 * answer is read out of the bundle's own `sources`, so it is the concepts
 * themselves saying where they came from.
 */

const HEADINGS: Record<CommitState, { icon: string; color: string; label: string }> = {
  uncommitted: { icon: 'circle-dashed', color: 'var(--n-400)', label: 'Not in Knowledge' },
  committed: { icon: 'circle-check', color: 'var(--success-600)', label: 'In Knowledge' },
  behind: { icon: 'clock-alert', color: 'var(--warn-600)', label: 'Edited since it was learned' },
};

/** Whether a note is waiting to be read by the base, and whether the read is
 *  under way now — see `useLearnQueued`. */
export interface LearnQueue {
  queued: boolean;
  reading: boolean;
}

/**
 * Outstanding for THIS note only, asked by path — never "is the queue
 * non-empty", which would report every note in the vault as queued the moment
 * anything was.
 *
 * M26.4j: the answer comes from the durable ingest scheduler rather than from
 * a queue re-derived in the renderer. The old version could only ever see
 * work the UI itself had recorded, so a note edited in an external editor
 * never showed as queued no matter how certainly it was. `null` — an
 * unscanned vault, or ambient ingest never turned on — reads as not queued,
 * which is true.
 *
 * A hook of its own since M52.3: the page's Knowledge draws the queued line
 * and disables its Learn button from ONE read. A null entry asks nothing — the
 * section a host already asked for is handed the answer instead.
 */
export function useLearnQueued(entry: Entry | null): LearnQueue {
  const path = entry?.path ?? null;
  const modifiedAt = entry?.modifiedAt ?? null;
  const reading = useUiStore((s) => path !== null && isBeingRead(s.runs, path));
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const [scheduled, setScheduled] = useState(false);
  useEffect(() => {
    if (vaultPath === null || path === null) return;
    let live = true;
    void ingestItemState(vaultPath, path)
      .then((row) => {
        if (live) setScheduled(row !== null && row.route === 'm26_queued');
      })
      // A scheduler we cannot read is not a scheduler saying "queued". The
      // chip is an aside on a panel that has already rendered; it never gets
      // to put an error on the screen.
      .catch(() => {
        if (live) setScheduled(false);
      });
    return () => {
      live = false;
    };
  }, [path, modifiedAt, vaultPath]);
  return { queued: path !== null && (reading || scheduled), reading };
}

export function KnowledgeCommit({
  entry,
  variant = 'panel',
  queue,
  exclude,
}: {
  entry: Entry;
  /**
   * 'section' sits in a page; 'panel' is the narrower side-panel variant.
   * 'embedded' is one group of a page's Knowledge (M52.3, `PageKnowledge`):
   * the rows and the lines about them, and nothing the host already says —
   * no heading, no empty sentence, no Learn button.
   */
  variant?: 'section' | 'panel' | 'embedded';
  /** The host's read of `useLearnQueued`, so one note is asked about once. */
  queue?: LearnQueue;
  /**
   * Embedded only: concept paths the host already lists (M52.4 — the ones
   * anchored to this page, in its dossier), left out of the rows. The state
   * and the count stay the whole commit's: the page was learned from either
   * way.
   */
  exclude?: ReadonlySet<string>;
}) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const askAgent = useUiStore((s) => s.askAgent);

  const quarantine = useQuarantine();
  const ledgerReview = useLedgerReview();
  const today = todayIso();
  const commit = useMemo(
    () => commitOf(entry, listConcepts(entries, today, quarantine, ledgerReview)),
    [entry, entries, today, quarantine, ledgerReview],
  );

  const heading = HEADINGS[commit.state];
  const learned = relativeDay(commit.at, today);
  const own = useLearnQueued(queue === undefined ? entry : null);
  const { queued, reading } = queue ?? own;
  const embedded = variant === 'embedded';
  const rows =
    embedded && exclude !== undefined
      ? commit.concepts.filter((c) => !exclude.has(c.entry.path))
      : commit.concepts;

  const distill = () => {
    askAgent(
      distillPrompt(entry.path, entry.title),
      entry.path,
      askedAbout(DISTILL_LABEL, entry.title),
    );
  };

  return (
    <section
      data-testid="knowledge-commit"
      data-state={commit.state}
      data-count={commit.concepts.length}
      className={variant === 'section' ? 'mt-8 border-t border-n-100 pt-5' : ''}
    >
      {!embedded && (
        <div className="flex items-center gap-2">
          <Icon name={heading.icon} size={14} color={heading.color} />
          <h3 className="m-0 text-xs font-semibold uppercase tracking-[0.06em] text-n-500">
            {heading.label}
          </h3>
          {learned !== null && (
            <span className="[font-family:var(--font-mono)] text-2xs text-n-400">{learned}</span>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        !embedded && (
          <p className="m-0 mt-2 text-sm leading-[18px] text-n-500">
            Nothing has been distilled from this note yet.
          </p>
        )
      ) : (
        <ul className={`m-0 flex list-none flex-col gap-px p-0 ${embedded ? '' : 'mt-2'}`}>
          {rows.map((concept) => (
            <li key={concept.entry.path}>
              <button
                type="button"
                data-testid="committed-concept"
                data-path={concept.entry.path}
                onClick={() => navigate({ kind: 'doc', path: concept.entry.path })}
                className="flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1.5 text-left hover:bg-n-50"
              >
                <Icon name="brain" size={12} color="var(--cortex-500)" />
                <span className="min-w-0 flex-1 truncate text-sm text-n-800">{concept.title}</span>
                {concept.stale && <Icon name="clock-alert" size={11} color="var(--warn-600)" />}
              </button>
            </li>
          ))}
        </ul>
      )}

      {commit.state === 'behind' && (
        <p className="m-0 mt-1.5 px-2 text-xs leading-[16px] text-n-500">
          The bundle is still reading the version from {learned}.
        </p>
      )}

      {/* M8.6 — where "the base is working on it" is allowed to appear: on
          the note it concerns, while you are looking at it. Not a badge, not
          a toast, and it disappears on its own. */}
      {queued && (
        <p
          data-testid="learn-queued"
          className="m-0 mt-1.5 flex items-center gap-1.5 px-2 text-xs text-cortex-600"
        >
          {/* M15: it turns while a read is actually in flight. */}
          <span className={reading ? 'inline-flex animate-spin' : 'inline-flex'}>
            <Icon name="loader" size={11} />
          </span>
          {reading ? 'Reading this now' : 'Queued to be read'}
        </p>
      )}

      {!embedded && (
        <div className="mt-2.5">
          <Button
            variant={commit.state === 'committed' ? 'ghost' : 'secondary'}
            size="sm"
            icon="brain"
            disabled={queued}
            onClick={distill}
          >
            {DISTILL_LABEL}
          </Button>
        </div>
      )}
    </section>
  );
}
