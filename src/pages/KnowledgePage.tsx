import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import {
  folderLabel,
  listSections,
  listSubjects,
  reviewQueue,
  type QueuedConcept,
} from '@/engine/okf';
import { agentRef, isAgentEntry } from '@/engine/agents';
import type { KnowledgeNav, Selection } from '@/engine/types';
import { NewRecordDialog } from '@/app/CreateMenu';
import { useOpenPath } from '@/app/useOpenPath';
import { todayIso } from '@/lib/templates';
import {
  AgentWork,
  Background,
  DeferralGates,
  WaitingOnYou,
  WhatChanged,
  WhatsContested,
} from '@/knowledge/BaseItself';
import { KnowledgeLog } from '@/knowledge/KnowledgeLog';
import { ConceptTable, ReviewQueueList } from '@/knowledge/ConceptTable';
import { clearReviewWalk, useReviewStart } from '@/knowledge/ReviewQueue';
import { ThreadView } from '@/knowledge/ThreadView';
import { useConcepts } from '@/knowledge/useConcepts';
import { proposalsByPath, usePendingCards } from '@/knowledge/usePendingCards';
import type { ReviewCard } from '@/lib/ipc';
import { DocPage } from '@/pages/DocPage';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { VIEW_TAB_STRIP, viewTabClass } from '@/views/ViewTabs';

/**
 * Knowledge (M5, M8.1; rebuilt as lists in M50, three tabs in M51, tables in
 * M52.5) — what agents have learned about this vault, and what that learning
 * knows about itself.
 *
 * `knowledge/` is an OKF bundle agents write and people verify. A concept is
 * a PAGE (M50.1): it opens in the same canvas, editor and side panel as any
 * page, with its review in a bar under its title, and an in-app edit is
 * captured as the person's own (M23.7). This surface is the way into the
 * bundle, in three tabs a reader can follow (M51):
 *
 * - **Concepts** — everything, filed by folder; a sidebar folder row narrows
 *   it to one.
 * - **Review** — what waits for a person, each row saying why, in the order
 *   to work it; then the changes agents proposed and queued for a decision.
 * - **Activity** — what changed, what Knowledge is unsure of, the update log,
 *   and (folded away) the machinery: background work and deferral gates.
 *
 * It had eight tabs (M50.5), inherited from the Status hub, half of them
 * bookkeeping a reader never asked for; the owner, 2026-09-29: "still bad
 * and hard to follow".
 */

type Tab = 'all' | 'review' | 'activity';

/** A body that is read rather than scanned sits on the page's 20px edge; the
 * tables — Concepts, and Review's queue — run flush under the tab strip
 * instead, as a view's does. */
const PADDED = 'px-5 pb-10 pt-4';

/** Which tab a nav lights. A folder is a filter of Concepts; a subject and a
 * run deep link are no tab at all. */
function tabOf(nav: KnowledgeNav): Tab | null {
  if (nav.tab === 'all' || nav.tab === 'section') return 'all';
  if (nav.tab === 'review' || nav.tab === 'activity') return nav.tab;
  return null;
}

export function KnowledgePage({
  selection,
}: {
  selection: Extract<Selection, { kind: 'knowledge' }>;
}) {
  // A deep link to ONE concept (M8.3, still carried by older links and
  // history) is that concept's page now (M50.1).
  if (selection.path !== undefined) {
    return <DocPage selection={{ kind: 'doc', path: selection.path }} />;
  }
  return <KnowledgeLists nav={selection.nav} />;
}

/** Review — what waits for a person, then what agents queued for a decision.
 * Concepts lead because the count on the tab and in the sidebar is theirs.
 *
 * One measure for the whole tab (M52.5): the queue runs edge to edge as
 * Concepts does, under a band that names it, and the cards beneath it fill
 * the same width in a grid. It was a 1,700px table over 880px cards, a
 * ragged right edge and 800px of nothing beside them.
 *
 * A row whose concept also has a queued card marks it (M52.2); the cards
 * themselves stay whole under Waiting on you, and a queue that could not be
 * read marks no row — that section says it could not tell. */
function ReviewBody({
  vaultPath,
  queue,
  proposals,
}: {
  vaultPath: string | null;
  queue: QueuedConcept[];
  proposals: ReadonlyMap<string, readonly ReviewCard[]> | undefined;
}) {
  return (
    <div className="flex flex-col">
      <section data-testid="review-to-verify">
        {queue.length === 0 ? (
          <div className="px-5 pt-4">
            <h2 className="m-0 text-sm font-semibold text-n-800">To verify</h2>
            <div className="flex justify-center py-10">
              <EmptyState
                icon="shield-check"
                title="Everything is reviewed"
                description="No concept is waiting for a person to verify it."
              />
            </div>
          </div>
        ) : (
          <ReviewQueueList queue={queue} proposals={proposals} />
        )}
      </section>
      <div className="px-5 pb-10 pt-8">
        <WaitingOnYou vaultPath={vaultPath} />
      </div>
    </div>
  );
}

/** Activity — what moved and what Knowledge is unsure of; the machinery
 * behind it folded under System, where it waits for whoever wants it. */
function ActivityBody({
  vaultPath,
  onOpenConcept,
}: {
  vaultPath: string | null;
  onOpenConcept: (path: string) => void;
}) {
  const [systemOpen, setSystemOpen] = useState(false);
  return (
    <div className={`flex flex-col gap-8 ${PADDED}`}>
      <WhatChanged vaultPath={vaultPath} />
      <WhatsContested vaultPath={vaultPath} />
      <KnowledgeLog onOpenConcept={onOpenConcept} />
      <details
        data-testid="knowledge-system"
        className="group"
        onToggle={(e) => setSystemOpen(e.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-semibold text-n-800">
          <Icon
            name="chevron-right"
            size={14}
            color="var(--n-400)"
            className="transition-transform group-open:rotate-90"
          />
          System
          {/* A sentence, as every blurb on the page (M52.5): "background
              work, budgets and deferral gates" was three nouns of jargon. */}
          <span className="text-xs font-normal text-n-500">
            What runs in the background, what it may spend, and what is held back.
          </span>
        </summary>
        {/* Mounted when opened: each section reads its own feed, and a
            folded one has no business reading anything. */}
        {systemOpen && (
          <div className="mt-4 flex flex-col gap-8">
            <Background vaultPath={vaultPath} />
            <DeferralGates vaultPath={vaultPath} />
          </div>
        )}
      </details>
    </div>
  );
}

function KnowledgeLists({ nav: asked }: { nav: KnowledgeNav | undefined }) {
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const navigate = useNavStore((s) => s.navigate);
  const openPath = useOpenPath();
  // The D1 boundary, as UI state: the agent never creates a workspace record,
  // so this flag can only be raised by a click. See the header button.
  const [promoting, setPromoting] = useState(false);

  // M35.3 — who maintains this. Resolved by CAPABILITY, never by slug or
  // title: `capabilities: knowledge` is what hands an agent the bundle's
  // conventions (M34.1.3), so it is also what earns the byline.
  const maintainer = useMemo(() => {
    const record = entries.find(
      (e) => isAgentEntry(e) && agentRef(e).capabilities.includes('knowledge'),
    );
    return record === undefined ? null : { actor: agentRef(record).actor, title: record.title };
  }, [entries]);

  const today = todayIso();
  const all = useConcepts();
  const sections = useMemo(() => listSections(all), [all]);
  const queue = useMemo(() => reviewQueue(all), [all]);
  const nav: KnowledgeNav = asked ?? { tab: 'all' };
  // A subject is a deep link from before M51 — no row or tab leads there now.
  const subjects = useMemo(
    () => (nav.tab === 'entity' ? listSubjects(all, entries) : []),
    [nav.tab, all, entries],
  );
  const subject = nav.tab === 'entity' ? (subjects.find((s) => s.key === nav.key) ?? null) : null;
  const folder = nav.tab === 'section' ? nav.folder : null;
  const section = folder === null ? null : (sections.find((s) => s.folder === folder) ?? null);
  const tab = tabOf(nav);
  // What the header counts and Start review walks: the folder a view narrows
  // to, else the whole bundle.
  const filed = useMemo(
    () => (folder === null ? undefined : all.filter((c) => c.section === folder)),
    [all, folder],
  );
  // A folder's Start review is a walk of that folder: the pager counts it
  // and stops at its last concept (M52.5).
  const { waiting, start } = useReviewStart(
    all,
    filed,
    folder === null
      ? undefined
      : {
          label: section?.label ?? folderLabel(folder),
          back: { kind: 'knowledge', nav: { tab: 'section', folder } },
        },
  );
  // Arriving here is leaving any walk: what is opened from here starts its
  // own — a Review-tab row, or the unscoped Start review, the whole queue's.
  useEffect(() => clearReviewWalk(), []);
  // M52.2 — a row whose concept has a card waiting says so. Read once here
  // for both tables; a queue that could not be read marks no row.
  const pending = usePendingCards(vaultPath);
  const proposals = useMemo(
    () => (pending.kind === 'ready' ? proposalsByPath(pending.data) : undefined),
    [pending],
  );
  // How many cards wait on a decision, of this view: every one, or those
  // naming a concept in the folder. Null when the queue could not be read —
  // never 0, which would say "nothing waits".
  const proposalCount = useMemo(() => {
    if (pending.kind !== 'ready') return null;
    if (filed === undefined) return pending.data.length;
    const here = new Set(filed.map((c) => c.entry.path));
    return pending.data.filter((card) =>
      card.targets.some((t) => t.path != null && here.has(t.path)),
    ).length;
  }, [pending, filed]);

  const openConcept = (path: string) => navigate({ kind: 'doc', path });
  const openFolder = (at: string) =>
    navigate({ kind: 'knowledge', nav: { tab: 'section', folder: at } });

  // The crumb after "Knowledge": the folder or subject a view narrows to.
  const crumb =
    nav.tab === 'entity'
      ? (subject?.label ?? 'Unknown subject')
      : folder !== null
        ? (section?.label ?? folderLabel(folder))
        : null;

  let body: React.ReactNode;
  if (nav.tab === 'review') {
    body = <ReviewBody vaultPath={vaultPath} queue={queue} proposals={proposals} />;
  } else if (nav.tab === 'activity') {
    body = <ActivityBody vaultPath={vaultPath} onOpenConcept={openConcept} />;
  } else if (nav.tab === 'runs') {
    // No tab (M50.5) — the fleet lives on Agents — but the AI panel's run
    // list still deep-links one run open here.
    body = (
      <div className={PADDED}>
        <AgentWork vaultPath={vaultPath} />
      </div>
    );
  } else if (all.length === 0) {
    body = (
      <div className="flex justify-center py-16">
        <EmptyState
          icon="brain"
          title="No knowledge yet"
          description="Agents write what they learn about this vault into knowledge/, as concepts you can open, edit and verify."
        />
      </div>
    );
  } else if (nav.tab === 'entity') {
    body = (
      <div className={PADDED}>
        {subject === null ? (
          <p className="text-sm text-n-500">Knowledge holds nothing about that subject.</p>
        ) : (
          <ThreadView
            subject={subject}
            concepts={all}
            entries={entries}
            today={today}
            onOpenConcept={openConcept}
          />
        )}
      </div>
    );
  } else if (folder !== null && filed !== undefined) {
    body =
      filed.length === 0 ? (
        <div className="flex justify-center py-16">
          <EmptyState
            icon="folder"
            title="Nothing here"
            description="No concept is filed under this folder."
          />
        </div>
      ) : (
        // One section and no band: the crumb already names the folder.
        <ConceptTable
          sections={[{ folder, label: folderLabel(folder), concepts: filed }]}
          queue={queue}
          proposals={proposals}
        />
      );
  } else {
    // Everything, filed under the folders the sidebar lists; a band's name
    // opens its folder, as the sidebar row does.
    body = (
      <ConceptTable
        sections={sections.map((s) => ({
          folder: s.folder,
          label: s.label,
          concepts: all.filter((c) => c.section === s.folder),
        }))}
        queue={queue}
        proposals={proposals}
        onOpenFolder={openFolder}
      />
    );
  }

  // The tab counts are the bundle's, so a folder's view draws none: there
  // they would count one thing while the tab opened another, and the header
  // already counts the folder (M52.5).
  const bundleWide = folder === null;
  const tabs: { tab: Tab; label: string; icon: string; count?: number }[] = [
    { tab: 'all', label: 'Concepts', icon: 'table-2', count: bundleWide ? all.length : undefined },
    {
      tab: 'review',
      label: 'Review',
      icon: 'shield-check',
      // Review holds two queues — concepts to verify and the changes agents
      // proposed — and its count is both. The cards are left out only when
      // they could not be read.
      count: bundleWide ? queue.length + (proposalCount ?? 0) : undefined,
    },
    { tab: 'activity', label: 'Activity', icon: 'activity' },
  ];

  // "9 to verify · 3 proposals" — of the folder in a folder's view. The
  // concept count sits beside the title, as a view's record count does.
  const counted = filed ?? all;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const summary =
    all.length === 0
      ? null
      : waiting.length === 0 && (proposalCount ?? 0) === 0
        ? 'nothing to review'
        : [
            waiting.length === 0 ? 'nothing to verify' : `${waiting.length} to verify`,
            proposalCount === null || proposalCount === 0
              ? null
              : plural(proposalCount, 'proposal', 'proposals'),
          ]
            .filter((part) => part !== null)
            .join(' · ');

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="knowledge-page">
      {/* A type's page shell (M52.5): the title row padded like its header,
          then the tab strip edge to edge with the page's one primary act at
          its end, then the table flush beneath it. */}
      {/* A container of its own (M52.5), so the byline steps aside before
          the counts beside it are ever cut: "3 to verify · 3 pro…" was the
          header giving up its one useful number for a name. */}
      <header className="@container/khead flex flex-none px-5 pt-3.5">
        <div className="mb-2.5 flex min-w-0 flex-1 items-center gap-2">
          <span className="flex h-7 w-7 flex-none items-center justify-center">
            <Icon name="brain" size={16} color="var(--n-600)" />
          </span>
          {/* `px-1` is the inset a type page's title has from its rename
              button, so the two headings start at one x (M52.5). */}
          <h1
            className="m-0 min-w-0 flex-[0_1_auto] px-1 text-lg font-semibold leading-6 tracking-[-0.005em]"
            data-testid="knowledge-heading"
          >
            {crumb === null ? (
              'Knowledge'
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => navigate({ kind: 'knowledge', nav: { tab: 'all' } })}
                  className="border-0 bg-transparent p-0 text-lg font-semibold text-n-500 hover:text-n-800"
                >
                  Knowledge
                </button>
                <Icon name="chevron-right" size={14} color="var(--n-300)" className="flex-none" />
                <span className="truncate">{crumb}</span>
              </span>
            )}
          </h1>
          {/* How many, as a view's header counts its records. */}
          {nav.tab !== 'entity' && (
            <span
              data-testid="knowledge-count"
              className="flex-none [font-family:var(--font-mono)] text-xs text-n-400"
            >
              {counted.length}
            </span>
          )}
          {summary !== null && nav.tab !== 'entity' && (
            <p
              data-testid="knowledge-summary"
              className="m-0 ml-1 flex min-w-0 items-center gap-1.5 text-xs text-n-500"
            >
              {/* Never cut: the counts are the header's reason to be. */}
              <span className="flex-none whitespace-nowrap">{summary}</span>
              {/* M35.3 — Knowledge's judgement has a face: the byline names
                  the knowledge-capable agent and opens it on Agents (M50.3).
                  With no such agent there is no byline — "Maintained by
                  agents" named nobody. */}
              {maintainer !== null && (
                <>
                  <span aria-hidden className="text-n-300 @max-[640px]/khead:hidden">
                    ·
                  </span>
                  <button
                    type="button"
                    data-testid="knowledge-maintainer"
                    onClick={() => navigate({ kind: 'agents', actor: maintainer.actor })}
                    className="inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent p-0 text-xs text-n-500 hover:text-n-800 @max-[640px]/khead:hidden"
                  >
                    <Icon name="bot" size={12} color="var(--synapse-500)" className="flex-none" />
                    <span className="truncate">Maintained by {maintainer.title}</span>
                  </button>
                </>
              )}
            </p>
          )}
          {/* On a subject the subject itself is one click away — that link is
              the whole point of anchoring knowledge to the vault. */}
          {subject?.entry != null && (
            <Button
              variant="ghost"
              size="sm"
              icon="arrow-up-right"
              onClick={() => openPath(subject.entry!.path)}
            >
              Open page
            </Button>
          )}
          {/* And where there is nothing to open, the offer to write it (D7/D1):
              a subject becomes a workspace record because a human clicked. The
              dialog is the New menu's own, pre-filled. */}
          {subject !== null && subject.entry === null && (
            <>
              <Button
                variant="ghost"
                size="sm"
                testId="promote-thread"
                onClick={() => setPromoting(true)}
              >
                + Create page
              </Button>
              {promoting && (
                <NewRecordDialog
                  defaultTitle={subject.target}
                  onClose={() => setPromoting(false)}
                />
              )}
            </>
          )}
        </div>
      </header>
      {/* A container of its own (M52.5): at 1100px with the Assistant open,
          Start review sat on top of the Activity tab. Narrow, the button
          keeps its glyph and count and its words go to screen readers only;
          narrower still, the tabs scroll under their own edge rather than
          under the button. */}
      <div className={`${VIEW_TAB_STRIP} @container/ktabs px-5`}>
        <nav
          aria-label="Knowledge views"
          className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((t) => {
            const on = tab === t.tab;
            return (
              <button
                key={t.tab}
                type="button"
                data-testid={`knowledge-tab-${t.tab}`}
                aria-current={on ? 'page' : undefined}
                onClick={() => navigate({ kind: 'knowledge', nav: { tab: t.tab } })}
                className={viewTabClass(on)}
                style={{ borderBottomStyle: 'solid' }}
              >
                <Icon name={t.icon} size={13} />
                {t.label}
                {t.count !== undefined && (
                  <span className="[font-family:var(--font-mono)] text-2xs font-normal text-n-400">
                    {t.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        {/* The queue's front door, where a view keeps its New button: the
            first concept in the order Review works them (a folder's own, in
            a folder), opened as its page, where the review bar and its pager
            take over. Its count is the number that matters most on the page,
            so it rides on the button. With nothing waiting there is no
            button — the summary says so. */}
        {waiting.length > 0 && (
          <div className="flex flex-none items-center gap-0.5 pb-1 pl-2">
            <Button
              variant="primary"
              size="sm"
              icon="play"
              testId="knowledge-start-review"
              onClick={start}
            >
              <span className="@max-[440px]/ktabs:sr-only">Start review</span>
              <span
                data-testid="knowledge-start-count"
                className="[font-family:var(--font-mono)] text-2xs opacity-80"
              >
                {waiting.length}
              </span>
            </Button>
          </div>
        )}
      </div>
      {/* The page's scroll, and only up and down (M52.5): a table too wide
          for its room scrolls sideways in its own box (`ConceptTable`), so
          the headings and cards around it stay put. Concepts' table is the
          page, and its box takes this whole column — a flex child that
          fills it — so its header stays pinned while its rows scroll. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
        {body}
      </div>
    </div>
  );
}
