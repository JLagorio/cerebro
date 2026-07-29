import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import {
  listConcepts,
  needsReview,
  verifyPatch,
  type Concept,
} from '@/engine/okf';
import { todayIso } from '@/lib/templates';
import { ConceptBody } from '@/knowledge/ConceptBody';
import { KnowledgePanel } from '@/knowledge/KnowledgePanel';
import { TrustChip } from '@/knowledge/TrustChip';
import { readNote, verifyConcept } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Knowledge (M5) — the AI knowledge base as its own surface.
 *
 * `knowledge/` is an OKF bundle the agent writes and maintains. Humans do
 * not edit it; they VERIFY it. So this page is a reading surface with a
 * provenance ledger, not an editor: browse the bundle, read a concept,
 * judge it against its sources, and record that judgement.
 *
 * The read-only rule is enforced in the IPC layer (src-tauri/knowledge.rs
 * and the mock's guardHumanWrite), not by omitting an editor here — a
 * missing button is a suggestion, a rejected command is a rule.
 */

type Filter = 'all' | 'review';

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

export function KnowledgePage() {
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const actorId = useUiStore((s) => s.actorId);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [body, setBody] = useState<string>('');
  const [verifying, setVerifying] = useState(false);

  const today = todayIso();
  const all = useMemo(() => listConcepts(entries, today), [entries, today]);
  const concepts = useMemo(
    () => (filter === 'review' ? all.filter(needsReview) : all),
    [all, filter],
  );
  const reviewCount = useMemo(() => all.filter(needsReview).length, [all]);

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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="knowledge-page">
      <header className="flex flex-none items-center gap-3 border-b border-[var(--n-200)] px-5 py-2.5">
        <h2 className="m-0 text-[15px] font-semibold text-[var(--n-900)]">Knowledge</h2>
        <div className="flex items-center gap-1" role="tablist" aria-label="Concept filter">
          {([
            { value: 'all' as const, label: 'All', count: all.length },
            { value: 'review' as const, label: 'Needs review', count: reviewCount },
          ]).map(({ value, label, count }) => {
            const on = value === filter;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setFilter(value)}
                className={[
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium',
                  on
                    ? 'border-[var(--n-300)] bg-[var(--n-100)] text-[var(--n-900)]'
                    : 'border-transparent bg-transparent text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-800)]',
                ].join(' ')}
              >
                {label}
                <span className="text-[10px] tabular-nums text-[var(--n-400)]">{count}</span>
              </button>
            );
          })}
        </div>
        <span className="flex-1" />
        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--n-500)]">
          <Icon name="lock" size={12} />
          Maintained by the agent
        </span>
      </header>

      {selected === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon="shield-check"
            title="Everything is reviewed"
            description="No concept is unverified, stale, or deprecated."
            action={
              <Button variant="secondary" onClick={() => setFilter('all')}>
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
                onOpenConcept={(path) => {
                  // Broken cross-links are legitimate in OKF (§6.1) — they
                  // may just be knowledge nobody has written yet.
                  if (all.some((c) => c.entry.path === path)) setSelectedPath(path);
                  else toast(`No concept at ${path} yet`);
                }}
              />
            </div>
          </div>

          <KnowledgePanel
            concept={selected}
            today={today}
            verifying={verifying}
            onVerify={verify}
            onAskAgent={() =>
              toast('The AI panel arrives in M6 — it will open with this concept as context.')
            }
          />
        </div>
      )}
    </div>
  );
}
