import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import { RecordProperties } from '@/detail/RecordProperties';
import { NoteBodyEditor } from '@/editor/NoteBodyEditor';
import {
  inboxCounts,
  inInbox,
  INBOX_PERIODS,
  organizeChecklist,
  type InboxPeriod,
} from '@/engine/inbox';
import { conceptsFrom, isAgentWritten, listConcepts } from '@/engine/okf';
import { typeStyle } from '@/engine/typeCatalog';
import { ProposalCard } from '@/agent/ProposalCard';
import type { Entry, Schema } from '@/engine/types';
import { useInboxQueue, type InboxQueue } from '@/hooks/useInboxQueue';
import { captureNote } from '@/lib/capture';
import { describeIngest, ingestFiles, ingestOne, INGESTIBLE_EXTENSIONS } from '@/lib/ingest';
import { fetchRefsPrompt, organizePrompt } from '@/lib/prompts';
import { parseIssuePrefixes, uncachedRefs } from '@/engine/ingest';
import { KnowledgeCommit } from '@/knowledge/KnowledgeCommit';
import { todayIso } from '@/lib/templates';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/** Period pills with live counts — the Inbox's own filter row. */
function PeriodPills({
  active,
  counts,
  onChange,
}: {
  active: InboxPeriod;
  counts: Record<InboxPeriod, number>;
  onChange: (p: InboxPeriod) => void;
}) {
  return (
    <div className="flex items-center gap-1" role="tablist" aria-label="Capture period">
      {INBOX_PERIODS.map(({ value, label }) => {
        const on = value === active;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(value)}
            className={[
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium',
              on
                ? 'border-[var(--n-300)] bg-[var(--n-100)] text-[var(--n-900)]'
                : 'border-transparent bg-transparent text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-800)]',
            ].join(' ')}
          >
            {label}
            <span className="text-[10px] tabular-nums text-[var(--n-400)]">{counts[value]}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The review checklist for the open capture. Advisory by design: nothing
 * here blocks "Mark organized" — over-structuring a note you will never
 * revisit is its own failure mode.
 */
function OrganizeChecklist({ entry, schema }: { entry: Entry; schema: Schema }) {
  const checks = useMemo(() => organizeChecklist(entry, schema), [entry, schema]);
  const outstanding = checks.filter((c) => !c.done);

  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="organize-checklist">
      {checks.map((c) => (
        <li key={c.id} className="flex gap-2">
          <span
            className={`flex-none pt-[1px] ${c.done ? 'text-[var(--success-600)]' : 'text-[var(--n-300)]'}`}
          >
            <Icon name={c.done ? 'circle-check' : 'circle'} size={13} />
          </span>
          <span className="min-w-0">
            <span
              className={`block text-[12.5px] ${c.done ? 'text-[var(--n-500)]' : 'font-medium text-[var(--n-800)]'}`}
            >
              {c.label}
            </span>
            {!c.done && (
              <span className="mt-0.5 block text-[11px] leading-[15px] text-[var(--n-500)]">
                {c.hint}
              </span>
            )}
          </span>
        </li>
      ))}
      {outstanding.length === 0 && (
        <li className="pt-1 text-[11.5px] text-[var(--success-600)]">
          Ready — this note will be findable later.
        </li>
      )}
    </ul>
  );
}

/** Right-hand organize pane: checklist, type, then the type's own fields. */
function OrganizePanel({
  entry,
  schema,
  queue,
}: {
  entry: Entry;
  schema: Schema;
  queue: InboxQueue;
}) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const proposal = useUiStore((s) => s.proposals[entry.path]);
  const setPendingPrompt = useUiStore((s) => s.setAgentPendingPrompt);
  const setAiPanelOpen = useUiStore((s) => s.setAiPanelOpen);
  const connectors = useUiStore((s) => s.agentConnectors);
  const issuePrefixes = useUiStore((s) => s.issuePrefixes);
  const allEntries = useVaultStore((s) => s.entries);

  // The visible half of the connector inlet (M8.2): what this capture refers
  // to that nobody has a local copy of. Nothing is fetched automatically —
  // reaching another system is a round trip and a decision, so it is offered.
  const unresolved = useMemo(() => {
    if (!connectors) return [];
    const text = `${entry.title}\n${entry.snippet}`;
    return uncachedRefs(
      text,
      allEntries.map((e) => e.path),
      {
        issuePrefixes: parseIssuePrefixes(issuePrefixes),
      },
    );
  }, [allEntries, connectors, entry.snippet, entry.title, issuePrefixes]);

  const typeOptions = [
    { value: '', label: 'No type' },
    ...[...schema.types.keys()]
      .filter((t) => t !== 'Type')
      .sort()
      .map((t) => ({ value: t, label: t })),
  ];

  return (
    <aside
      aria-label="Organize"
      className="flex w-[320px] flex-none flex-col overflow-y-auto border-l border-[var(--n-200)] px-4 pb-5 pt-3.5"
    >
      {/* Type leads, and the type's own fields follow it, because assigning a
          type is the whole job here — everything else on this panel is either
          advice about that decision or something to do once it is made. The
          checklist used to sit above it, which put a list of instructions
          between you and the one control you came for. */}
      <div className="flex items-center gap-2">
        <span className="flex-none text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--n-500)]">
          Type
        </span>
        <Select
          size="sm"
          options={typeOptions}
          value={entry.type ?? ''}
          onChange={(e) =>
            void patchFrontmatter(entry.path, {
              type: e.target.value === '' ? null : e.target.value,
            })
          }
          className="min-w-0 flex-1"
        />
      </div>

      {/* Once typed, the type's declared fields are the rest of the form —
          the same property stack the record surfaces use, not a second one. */}
      {entry.type !== null && (
        <div className="mt-3 border-t border-[var(--n-100)] pt-3">
          <RecordProperties key={entry.path} entry={entry} schema={schema} />
        </div>
      )}

      {proposal !== undefined && (
        <div className="mt-3">
          <ProposalCard proposal={proposal} />
        </div>
      )}

      <div className="mt-auto flex flex-col gap-3 pt-6">
        {/* M8.5 — what the vault kept from this capture. Filing decides where
            it lives; this decides what is LEARNED from it, and the two are
            independent: material worth keeping knowledge from is often
            material you would otherwise file and never reread. */}
        <div className="border-t border-[var(--n-100)] pt-3">
          <KnowledgeCommit entry={entry} />
        </div>

        <div className="border-t border-[var(--n-100)] pt-3">
          <div className="pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--n-500)]">
            Before you file
          </div>
          <OrganizeChecklist entry={entry} schema={schema} />
        </div>

        <div className="flex flex-col gap-2 border-t border-[var(--n-100)] pt-3">
          {proposal === undefined && (
            <Button
              variant="secondary"
              icon="sparkles"
              onClick={() => {
                setAiPanelOpen(true);
                setPendingPrompt(organizePrompt(entry.path));
              }}
            >
              Ask the agent to file it
            </Button>
          )}
          {unresolved.length > 0 && (
            <Button
              variant="secondary"
              icon="download"
              onClick={() => {
                setAiPanelOpen(true);
                setPendingPrompt(
                  fetchRefsPrompt(
                    entry.path,
                    unresolved.map((r) => r.id),
                  ),
                );
              }}
            >
              {`Fetch ${unresolved.length} reference${unresolved.length === 1 ? '' : 's'}`}
            </Button>
          )}
          <Button
            variant="primary"
            icon="circle-check"
            onClick={() => void queue.organize(entry.path)}
          >
            Mark organized
          </Button>
          <span className="text-center text-[10.5px] text-[var(--n-400)]">
            <kbd className="[font-family:var(--font-mono)]">⌘E</kbd> · removes it from the Inbox
          </span>
        </div>
      </div>
    </aside>
  );
}

export function InboxPage() {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const period = useUiStore((s) => s.inboxPeriod);
  const setPeriod = useUiStore((s) => s.setInboxPeriod);
  const inboxEnabled = useUiStore((s) => s.inboxEnabled);
  const setInboxEnabled = useUiStore((s) => s.setInboxEnabled);
  const toast = useUiStore((s) => s.toast);
  const navigate = useNavStore((s) => s.navigate);
  const queue = useInboxQueue(period);
  const counts = useMemo(() => inboxCounts(entries), [entries]);
  // Which captures the bundle has already learned from. Computed once for the
  // whole queue rather than per row: the answer is a scan of every concept's
  // sources, and doing that inside the map is the same work N times over.
  const concepts = useMemo(() => listConcepts(entries, todayIso()), [entries]);
  const fileInput = useRef<HTMLInputElement>(null);
  // Depth, not a boolean: dragging over a child fires dragleave on the parent,
  // so a flag would flicker the overlay off every time the cursor crossed a row.
  const [dragDepth, setDragDepth] = useState(0);

  // Hoisted to a const so the narrowing survives into the row callbacks.
  const selected = queue.selected;
  const selectedPath = selected?.path ?? null;

  // Cmd/Ctrl+E organizes the open capture — the whole loop is meant to run
  // from the keyboard, so this is the one binding that matters here.
  // Depends on queue.organize, not `queue`: the queue object is a fresh
  // literal every render, and re-binding the listener that often is how a
  // single keystroke ends up firing twice.
  const organize = queue.organize;
  useEffect(() => {
    if (selectedPath === null) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        void organize(selectedPath);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [organize, selectedPath]);

  const capture = () => {
    void (async () => {
      try {
        const path = await captureNote();
        queue.select(path);
      } catch (err) {
        toast(`Couldn't capture: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  // M8.2 — the ingest inlet. Transcripts, exports, and pasted walls of text
  // arrive here as untyped working docs, which is the same object a fetched
  // ticket becomes, so the distiller only ever reads one shape.
  const takeFiles = (files: readonly File[]) => {
    if (files.length === 0) return;
    void (async () => {
      try {
        const result = await ingestFiles(files);
        if (result.paths.length > 0) queue.select(result.paths[0]);
        toast(describeIngest(result));
      } catch (err) {
        toast(`Couldn't ingest: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  // A paste big enough to be material rather than a typo becomes a capture.
  // Small pastes are almost certainly meant for a field, so they are left
  // alone — an app that swallows ⌘V is worse than one that ignores it.
  const PASTE_MIN = 200;
  const onPaste = (event: React.ClipboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"]') != null) return;
    const text = event.clipboardData.getData('text/plain');
    if (text.trim().length < PASTE_MIN) return;
    event.preventDefault();
    void (async () => {
      try {
        const path = await ingestOne('', text);
        queue.select(path);
        toast('Filed the pasted text to the Inbox');
      } catch (err) {
        toast(`Couldn't ingest: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  // Reachable through nav history after the workflow is switched off —
  // explain and offer the way back rather than bouncing to another screen.
  if (!inboxEnabled) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center" data-testid="inbox-page">
        <EmptyState
          icon="inbox"
          title="Inbox workflow is off"
          description="Every note reads as organized. Turn the workflow back on to queue untyped captures for review."
          action={
            <Button variant="secondary" onClick={() => setInboxEnabled(true)}>
              Turn on Inbox
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="inbox-page"
      onPaste={onPaste}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragDepth((d) => d + 1);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragDepth(0);
        takeFiles([...e.dataTransfer.files]);
      }}
    >
      <header className="flex flex-none items-center gap-3 border-b border-[var(--n-200)] px-5 py-2.5">
        <h2 className="m-0 text-[15px] font-semibold text-[var(--n-900)]">Inbox</h2>
        <PeriodPills active={period} counts={counts} onChange={setPeriod} />
        <span className="flex-1" />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          accept={INGESTIBLE_EXTENSIONS.map((e) => `.${e}`).join(',')}
          onChange={(e) => {
            takeFiles([...(e.target.files ?? [])]);
            // Cleared so choosing the same file twice fires change twice.
            e.target.value = '';
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          icon="file-up"
          onClick={() => fileInput.current?.click()}
        >
          Add files
        </Button>
        <Button variant="secondary" size="sm" icon="plus" onClick={capture}>
          Capture
        </Button>
      </header>

      {dragDepth > 0 && (
        <div
          data-testid="inbox-dropzone"
          className="pointer-events-none absolute inset-0 z-10 m-3 flex flex-col items-center justify-center gap-2 rounded-[14px] border-2 border-dashed border-[var(--cortex-400)] bg-[var(--cortex-50)]"
        >
          <Icon name="file-down" size={22} color="var(--cortex-600)" />
          <span className="text-[13px] font-medium text-[var(--cortex-700)]">
            Drop to file in the Inbox
          </span>
          <span className="text-[11.5px] text-[var(--n-500)]">
            Transcripts and notes — {INGESTIBLE_EXTENSIONS.map((e) => `.${e}`).join(' ')}
          </span>
        </div>
      )}

      {selected === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon="inbox"
            title={counts.all === 0 ? 'Inbox zero' : 'Nothing captured in this period'}
            description={
              counts.all === 0
                ? 'Captures land here untyped. Giving a note a type is what takes it out of the Inbox.'
                : 'Widen the period to see older captures still waiting to be organized.'
            }
            action={
              counts.all === 0 ? (
                <Button variant="secondary" icon="plus" onClick={capture}>
                  Capture a note
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => setPeriod('all')}>
                  Show all
                </Button>
              )
            }
          />
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="flex w-[280px] flex-none flex-col overflow-y-auto border-r border-[var(--n-200)]">
            {queue.entries.map((e) => {
              const active = e.path === selectedPath;
              // Held in place by the queue while you work on it, but it
              // already satisfies the membership rule — so the counts say 3
              // while 4 rows show. Mark it, or that reads as a bug.
              const ready = !inInbox(e);
              const learned = conceptsFrom(e.path, concepts).length;
              return (
                <button
                  key={e.path}
                  type="button"
                  role="row"
                  aria-selected={active}
                  data-testid="inbox-row"
                  data-path={e.path}
                  onClick={() => queue.select(e.path)}
                  className={[
                    'flex flex-col gap-0.5 border-0 border-b border-solid border-[var(--n-100)] px-4 py-2.5 text-left',
                    active ? 'bg-[var(--cortex-50)]' : 'bg-transparent hover:bg-[var(--n-25)]',
                  ].join(' ')}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {e.parseError !== null && (
                      <span className="inline-flex flex-none text-[var(--warn-500)]">
                        <Icon name="triangle-alert" size={12} />
                      </span>
                    )}
                    {ready && (
                      <span
                        title="Organized — press ⌘E to file it"
                        className="inline-flex flex-none text-[var(--success-600)]"
                      >
                        <Icon name="circle-check" size={12} />
                      </span>
                    )}
                    <span
                      className={[
                        'truncate text-[13px]',
                        ready
                          ? 'font-medium text-[var(--n-500)]'
                          : active
                            ? 'font-semibold text-[var(--n-900)]'
                            : 'font-medium text-[var(--n-800)]',
                      ].join(' ')}
                    >
                      {e.title}
                    </span>
                  </span>
                  {e.snippet !== '' && (
                    <span className="truncate text-[11.5px] text-[var(--n-500)]">{e.snippet}</span>
                  )}
                  <span className="flex items-center gap-2 text-[11px] text-[var(--n-400)]">
                    <span>{e.createdAt.slice(0, 10)}</span>
                    {/* M7: what the agent wrote is labelled, so the review
                        queue never hides machine output among your own. */}
                    {isAgentWritten(e) && (
                      <span
                        data-testid="from-ai"
                        className="inline-flex items-center gap-1 text-[var(--synapse-600)]"
                      >
                        <Icon name="sparkles" size={10} />
                        AI
                      </span>
                    )}
                    {e.type !== null && (
                      <span className="inline-flex items-center gap-1">
                        <Icon
                          name={typeStyle(e.type, schema).icon}
                          size={11}
                          color={typeStyle(e.type, schema).color ?? 'var(--n-400)'}
                        />
                        {e.type}
                      </span>
                    )}
                    {/* M8.5 — the base took something from this one. Shown on
                        the row because "did I already learn from that?" is a
                        question you ask while scanning, not after opening. */}
                    {learned > 0 && (
                      <span
                        data-testid="row-committed"
                        title={`${learned} concept${learned === 1 ? '' : 's'} distilled from this`}
                        className="inline-flex items-center gap-1 text-[var(--cortex-600)]"
                      >
                        <Icon name="brain" size={10} />
                        {learned}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-10 pt-6">
            <div className="mx-auto w-full max-w-[760px] px-6">
              <NoteBodyEditor key={selected.path} path={selected.path} />
              <button
                type="button"
                onClick={() => navigate({ kind: 'doc', path: selected.path })}
                className="mt-6 inline-flex items-center gap-1.5 border-0 bg-transparent p-0 text-[11.5px] text-[var(--n-500)] hover:text-[var(--n-800)]"
              >
                <Icon name="external-link" size={12} />
                Open as document
              </button>
            </div>
          </div>

          <OrganizePanel entry={selected} schema={schema} queue={queue} />
        </div>
      )}
    </div>
  );
}
