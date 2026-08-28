import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import { RecordProperties } from '@/detail/RecordProperties';
import { NoteBodyEditor } from '@/editor/NoteBodyEditor';
import {
  hasRealTitle,
  inboxCounts,
  inInbox,
  INBOX_PERIODS,
  organizeChecklist,
  type InboxPeriod,
  type OrganizeCheck,
} from '@/engine/inbox';
import { conceptsFrom, isAgentWritten, listConcepts } from '@/engine/okf';
import { typeStyle } from '@/engine/typeCatalog';
import { ProposalCard } from '@/agent/ProposalCard';
import type { Entry, Schema } from '@/engine/types';
import { useInboxQueue } from '@/hooks/useInboxQueue';
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
        // A period holding nothing is not a filter, it is a teardown: the old
        // row let you pay a full-screen wipe to learn the answer was 0, with
        // the 0 itself drawn at the lowest contrast on the row. Dim it, say
        // so, and refuse the click.
        const empty = counts[value] === 0 && !on;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={on}
            aria-disabled={empty || undefined}
            title={empty ? `No captures in the last ${label.toLowerCase()}` : undefined}
            onClick={() => {
              if (!empty) onChange(value);
            }}
            className={[
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
              on
                ? 'border-n-300 bg-n-100 text-n-900'
                : empty
                  ? 'cursor-default border-transparent bg-transparent text-n-400 opacity-60'
                  : 'border-transparent bg-transparent text-n-500 hover:bg-n-50 hover:text-n-800',
            ].join(' ')}
          >
            {label}
            <span className="text-2xs tabular-nums text-n-500">{counts[value]}</span>
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
function OrganizeChecklist({
  entry,
  schema,
  onFix,
}: {
  entry: Entry;
  schema: Schema;
  /** Reveal and focus the control that settles `id`, when this panel owns one. */
  onFix: (id: OrganizeCheck['id']) => void;
}) {
  const checks = useMemo(() => organizeChecklist(entry, schema), [entry, schema]);
  const outstanding = checks.filter((c) => !c.done);

  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="organize-checklist">
      {checks.map((c) => {
        // Only a check this panel actually holds a control for can be acted
        // on. The rest stay text — and NOTHING outstanding is drawn as a
        // hollow ring any more: a ring is the shape of an unchecked box, so
        // every item read as a form field that ignored clicks.
        const fixable = !c.done && (c.id === 'type' || c.id === 'status');
        const glyph = (
          <span className={`flex-none pt-[1px] ${c.done ? 'text-success-600' : 'text-n-400'}`}>
            <Icon name={c.done ? 'circle-check' : 'minus'} size={13} />
          </span>
        );
        const text = (
          <span className="min-w-0 text-left">
            <span className={`block text-sm ${c.done ? 'text-n-500' : 'font-medium text-n-800'}`}>
              {c.label}
            </span>
            {!c.done && (
              <span className="mt-0.5 block text-2xs leading-[15px] text-n-500">{c.hint}</span>
            )}
          </span>
        );
        return (
          <li key={c.id} className="flex">
            {fixable ? (
              <button
                type="button"
                data-testid={`checklist-fix-${c.id}`}
                onClick={() => onFix(c.id)}
                className="-mx-1 flex w-full gap-2 rounded-sm border-0 bg-transparent px-1 py-0.5 text-left hover:bg-n-50"
              >
                {glyph}
                {text}
                <span className="ml-auto flex-none pt-[1px] text-cortex-600">
                  <Icon name="chevron-right" size={13} />
                </span>
              </button>
            ) : (
              <span className="flex w-full gap-2 px-0 py-0.5">
                {glyph}
                {text}
              </span>
            )}
          </li>
        );
      })}
      {outstanding.length === 0 && (
        <li className="pt-1 text-xs text-success-600">Ready — this note will be findable later.</li>
      )}
    </ul>
  );
}

/** Right-hand organize pane: checklist, type, then the type's own fields. */
function OrganizePanel({
  entry,
  schema,
  onFile,
}: {
  entry: Entry;
  schema: Schema;
  /** Files the capture through the page, which owns the undo affordance. */
  onFile: (path: string) => void;
}) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const proposal = useUiStore((s) => s.proposals[entry.path]);
  const askAgent = useUiStore((s) => s.askAgent);
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

  // The checklist sits at the far end of the panel from the controls it talks
  // about — "Has a type" was ~800px from the TYPE select. These let an
  // outstanding item carry you to its own control instead of describing it.
  const typeField = useRef<HTMLLabelElement>(null);
  const typeFields = useRef<HTMLDivElement>(null);
  const fixCheck = (id: OrganizeCheck['id']) => {
    const root = id === 'type' ? typeField.current : typeFields.current;
    if (root === null) return;
    root.scrollIntoView({ block: 'nearest' });
    root.querySelector<HTMLElement>('select, input, textarea, button')?.focus();
  };

  return (
    <aside
      aria-label="Organize"
      className="flex w-[272px] flex-none flex-col overflow-y-auto border-l border-n-200 px-4 pb-5 pt-3.5 @[1100px]/canvas:w-[300px] @[1360px]/canvas:w-[320px]"
    >
      {/* Type leads, and the type's own fields follow it, because assigning a
          type is the whole job here — everything else on this panel is either
          advice about that decision or something to do once it is made. The
          checklist used to sit above it, which put a list of instructions
          between you and the one control you came for. */}
      {/* A real <label> wrapping the control, not a caption beside it: Select
          forwards no id or aria-label, so the only way to name the Inbox's
          most important control without touching the shared component is the
          implicit association a wrapping label gives. Clicking "Type" now
          focuses the dropdown too. */}
      <label ref={typeField} className="flex items-center gap-2">
        <span className="flex-none text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
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
      </label>

      {/* Once typed, the type's declared fields are the rest of the form —
          the same property stack the record surfaces use, not a second one. */}
      {entry.type !== null && (
        <div ref={typeFields} className="mt-3 border-t border-n-100 pt-3">
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
        <div className="border-t border-n-100 pt-3">
          <KnowledgeCommit entry={entry} />
        </div>

        <div className="border-t border-n-100 pt-3">
          <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
            Before you file
          </div>
          {/* Said out loud, because a list of unmet items reads as a blocker
              until something tells you it is not one. */}
          <div className="pb-1.5 text-2xs text-n-400">
            Advisory — you can file with items outstanding.
          </div>
          <OrganizeChecklist entry={entry} schema={schema} onFix={fixCheck} />
        </div>

        <div className="flex flex-col gap-2 border-t border-n-100 pt-3">
          {proposal === undefined && (
            <Button
              variant="secondary"
              icon="sparkles"
              onClick={() => {
                askAgent(organizePrompt(entry.path), entry.path);
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
                askAgent(
                  fetchRefsPrompt(
                    entry.path,
                    unresolved.map((r) => r.id),
                  ),
                  entry.path,
                );
              }}
            >
              {`Fetch ${unresolved.length} reference${unresolved.length === 1 ? '' : 's'}`}
            </Button>
          )}
          <Button variant="primary" icon="circle-check" onClick={() => onFile(entry.path)}>
            Mark organized
          </Button>
          <span className="text-center text-2xs text-n-400">
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
  const index = queue.entries.findIndex((e) => e.path === selectedPath);

  // Filing is the one action here that removes something from the queue, and
  // the queue is the only place it was visible — so it gets an undo, not a
  // toast that disappears. `toast()` takes a message and nothing else, so the
  // affordance lives on the page where it can hold a button.
  const [lastFiled, setLastFiled] = useState<{ path: string; title: string } | null>(null);
  // Focus follows the file: after ⌘E the row that opened next should be where
  // the keyboard is, or the next Tab restarts at the nav.
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const refocusRow = useRef(false);

  const fileNote = (path: string) => {
    const title = queue.entries.find((e) => e.path === path)?.title ?? 'capture';
    refocusRow.current = true;
    void (async () => {
      await queue.organize(path);
      setLastFiled({ path, title });
    })();
  };
  // Read through a ref by the keydown effect below, which must not re-bind on
  // every render: fileNote closes over the entry list and so is new each time.
  const fileRef = useRef(fileNote);
  fileRef.current = fileNote;

  useEffect(() => {
    if (!refocusRow.current) return;
    refocusRow.current = false;
    if (selectedPath === null) return;
    rowRefs.current.get(selectedPath)?.focus();
  }, [selectedPath]);

  // Cmd/Ctrl+E organizes the open capture — the whole loop is meant to run
  // from the keyboard, so this is the one binding that matters here.
  // Bound once per selection: fileRef keeps the handler out of the deps, and
  // re-binding a window listener on every render is how a single keystroke
  // ends up firing twice.
  useEffect(() => {
    if (selectedPath === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'e') return;
      // The same guard the paste handler uses. ⌘E/Ctrl+E is end-of-line in
      // every text field on this screen — including the capture body right
      // beside the list — and filing what you are typing into is not
      // recoverable from the keyboard.
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]') != null) return;
      e.preventDefault();
      fileRef.current(selectedPath);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedPath]);

  // Arrow keys walk the queue. The rows are a roving tabindex — only the open
  // one is a tab stop, so Tab crosses the list instead of stepping through
  // every capture in it.
  const moveSelection = (to: number) => {
    const list = queue.entries;
    if (list.length === 0) return;
    const path = list[Math.min(Math.max(to, 0), list.length - 1)].path;
    queue.select(path);
    const el = rowRefs.current.get(path);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  };
  const onListKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        moveSelection(index < 0 ? 0 : index + 1);
        break;
      case 'ArrowUp':
        moveSelection(index < 0 ? 0 : index - 1);
        break;
      case 'Home':
        moveSelection(0);
        break;
      case 'End':
        moveSelection(queue.entries.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

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
      <header className="flex flex-none items-center gap-3 border-b border-n-200 px-5 py-2.5">
        {/* h1, like every other page's chrome title — the Inbox used to be
            the one screen whose highest-ranked heading was an h2, so "jump to
            main heading" found nothing here. */}
        <h1 className="m-0 text-lg font-semibold text-n-900">Inbox</h1>
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

      {/* Filing removes the note from the only list that showed it, so the
          way back stays on screen until it is used or dismissed rather than
          riding a toast that times out. */}
      {lastFiled !== null && (
        <div
          data-testid="inbox-undo"
          className="flex flex-none items-center gap-2 border-b border-n-200 bg-n-25 px-5 py-1.5"
        >
          <span className="inline-flex flex-none text-success-600">
            <Icon name="circle-check" size={13} />
          </span>
          <span className="min-w-0 truncate text-xs text-n-600">Filed “{lastFiled.title}”</span>
          <Button
            size="sm"
            variant="secondary"
            icon="undo-2"
            onClick={() => {
              void queue.unorganize(lastFiled.path);
              setLastFiled(null);
            }}
          >
            Undo
          </Button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setLastFiled(null)}
            className="ml-auto inline-flex flex-none border-0 bg-transparent p-1 text-n-400 hover:text-n-700"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {dragDepth > 0 && (
        <div
          data-testid="inbox-dropzone"
          className="pointer-events-none absolute inset-0 z-10 m-3 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-cortex-400 bg-cortex-50"
        >
          <Icon name="file-down" size={22} color="var(--cortex-600)" />
          <span className="text-sm font-medium text-cortex-700">Drop to file in the Inbox</span>
          <span className="text-xs text-n-500">
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
        // Three fixed columns inside a container that could not scroll meant
        // the surplus was simply clipped: at 1024px the reading pane fell to
        // ~100px and the Organize panel — the Type select and "Mark
        // organized" — sat off the right edge with no way to reach it. Now
        // the flanks give width back as the canvas narrows, the reading pane
        // keeps a legible floor, and past the point where they cannot yield
        // any further the row scrolls instead of hiding a control.
        <div className="flex min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
          <div
            role="listbox"
            aria-label="Captures"
            onKeyDown={onListKeyDown}
            className="flex w-[220px] flex-none flex-col overflow-y-auto border-r border-n-200 @[1100px]/canvas:w-[260px] @[1360px]/canvas:w-[300px]"
          >
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
                  // option inside the listbox above, not `row`: role="row"
                  // overrode the button role in a document with no table
                  // anywhere, so the queue announced as rows of nothing.
                  role="option"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  ref={(el) => {
                    if (el === null) rowRefs.current.delete(e.path);
                    else rowRefs.current.set(e.path, el);
                  }}
                  data-testid="inbox-row"
                  data-path={e.path}
                  onClick={() => queue.select(e.path)}
                  className={[
                    'flex flex-col gap-0.5 border-0 border-b border-solid border-n-100 px-4 py-2.5 text-left',
                    active ? 'bg-cortex-50' : 'bg-transparent hover:bg-n-25',
                  ].join(' ')}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {e.parseError !== null && (
                      <span className="inline-flex flex-none text-warn-500">
                        <Icon name="triangle-alert" size={12} />
                      </span>
                    )}
                    {ready && (
                      <span
                        // ⌘E files whatever is OPEN, never the row under the
                        // cursor — the old wording read as an instruction
                        // about this row and filed a different note.
                        title={
                          active
                            ? 'Organized — press ⌘E to file it'
                            : 'Organized — open it to file it'
                        }
                        className="inline-flex flex-none text-success-600"
                      >
                        <Icon name="circle-check" size={12} />
                      </span>
                    )}
                    <span
                      // Titles are how you pick the next capture, and at this
                      // width most of them clip mid-word.
                      title={e.title}
                      className={[
                        'truncate text-sm',
                        ready
                          ? 'font-medium text-n-500'
                          : active
                            ? 'font-semibold text-n-900'
                            : 'font-medium text-n-800',
                      ].join(' ')}
                    >
                      {e.title}
                    </span>
                  </span>
                  {e.snippet !== '' && (
                    <span className="truncate text-xs text-n-500">{e.snippet}</span>
                  )}
                  <span className="flex items-center gap-2 text-2xs text-n-400">
                    <span>{e.createdAt.slice(0, 10)}</span>
                    {/* M7: what the agent wrote is labelled, so the review
                        queue never hides machine output among your own. */}
                    {isAgentWritten(e) && (
                      <span
                        data-testid="from-ai"
                        className="inline-flex items-center gap-1 text-synapse-600"
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
                        className="inline-flex items-center gap-1 text-cortex-600"
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

          <div className="min-h-0 min-w-[360px] flex-1 overflow-y-auto pb-10 pt-6">
            <div className="mx-auto w-full max-w-[760px] px-6">
              {/* Which capture this is, and where it sits in the queue. The
                  pane used to name it nowhere — the only clue was the
                  highlighted row off to the left, and "Mark organized" takes
                  it out of the list you would check against. */}
              <div
                data-testid="inbox-pane-header"
                className="mb-4 flex items-baseline gap-3 border-b border-n-100 pb-2"
              >
                <span className="min-w-0 flex-1">
                  <span
                    title={selected.title}
                    className={`block truncate text-md font-semibold ${
                      hasRealTitle(selected) ? 'text-n-900' : 'text-n-500 italic'
                    }`}
                  >
                    {hasRealTitle(selected) ? selected.title : '(untitled capture)'}
                  </span>
                  <span className="block text-2xs text-n-500">
                    Captured {selected.createdAt.slice(0, 10)}
                  </span>
                </span>
                <span className="flex-none text-2xs tabular-nums text-n-500">
                  {index + 1} of {queue.entries.length}
                </span>
                <span className="flex flex-none items-center gap-0.5">
                  <button
                    type="button"
                    aria-label="Previous capture"
                    disabled={index <= 0}
                    onClick={() => moveSelection(index - 1)}
                    className="inline-flex border-0 bg-transparent p-1 text-n-500 hover:text-n-800 disabled:opacity-40"
                  >
                    <Icon name="chevron-up" size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label="Next capture"
                    disabled={index < 0 || index >= queue.entries.length - 1}
                    onClick={() => moveSelection(index + 1)}
                    className="inline-flex border-0 bg-transparent p-1 text-n-500 hover:text-n-800 disabled:opacity-40"
                  >
                    <Icon name="chevron-down" size={14} />
                  </button>
                </span>
              </div>
              <NoteBodyEditor key={selected.path} path={selected.path} />
              <button
                type="button"
                onClick={() => navigate({ kind: 'doc', path: selected.path })}
                className="mt-6 inline-flex items-center gap-1.5 border-0 bg-transparent p-0 text-xs text-n-500 hover:text-n-800"
              >
                <Icon name="external-link" size={12} />
                Open as document
              </button>
            </div>
          </div>

          <OrganizePanel entry={selected} schema={schema} onFile={fileNote} />
        </div>
      )}
    </div>
  );
}
