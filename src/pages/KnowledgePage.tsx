import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import {
  listConcepts,
  listSubjects,
  needsReview,
  verifyPatch,
  type Concept,
} from '@/engine/okf';
import type { KnowledgeNav, Selection } from '@/engine/types';
import { useOpenPath } from '@/app/useOpenPath';
import { reviewConceptPrompt } from '@/lib/prompts';
import { todayIso } from '@/lib/templates';
import { ConceptBody } from '@/knowledge/ConceptBody';
import { KnowledgeLog } from '@/knowledge/KnowledgeLog';
import { KnowledgePanel } from '@/knowledge/KnowledgePanel';
import { TrustChip } from '@/knowledge/TrustChip';
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
      onClick={onClick}
      className={[
        'flex flex-col gap-1 border-0 border-b border-solid border-[var(--n-100)] px-4 py-2.5 text-left',
        active ? 'bg-[var(--cortex-50)]' : 'bg-transparent hover:bg-[var(--n-25)]',
      ].join(' ')}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className={[
            'truncate text-[13px]',
            active ? 'font-semibold text-[var(--n-900)]' : 'font-medium text-[var(--n-800)]',
          ].join(' ')}
        >
          {concept.title}
        </span>
      </span>
      {concept.description !== null && (
        <span className="line-clamp-2 text-[11.5px] leading-[16px] text-[var(--n-500)]">
          {concept.description}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10.5px] text-[var(--n-400)]">{concept.conceptType}</span>
        <TrustChip tier={concept.trust} size="sm" />
        {concept.stale && (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--warn-600)]">
            <Icon name="clock-alert" size={10} />
            Stale
          </span>
        )}
      </span>
    </button>
  );
}

export function KnowledgePage({ selection }: { selection: Extract<Selection, { kind: 'knowledge' }> }) {
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const actorId = useUiStore((s) => s.actorId);
  const setAiPanelOpen = useUiStore((s) => s.setAiPanelOpen);
  const setPendingPrompt = useUiStore((s) => s.setAgentPendingPrompt);
  const navigate = useNavStore((s) => s.navigate);
  const openPath = useOpenPath();

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [body, setBody] = useState<string>('');
  const [verifying, setVerifying] = useState(false);

  // A deep link from elsewhere in the app (M8.3) wins over whatever was last
  // open here — arriving from "what the assistant knows" has to land on the
  // concept that was clicked, not on the head of the list.
  const linkedPath = selection.path ?? null;
  useEffect(() => {
    if (linkedPath !== null) setSelectedPath(linkedPath);
  }, [linkedPath]);

  const nav: KnowledgeNav = selection.nav ?? { tab: 'all' };
  const today = todayIso();
  const all = useMemo(() => listConcepts(entries, today), [entries, today]);
  const subjects = useMemo(() => listSubjects(all, entries), [all, entries]);

  const subject = nav.tab === 'entity' ? subjects.find((s) => s.key === nav.key) ?? null : null;
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

  const selected = concepts.find((c) => c.entry.path === selectedPath) ?? concepts[0] ?? null;
  const selectedConceptPath = selected?.entry.path ?? null;

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

  const verify = () => {
    if (vaultPath === null || selected === null) return;
    setVerifying(true);
    void (async () => {
      try {
        const patch = verifyPatch(selected.entry, `human:${actorId}`, new Date().toISOString());
        await verifyConcept(vaultPath, selected.entry.path, patch);
        await rescan();
        toast(`Verified "${selected.title}"`);
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
        ? (nav.folder === '' ? 'Ungrouped' : nav.folder.replace(/^\w/, (c) => c.toUpperCase()))
        : nav.tab === 'entity'
          ? (subject?.label ?? 'Unknown entity')
          : 'All concepts';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="knowledge-page">
      <header className="flex flex-none items-center gap-2.5 border-b border-[var(--n-200)] px-5 py-2.5">
        <h2 className="m-0 text-[15px] font-semibold text-[var(--n-900)]" data-testid="knowledge-heading">
          {heading}
        </h2>
        <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
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
        <span className="flex-1" />
        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--n-500)]">
          <Icon name="lock" size={12} />
          Maintained by the agent
        </span>
      </header>

      {selected === null ? (
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
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="flex w-[280px] flex-none flex-col overflow-y-auto border-r border-[var(--n-200)]">
            {concepts.map((c) => (
              <ConceptRow
                key={c.entry.path}
                concept={c}
                active={c.entry.path === selected.entry.path}
                onClick={() => setSelectedPath(c.entry.path)}
              />
            ))}
          </div>

          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-10 pt-6">
            <div className="mx-auto w-full max-w-[760px] px-6">
              <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--n-400)]">
                <span className="[font-family:var(--font-mono)]">{selected.id}</span>
              </div>
              <h1 className="m-0 text-[26px] font-semibold tracking-[-0.02em] text-[var(--n-900)]">
                {selected.title}
              </h1>
              {selected.description !== null && (
                <p className="mb-1 mt-1.5 text-[13.5px] leading-[20px] text-[var(--n-600)]">
                  {selected.description}
                </p>
              )}
              <ConceptBody
                key={selected.entry.path}
                markdown={body}
                sources={selected.sources}
                fromPath={selected.entry.path}
                onOpenConcept={openConcept}
              />
            </div>
          </div>

          <KnowledgePanel
            concept={selected}
            today={today}
            verifying={verifying}
            onVerify={verify}
            onOpenEntity={openPath}
            onAskAgent={() => {
              setAiPanelOpen(true);
              setPendingPrompt(reviewConceptPrompt(selected.entry.path, selected.title));
            }}
          />
        </div>
      )}
    </div>
  );
}
