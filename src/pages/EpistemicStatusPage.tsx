import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import * as ipc from '@/lib/ipc';
import type { ChangesView, LanesView, LaneView, PipelineOverview, ReviewCard } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Epistemic Status — one coherent home for what this base knows about
 * itself (M27.8c, §35 skeleton).
 *
 * **Why one page and not six banners.** M25, M26 and M27 each produce
 * something a person needs to see occasionally and nothing that should
 * interrupt them. Shipped separately those become six pieces of chrome
 * competing for the top of the screen, and the M8 rule — nothing speaks
 * first — dies by accretion rather than by decision. A destination they can
 * choose to open is the shape that keeps it.
 *
 * **Nothing here computes an epistemic answer.** Lane names, the sentence
 * under each lane, the reason on every item and every line of what changed
 * arrive composed from Rust, beside the rules that produced them. This file
 * chooses layout and says the empty cases out loud.
 *
 * **Four sections, four independent failures.** The feeds are deliberately
 * separate calls: a vault with no ledger can still show its review queue and
 * its budget, and a section whose read failed says so instead of rendering
 * the empty state. "Nothing is contested" and "we could not tell you whether
 * anything is contested" are opposite sentences.
 *
 * **No counts in the rail.** A badge here would be the chrome nagging
 * somebody to drain a queue — the same rule that kept a review count off
 * Knowledge (M8.1) and a commit count off History (M9.4).
 */

/** One feed's three states. `loading` is distinct from `unavailable` so a
 * slow read never renders as a refusal. */
type Feed<T> = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; data: T };

function useFeed<T>(vaultPath: string | null, read: (vault: string) => Promise<T>): Feed<T> {
  const [feed, setFeed] = useState<Feed<T>>({ kind: 'loading' });
  useEffect(() => {
    if (vaultPath === null) {
      setFeed({ kind: 'unavailable' });
      return;
    }
    let live = true;
    setFeed({ kind: 'loading' });
    void (async () => {
      try {
        const data = await read(vaultPath);
        if (live) setFeed({ kind: 'ready', data });
      } catch {
        // A read behind a surface goes quiet rather than toasting (the
        // store-layer rule in AGENTS.md), and the section says what it could
        // not find out. Nothing is retried on a timer: this page speaks when
        // it is opened and never on its own.
        if (live) setFeed({ kind: 'unavailable' });
      }
    })();
    return () => {
      live = false;
    };
    // `read` is in the deps rather than suppressed. Every call site passes a
    // module-level IPC function, so it is stable; an inline lambda would
    // re-fetch on every render, which is a defect this dependency makes loud
    // instead of hiding.
  }, [vaultPath, read]);
  return feed;
}

function Section({
  id,
  title,
  blurb,
  protectedLane = false,
  children,
}: {
  id: string;
  title: string;
  blurb?: string;
  protectedLane?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section data-testid="status-section" data-section={id} className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-n-800">{title}</h2>
        {/* §33 made visible. The guarantee that no preference can hide this
            lane is worth more on screen than in a comment. */}
        {protectedLane && (
          <span
            data-testid="protected-badge"
            className="rounded px-1.5 py-0.5 text-2xs uppercase tracking-[0.06em] text-n-500"
            style={{ border: '1px solid var(--n-200)' }}
            title="Always shown. No preference can hide this."
          >
            always shown
          </span>
        )}
      </div>
      {blurb !== undefined && <p className="text-xs text-n-500">{blurb}</p>}
      <div className="flex flex-col gap-1.5 pt-0.5">{children}</div>
    </section>
  );
}

/** What a section says when its read did not come back. Never the empty
 * state: a page that renders "no contradictions" over a failed read is
 * telling somebody something it does not know. */
function Unavailable({ what }: { what: string }) {
  return (
    <p data-testid="section-unavailable" className="text-xs text-n-500">
      {what} could not be read, so nothing here is a statement about this vault.
    </p>
  );
}

function Quiet({ text }: { text: string }) {
  return (
    <p data-testid="section-empty" className="text-xs text-n-500">
      {text}
    </p>
  );
}

function Loading() {
  return <p className="text-xs text-n-400">Reading…</p>;
}

/** The title of a lane row: the file if one projects this belief, the entity
 * otherwise. A belief id would be honest and unreadable. */
function titleOf(item: { path: string | null; entity_id: string }): string {
  return item.path ?? item.entity_id;
}

function Lane({ lane }: { lane: LaneView }) {
  return (
    <Section id={lane.id} title={lane.label} blurb={lane.blurb} protectedLane={lane.protected}>
      {lane.items.length === 0 ? (
        <Quiet text={lane.empty_text} />
      ) : (
        lane.items.map((item) => (
          <div
            key={`${item.belief_id}:${item.predicate ?? ''}:${item.edge_id ?? item.relation_id ?? ''}`}
            data-testid="lane-item"
            data-lane={lane.id}
            data-reasons={item.reasons.join(' ')}
            className="flex flex-col gap-0.5 rounded border border-n-200 px-2.5 py-2"
          >
            <span className="truncate text-xs font-medium text-n-800">{titleOf(item)}</span>
            <span className="text-2xs text-n-600">
              {item.scope_text === null
                ? item.reason_text
                : `${item.scope_text} — ${item.reason_text}`}
            </span>
            {item.reliance_text !== null && (
              <span className="text-2xs text-n-500">{item.reliance_text}</span>
            )}
          </div>
        ))
      )}
      {lane.withheld > 0 && (
        <p data-testid="lane-withheld" className="text-2xs text-n-500">
          {lane.withheld} more held back by a preference.
        </p>
      )}
    </Section>
  );
}

function Changes({ feed }: { feed: Feed<ChangesView> }) {
  if (feed.kind === 'loading') return <Loading />;
  if (feed.kind === 'unavailable') return <Unavailable what="What changed" />;
  const view = feed.data;
  if (view.quiet) {
    return <Quiet text="Nothing has changed since the last time anybody looked." />;
  }
  return (
    <>
      {view.sections
        // A quiet section inside a loud window is not news. The window-level
        // "nothing changed" above is the sentence that has to be said out
        // loud; repeating it five times would bury the two lines that moved.
        .filter((section) => section.lines.length > 0)
        .map((section) => (
          <div key={section.id} data-testid="change-section" data-change={section.id}>
            <span className="text-2xs uppercase tracking-[0.06em] text-n-500">{section.label}</span>
            {section.lines.map((line, index) => (
              <p
                key={`${line.belief_id ?? line.entity_id ?? ''}:${index}`}
                data-testid="change-line"
                className="text-xs text-n-700"
              >
                {line.entity_id ?? line.belief_id ?? ''} {line.text}
              </p>
            ))}
          </div>
        ))}
    </>
  );
}

/** The M24 queue, as a count and a door — not as cards. The cards live on
 * the review page, which knows how to decide them; a second rendering here
 * would be a second place for the decision UI to drift. */
function NeedsReview({ feed }: { feed: Feed<ReviewCard[]> }) {
  const navigate = useNavStore((s) => s.navigate);
  if (feed.kind === 'loading') return <Loading />;
  if (feed.kind === 'unavailable') return <Unavailable what="The review queue" />;
  const cards = feed.data;
  const urgent = cards.filter(
    (card) => card.effective_risk === 'HIGH' || card.effective_risk === 'CRITICAL',
  ).length;
  if (cards.length === 0) return <Quiet text="Nothing is waiting on a decision." />;
  return (
    <button
      type="button"
      data-testid="review-summary"
      data-urgent={urgent}
      onClick={() => navigate({ kind: 'review' })}
      className="flex w-full items-center justify-between rounded border border-n-200 px-2.5 py-2 text-left hover:bg-n-50"
    >
      <span className="text-xs text-n-800">
        {cards.length === 1 ? '1 card is' : `${cards.length} cards are`} waiting on a decision
        {urgent > 0 && `, ${urgent} at HIGH or CRITICAL`}
      </span>
      <Icon name="chevron-right" size={14} color="var(--n-500)" />
    </button>
  );
}

/** M25's health, as the two facts that change what a reader should expect
 * from the rest of this page: whether the background is running at all, and
 * whether it has anything left to spend. */
function SystemHealth({ feed }: { feed: Feed<PipelineOverview> }) {
  const navigate = useNavStore((s) => s.navigate);
  if (feed.kind === 'loading') return <Loading />;
  if (feed.kind === 'unavailable') return <Unavailable what="Background health" />;
  const overview = feed.data;
  const held = overview.held.baseline_held + overview.held.recovery_held + overview.held.pending;
  return (
    <button
      type="button"
      data-testid="health-summary"
      data-paused={overview.global_pause}
      data-ceiling={overview.meter.ceiling_state}
      onClick={() => navigate({ kind: 'pipeline' })}
      className="flex w-full items-center justify-between rounded border border-n-200 px-2.5 py-2 text-left hover:bg-n-50"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-xs text-n-800">
          {overview.global_pause ? 'The background is paused.' : 'The background is running.'}
        </span>
        <span className="text-2xs text-n-500">
          {/* `accounting_state` is the one that matters: a day whose spend was
              lost is not a day with budget left, and saying "under budget"
              over an unknown meter would be the page inventing good news. */}
          {overview.meter.accounting_state === 'exact'
            ? `Today's spend: ${overview.meter.ceiling_state.replaceAll('_', ' ')}.`
            : "Today's spend is not fully accounted for."}
          {held > 0 && ` ${held} item${held === 1 ? '' : 's'} held.`}
          {overview.banners.length > 0 && ` ${overview.banners.length} open notice.`}
        </span>
      </span>
      <Icon name="chevron-right" size={14} color="var(--n-500)" />
    </button>
  );
}

function Lanes({ feed }: { feed: Feed<LanesView> }) {
  if (feed.kind === 'loading') return <Loading />;
  if (feed.kind === 'unavailable') {
    return (
      <Section id="lanes-unavailable" title="Contradictions, gaps, staleness and debt">
        <Unavailable what="The attention lanes" />
      </Section>
    );
  }
  const view = feed.data;
  return (
    <>
      {view.lanes.map((lane) => (
        <Lane key={lane.id} lane={lane} />
      ))}
      {view.incomplete.map((sentence) => (
        <p key={sentence} data-testid="lanes-incomplete" className="text-2xs text-warn-700">
          {sentence}
        </p>
      ))}
    </>
  );
}

export function EpistemicStatusPage() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const changes = useFeed(vaultPath, ipc.converge);
  const lanes = useFeed(vaultPath, ipc.attentionLanes);
  const review = useFeed(vaultPath, ipc.reviewQueue);
  const health = useFeed(vaultPath, ipc.pipelineOverview);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-testid="status-page">
      <div className="mx-auto flex w-full min-w-0 max-w-[720px] flex-col gap-6 px-5 py-4">
        <div className="flex items-center gap-2">
          <Icon name="brain" size={16} color="var(--n-600)" />
          <h1 className="text-sm font-semibold text-n-800">Epistemic status</h1>
        </div>

        <Section
          id="changed"
          title="What changed"
          blurb="Since the last time anybody looked at this."
        >
          <Changes feed={changes} />
        </Section>

        <Lanes feed={lanes} />

        <Section
          id="needs-review"
          title="Needs review"
          blurb="What the base wants to change and is waiting for you to decide."
        >
          <NeedsReview feed={review} />
        </Section>

        <Section
          id="health"
          title="Background"
          blurb="Whether anything is running, and what it has left to spend."
        >
          <SystemHealth feed={health} />
        </Section>
      </div>
    </div>
  );
}
