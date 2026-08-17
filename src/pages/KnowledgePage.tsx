import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import {
  defaultKnowledgeNav,
  listConcepts,
  listSubjects,
  needsReview,
  verifyPatch,
  type Concept,
} from '@/engine/okf';
import type { KnowledgeNav, Selection } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';
import { NewRecordDialog } from '@/app/CreateMenu';
import { useOpenPath } from '@/app/useOpenPath';
import { reviewConceptPrompt } from '@/lib/prompts';
import { todayIso } from '@/lib/templates';
import {
  AgentWork,
  Background,
  DeferralGates,
  WaitingOnYou,
  WhatChanged,
  WhatsContested,
} from '@/knowledge/BaseItself';
import { ConceptBody } from '@/knowledge/ConceptBody';
import { KnowledgeLog } from '@/knowledge/KnowledgeLog';
import { KnowledgePanel } from '@/knowledge/KnowledgePanel';
import { ReviewChip } from '@/knowledge/ReviewChip';
import { ThreadView } from '@/knowledge/ThreadView';
import { chipsFor, useBeliefChips } from '@/knowledge/useBeliefChips';
import { readNote, verifyConcept } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Knowledge (M5, reworked in M8.1) — the AI knowledge base as its own surface.
 *
 * `knowledge/` is an OKF bundle the agent writes and maintains. Humans do not
 * edit it; they VERIFY it. So this page is a reading surface with a provenance
 * ledger, not an editor: browse the bundle, read a concept, judge it against
 * its sources, and record that judgement.
 *
 * The read-only rule is enforced in the IPC layer (src-tauri/knowledge.rs and
 * the mock's guardHumanWrite), not by omitting an editor here — a missing
 * button is a suggestion, a rejected command is a rule.
 *
 * What changed in M8.1: the page no longer carries its own navigation. Which
 * concepts are on screen is decided by the Knowledge sidebar — by section, by
 * the entity they are ABOUT, or by whether they want review — and the list
 * that remains is the contents of that choice, the same relationship Docs has
 * between its file tree and its editor.
 */

function ConceptRow({
  concept,
  active,
  onClick,
}: {
  concept: Concept;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="row"
      aria-selected={active}
      data-testid="concept-row"
      data-path={concept.entry.path}
      title={concept.supersededBy !== null ? 'Replaced by a newer concept' : undefined}
      onClick={onClick}
      className={[
        'flex flex-col gap-1 border-0 border-b border-solid border-n-100 px-4 py-2.5 text-left',
        active ? 'bg-cortex-50' : 'bg-transparent hover:bg-n-25',
      ].join(' ')}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className={[
            'truncate text-sm',
            // M8.7 — a replaced concept is struck through in the list. The
            // alternative is hiding it, which loses the record of what was
            // believed before; this keeps it readable and unmistakable.
            concept.supersededBy !== null
              ? 'font-medium text-n-400 line-through'
              : active
                ? 'font-semibold text-n-900'
                : 'font-medium text-n-800',
          ].join(' ')}
        >
          {concept.title}
        </span>
      </span>
      {concept.description !== null && (
        <span className="line-clamp-2 text-xs leading-[16px] text-n-500">
          {concept.description}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-2xs text-n-400">{concept.conceptType}</span>
        {/* M15: a strikethrough alone is a legend nobody has — deleted,
            deprecated, done and filtered-out all look like this. */}
        {concept.supersededBy !== null && (
          <span data-testid="replaced-tag" className="rounded-sm bg-n-100 px-1 text-2xs text-n-500">
            Replaced
          </span>
        )}
        <ReviewChip status={concept.review} by={concept.reviewedBy} size="sm" />
        {concept.stale && (
          <span className="inline-flex items-center gap-1 text-2xs text-warn-600">
            <Icon name="clock-alert" size={10} />
            Stale
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * The tabs that describe the base ITSELF rather than list its concepts
 * (M33a.2 — what used to be the Status hub).
 *
 * `null` for every tab that has a concept list. The six that do not carry no
 * heading of their own here: each section already renders its `<h2>` and its
 * blurb, exactly as it did on the hub, and repeating the same three words in
 * an `<h1>` above it would be the merge inventing chrome rather than moving a
 * surface.
 */
function baseItself(nav: KnowledgeNav, vaultPath: string | null): React.ReactNode {
  switch (nav.tab) {
    case 'changed':
      return <WhatChanged vaultPath={vaultPath} />;
    case 'contested':
      return <WhatsContested vaultPath={vaultPath} />;
    case 'waiting':
      return <WaitingOnYou vaultPath={vaultPath} />;
    case 'background':
      return <Background vaultPath={vaultPath} />;
    case 'runs':
      // No vault: the fleet spans them, and the run a link asked for rides on
      // the selection, which FleetSection reads itself.
      return <AgentWork />;
    case 'gates':
      return <DeferralGates vaultPath={vaultPath} />;
    default:
      return null;
  }
}

export function KnowledgePage({
  selection,
}: {
  selection: Extract<Selection, { kind: 'knowledge' }>;
}) {
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const actorId = useUiStore((s) => s.actorId);
  const askAgent = useUiStore((s) => s.askAgent);
  const navigate = useNavStore((s) => s.navigate);
  const openPath = useOpenPath();

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [body, setBody] = useState<string>('');
  const [verifying, setVerifying] = useState(false);
  // The D1 boundary, as UI state: the agent never creates a workspace record,
  // so this flag can only be raised by a click. See the header button.
  const [promoting, setPromoting] = useState(false);
  // Loaded once for the page rather than once per concept: the axes are a
  // fold of the whole ledger either way, and asking again on every selection
  // would re-read it to answer about one row.
  const chipIndex = useBeliefChips(vaultPath);

  /**
   * How much room the three columns actually have (M15).
   *
   * They used to be `flex-none` at 280 + 320 with a shrinkable middle, i.e. a
   * 600px hard floor inside a canvas whose own floor is 400 — so with the
   * assistant open the concept body vanished and the provenance column, which
   * holds the only two actions on this surface, was clipped away entirely.
   * Measured rather than assumed because what matters is the CANVAS's width,
   * not the viewport's.
   */
  const [rowWidth, setRowWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const rowRef = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (node === null || typeof ResizeObserver === 'undefined') return;
    const next = new ResizeObserver((entries) => {
      setRowWidth(entries[0]?.contentRect.width ?? 0);
    });
    next.observe(node);
    observer.current = next;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  // 280 list + a readable concept body + 320 provenance. Below it the third
  // column becomes a drawer instead of eating the other two.
  const narrow = rowWidth > 0 && rowWidth < 900;
  const [provenanceOpen, setProvenanceOpen] = useState(false);

  // A deep link from elsewhere in the app (M8.3) wins over whatever was last
  // open here — arriving from "what the assistant knows" has to land on the
  // concept that was clicked, not on the head of the list.
  const linkedPath = selection.path ?? null;
  useEffect(() => {
    if (linkedPath !== null) setSelectedPath(linkedPath);
  }, [linkedPath]);

  const today = todayIso();
  const all = useMemo(() => listConcepts(entries, today), [entries, today]);
  const subjects = useMemo(() => listSubjects(all, entries), [all, entries]);
  // Memoized so downstream useMemos key on the nav VALUE — an inline
  // `?? defaultKnowledgeNav(subjects)` would mint a fresh object every render
  // and defeat them. `subjects` is itself memoized, so the default is stable
  // until the bundle actually changes.
  const nav: KnowledgeNav = useMemo(
    () => selection.nav ?? defaultKnowledgeNav(subjects),
    [selection.nav, subjects],
  );

  const subject = nav.tab === 'entity' ? (subjects.find((s) => s.key === nav.key) ?? null) : null;
  const concepts = useMemo(() => {
    switch (nav.tab) {
      case 'review':
        return all.filter(needsReview);
      case 'section':
        return all.filter((c) => c.section === nav.folder);
      case 'entity':
        return subject?.concepts ?? [];
      default:
        return all;
    }
  }, [all, nav, subject]);

  /**
   * A thread does not auto-select (M33a.4).
   *
   * Every other view here is a LIST of concepts and opening the head of it is
   * a reasonable guess. A thread is one subject, and the answer to "what does
   * the base believe about this" is the whole thread — so landing on whichever
   * concept sorted first would answer a question nobody asked and hide the
   * four that matter more. The other tabs keep the guess.
   */
  const selected =
    concepts.find((c) => c.entry.path === selectedPath) ??
    (nav.tab === 'entity' ? null : (concepts[0] ?? null));
  const selectedConceptPath = selected?.entry.path ?? null;
  /** The thread reads as one thing until a concept is asked for by name. */
  const showThread = nav.tab === 'entity' && subject !== null && selected === null;

  // A replaced concept carries no back-pointer of its own (M8.7: the
  // replacement is what holds `supersedes`), so the title of what replaced it
  // is looked up in the bundle.
  const replacedBy = selected?.supersededBy ?? '';
  const replacement =
    replacedBy === '' ? null : (all.find((c) => c.entry.path === replacedBy) ?? null);

  // Concept bodies are read on demand rather than held in the store: the
  // bundle can be large and only one concept is on screen at a time.
  useEffect(() => {
    if (vaultPath === null || selectedConceptPath === null) {
      setBody('');
      return;
    }
    let cancelled = false;
    readNote(vaultPath, selectedConceptPath)
      .then((text) => {
        if (!cancelled) setBody(text);
      })
      .catch(() => {
        if (!cancelled) setBody('');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedConceptPath, vaultPath]);

  // M15: one sign-off per actor per day. "Verify again" used to append an
  // identical `{by, at}` row on every click, which is how the ledger filled
  // with four copies of the same stamp.
  const verifiedToday =
    selected !== null &&
    selected.verified.some(
      (stamp) =>
        stamp.by.kind === 'human' &&
        stamp.by.label === actorId &&
        (stamp.at ?? '').slice(0, 10) === today,
    );

  const verify = () => {
    if (vaultPath === null || selected === null || verifiedToday) return;
    setVerifying(true);
    void (async () => {
      try {
        const patch = verifyPatch(selected.entry, `human:${actorId}`, new Date().toISOString());
        await verifyConcept(vaultPath, selected.entry.path, patch);
        await rescan();
        // Said plainly, because verifying does NOT clear staleness: the
        // recheck date is the agent's to move (verify_concept may write
        // `verified` and nothing else), so a stale concept stays in the
        // review queue and the toast must not imply otherwise.
        toast(
          selected.stale
            ? `Verified "${selected.title}" — still due a recheck, so it stays in Needs review`
            : `Verified "${selected.title}"`,
        );
      } catch (err) {
        toast(`Couldn't verify: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setVerifying(false);
      }
    })();
  };

  /** Jump to a concept by path from anywhere — the log, a cross-link. */
  const openConcept = (path: string) => {
    if (!all.some((c) => c.entry.path === path)) {
      // Broken cross-links are legitimate in OKF (§6.1) — they may just be
      // knowledge nobody has written yet.
      toast(`No concept at ${path} yet`);
      return;
    }
    // The log shows no concept list at all, and a narrowed slice may not
    // contain the target — either way, land somewhere it is actually visible.
    const visibleHere = nav.tab !== 'log' && concepts.some((c) => c.entry.path === path);
    if (!visibleHere) navigate({ kind: 'knowledge', nav: { tab: 'all' } });
    setSelectedPath(path);
  };

  /**
   * A `[[wikilink]]` in a concept body, followed (M33a.4).
   *
   * Resolution happens here rather than in the renderer because it needs the
   * whole vault — and because only the page knows what to DO with a hit: a
   * concept opens in this reading pane, anything else is the user's own
   * record and opens wherever that record lives.
   */
  const openWikilink = (target: string) => {
    const entry = resolveTarget(target, entries);
    if (entry === null) {
      // A dangling link is legitimate (OKF §6.1) and, per D7, an open thread:
      // the base is tracking something the workspace has not written up. It is
      // reported as an absence, never as damage.
      toast(`Nothing in the vault is named "${target}" yet`);
      return;
    }
    if (all.some((c) => c.entry.path === entry.path)) openConcept(entry.path);
    else openPath(entry.path);
  };

  // M33a.2 — the six tabs that describe the base itself short-circuit for the
  // same reason `log` does below: there is no concept list to put beside them,
  // so the three-column layout has nothing to lay out. They sit ABOVE the
  // empty-bundle guard as well, because what the base knows about itself does
  // not stop being true when nobody has written a concept yet — a vault with
  // no bundle still has runs, a budget and a proposal queue.
  const itself = baseItself(nav, vaultPath);
  if (itself !== null) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="knowledge-page">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {/* Left-aligned and capped: these are sentences to read, not a
              dashboard to spread. */}
          <div className="flex w-full min-w-0 max-w-[860px] flex-col gap-6 px-6 py-4">{itself}</div>
        </div>
      </div>
    );
  }

  if (all.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center" data-testid="knowledge-page">
        <EmptyState
          icon="brain"
          title="No knowledge yet"
          description="This is the AI knowledge base — an Open Knowledge Format bundle in knowledge/. The agent writes and maintains it; you review and verify what it claims."
        />
      </div>
    );
  }

  if (nav.tab === 'log') {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="knowledge-page">
        <KnowledgeLog onOpenConcept={openConcept} />
      </div>
    );
  }

  const heading =
    nav.tab === 'review'
      ? 'Needs review'
      : nav.tab === 'section'
        ? nav.folder === ''
          ? 'Ungrouped'
          : nav.folder.replace(/^\w/, (c) => c.toUpperCase())
        : nav.tab === 'entity'
          ? (subject?.label ?? 'Unknown entity')
          : 'All concepts';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="knowledge-page">
      <header className="flex flex-none items-center gap-2.5 border-b border-n-200 px-5 py-2.5">
        {/* h1, like the other five page-chrome titles (Docs, Changes, Pulse,
            List, Type). Knowledge was the last page with no h1 at all, so a
            screen reader's heading list started at the selected concept. */}
        <h1 className="m-0 text-lg font-semibold text-n-900" data-testid="knowledge-heading">
          {heading}
        </h1>
        <span className="[font-family:var(--font-mono)] text-2xs text-n-400">
          {concepts.length}
        </span>
        {/* On an entity slice the subject itself is one click away — that link
            is the whole point of anchoring knowledge to the vault. */}
        {subject?.entry != null && (
          <Button
            variant="ghost"
            size="sm"
            icon="arrow-up-right"
            onClick={() => openPath(subject.entry!.path)}
          >
            Open {subject.label}
          </Button>
        )}
        {/* And where there is nothing to open, the offer to write it (D7/D1).
            This is the ONE place a knowledge thread becomes a workspace
            record, and it happens because a human clicked: the agent is
            sovereign inside `knowledge/` and nowhere else, so a thread it has
            been tracking for weeks stays a thread until somebody says
            otherwise. The dialog is the New menu's own — same types, same
            `createTarget` — pre-filled with the thread's name and editable,
            and creating navigates to the new page. */}
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
              <NewRecordDialog defaultTitle={subject.target} onClose={() => setPromoting(false)} />
            )}
          </>
        )}
        <span className="flex-1" />
        {/* The only way to Verify or ask for a recheck once the provenance
            column has stepped out of the row. */}
        {narrow && selected !== null && (
          <Button
            variant="secondary"
            size="sm"
            icon="shield-check"
            onClick={() => setProvenanceOpen(!provenanceOpen)}
          >
            {provenanceOpen ? 'Hide provenance' : 'Provenance'}
          </Button>
        )}
        {!narrow && (
          <span className="inline-flex items-center gap-1.5 text-xs text-n-500">
            <Icon name="lock" size={12} />
            Maintained by the agent
          </span>
        )}
      </header>

      {selected === null && !showThread ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={nav.tab === 'review' ? 'shield-check' : 'brain'}
            title={nav.tab === 'review' ? 'Everything is reviewed' : 'Nothing here'}
            description={
              nav.tab === 'review'
                ? 'No concept is unverified, stale, or deprecated.'
                : 'No concept is filed under this yet.'
            }
            action={
              <Button
                variant="secondary"
                onClick={() => navigate({ kind: 'knowledge', nav: { tab: 'all' } })}
              >
                Show all
              </Button>
            }
          />
        </div>
      ) : (
        <div
          ref={rowRef}
          // `overflow-hidden` + a relative box: nothing in here may paint
          // outside the canvas, and the provenance drawer anchors to it.
          className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          <div
            className={[
              'flex flex-none flex-col overflow-y-auto border-r border-n-200',
              narrow ? 'w-[220px]' : 'w-[280px]',
            ].join(' ')}
          >
            {/* The way back to the whole thread once a concept has been
                opened. It leads the column because the thread is what the tab
                landed on — without it, reading one concept is a one-way door
                out of the only view that reads the subject as a subject. */}
            {nav.tab === 'entity' && subject !== null && (
              <button
                type="button"
                data-testid="thread-overview-row"
                aria-selected={selected === null}
                onClick={() => setSelectedPath(null)}
                className={[
                  'flex items-center gap-1.5 border-0 border-b border-solid border-n-100 px-4 py-2.5 text-left text-sm',
                  selected === null
                    ? 'bg-cortex-50 font-semibold text-n-900'
                    : 'bg-transparent font-medium text-n-800 hover:bg-n-25',
                ].join(' ')}
              >
                <Icon name="layers" size={13} color="var(--n-500)" />
                Thread overview
              </button>
            )}
            {concepts.map((c) => (
              <ConceptRow
                key={c.entry.path}
                concept={c}
                active={c.entry.path === selected?.entry.path}
                onClick={() => setSelectedPath(c.entry.path)}
              />
            ))}
          </div>

          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-10 pt-6">
            <div className="mx-auto w-full max-w-[760px] px-6">
              {selected === null ? (
                // The thread, read as one thing. `subject` is non-null
                // whenever `selected` is not — see `showThread`.
                subject !== null && (
                  <ThreadView
                    subject={subject}
                    concepts={all}
                    entries={entries}
                    today={today}
                    onOpenConcept={setSelectedPath}
                  />
                )
              ) : (
                <>
                  {/* M15: the reading pane gave no sign at all that the bundle
                      no longer believes this — a retired claim read as
                      current. */}
                  {selected.supersededBy !== null && (
                    <div
                      data-testid="superseded-banner"
                      className="mb-3 flex flex-wrap items-center gap-1.5 rounded-lg border border-n-200 bg-warn-50 px-3 py-2 text-xs text-warn-700"
                    >
                      <Icon name="archive" size={12} />
                      <span>No longer believed. Replaced by</span>
                      <button
                        type="button"
                        data-path={selected.supersededBy}
                        onClick={() => openConcept(replacedBy)}
                        className="border-0 bg-transparent p-0 text-xs font-medium text-warn-700 underline underline-offset-2"
                      >
                        {replacement?.title ?? 'a newer concept'}
                      </button>
                    </div>
                  )}
                  <div className="mb-1 flex items-center gap-2 text-2xs text-n-400">
                    <span className="[font-family:var(--font-mono)]">{selected.id}</span>
                  </div>
                  {/* h2: the concept is a section of the Knowledge page, not
                      the page itself. Size is unchanged — the level is the
                      fix. */}
                  <h2 className="m-0 text-2xl font-semibold tracking-[-0.02em] text-n-900">
                    {selected.title}
                  </h2>
                  {selected.description !== null && (
                    <p className="mb-1 mt-1.5 text-md leading-[20px] text-n-600">
                      {selected.description}
                    </p>
                  )}
                  <ConceptBody
                    key={selected.entry.path}
                    markdown={body}
                    sources={selected.sources}
                    fromPath={selected.entry.path}
                    onOpenConcept={openConcept}
                    onOpenWikilink={openWikilink}
                  />
                </>
              )}
            </div>
          </div>

          {/* Beside the concept when there is room for it; a drawer over the
              reading pane when there is not — never a third fixed column
              squeezing the other two off the canvas. */}
          {narrow && provenanceOpen && (
            <button
              type="button"
              aria-label="Close provenance"
              onClick={() => setProvenanceOpen(false)}
              className="absolute inset-0 z-10 cursor-default border-0 bg-transparent"
            />
          )}
          {/* No concept, no provenance ledger: the thread view is a read of
              many concepts and there is no single one to attest to. */}
          {(!narrow || provenanceOpen) && selected !== null && (
            <KnowledgePanel
              concept={selected}
              today={today}
              verifying={verifying}
              verifiedToday={verifiedToday}
              chips={chipsFor(chipIndex, selected.entry.path)}
              className={
                narrow
                  ? 'absolute inset-y-0 right-0 z-20 w-[300px] max-w-full shadow-[var(--shadow-lg)]'
                  : 'w-[320px] flex-none'
              }
              onVerify={verify}
              onOpenEntity={openPath}
              onOpenConcept={openConcept}
              onAskAgent={() => {
                askAgent(
                  reviewConceptPrompt(selected.entry.path, selected.title),
                  selected.entry.path,
                );
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
