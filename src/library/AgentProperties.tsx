import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useEscapeLayer } from '@/components/ui/Popover';
import { Select } from '@/components/ui/Select';
import { PropertyRow } from '@/detail/PropertyRow';
import { agentHandle } from '@/engine/agents';
import { parseConnectors, type ConnectorSpec } from '@/engine/connectors';
import { agentDraft, agentPatch, type AgentDraft, type AgentKey } from '@/engine/libraryDraft';
import {
  holdsProposalTools,
  matchedToolset,
  proposalConsequence,
  TOOLSETS,
  writesAnything,
} from '@/engine/tools';
import { describeTrigger, type Trigger } from '@/engine/triggers';
import { isRecordEntry } from '@/engine/typeCatalog';
import type { Entry } from '@/engine/types';
import { deepEqual } from '@/lib/deepEqual';
import { readConnectors } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { useVaultStore } from '@/stores/vaultStore';
import { GuardRow, TextField } from './chrome';
import { Picker, type PickerOption } from './Picker';
import { ScheduleField } from './ScheduleField';

/** The tool picker's group for connector tools (M54.9). */
const CONNECTOR_GROUP = 'Connectors';

/**
 * An agent page's properties (M55.12; the agent builder of M18, rebuilt in
 * M18.4).
 *
 * Building an agent used to be writing a markdown file and knowing the
 * frontmatter grammar by heart, which meant the two halves that actually make
 * an agent safe — `scope:` and `when:` — were the two nobody wrote. The first
 * pass gave them a form; M18.4 gave them PICKERS, because a form made of
 * comma-separated text boxes has the same defect the property table had: it
 * asks you to hold the vault's folder list and thirteen tool identifiers in
 * your head, and it fails silently when you get one wrong.
 *
 * Every axis is answered from something real:
 *
 * - **Scope** — folders that exist in this vault, with the count in each.
 * - **Tools** — the catalog the MCP server actually serves (engine/tools,
 *   read off the tool manifest the server serves from), and one "Every
 *   <name> tool" per enabled connector (M54.9).
 * - **Connectors** — the servers `.cerebro/connectors.json` has enabled. A
 *   run reaches one only once it is also approved on this machine, and is
 *   granted its tools by the name the CLI hears (M54.9).
 * - **Triggers** — events, folders and field values from the vault's schema.
 *
 * The boundaries live beside the instructions rather than in a settings page,
 * and that is deliberate: `scope:` is not a preference. It is the answer to
 * "what can this thing damage", it is enforced in Rust before a write reaches
 * disk, and it belongs on the same page as the prose that decides what the
 * agent will try to do.
 *
 * ## Why a grant writes on Done, and only its own key
 *
 * Everywhere else on a page writes as you type. A grant cannot: a half-typed
 * `scope:` is a boundary that is briefly wrong, a half-built trigger fires on
 * the wrong thing (a bare `{event: changed}` is valid and fires on every
 * change), and both are read by a background runner that does not wait for
 * you to finish. So each row opens an editor in place that holds a draft,
 * seeded from the record when it opens; Done writes only that row's key(s)
 * through `agentPatch`, Cancel and Escape discard, and a click elsewhere or a
 * rescan touches neither the file nor the draft. The description is one line
 * of prose and commits on blur.
 */
export function AgentProperties({ entry }: { entry: Entry }) {
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const [connectorSpecs, setConnectorSpecs] = useState<ConnectorSpec[]>([]);
  // Read on open rather than held in a store: the connector list lives in the
  // vault's own `.cerebro/connectors.json`, is edited on another screen, and is
  // small. Failing quietly to an empty list is right — the picker then says
  // "this vault has no connectors enabled", which is also what a broken config
  // means for a run (connectors.rs fails closed on an unreadable file).
  useEffect(() => {
    if (vaultPath === null) return;
    let live = true;
    void readConnectors(vaultPath)
      .then((raw) => {
        if (live) setConnectorSpecs(parseConnectors(raw));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [vaultPath]);
  const vault = useMemo(() => vaultOptions(entries, connectorSpecs), [entries, connectorSpecs]);

  // Parsed on every render: the closed rows always say what the FILE says.
  const draft = agentDraft(entry, '');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const show = (key: string) => setOpen((s) => new Set(s).add(key));
  const hide = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });

  const write = (next: AgentDraft, keys: readonly AgentKey[]): Promise<boolean> =>
    patchFrontmatter(entry.path, agentPatch(next, keys));

  const derived = slugify(entry.title);
  const handle = agentHandle(entry);
  const folderOptions: PickerOption[] = vault.folders.map((f) => ({
    value: f.path,
    label: f.path,
    icon: 'folder',
    meta: `${f.count}`,
  }));

  /** One boundary row: its closed words, and its editor when open. */
  const boundary = (
    key: string,
    name: string,
    icon: string,
    keys: readonly AgentKey[],
    closed: React.ReactNode,
    editor: (d: AgentDraft, set: (next: AgentDraft) => void) => React.ReactNode,
  ) => (
    <div data-testid={`agent-prop-${key}`}>
      <PropertyRow kind="text" name={name} icon={icon}>
        <button
          type="button"
          data-testid="agent-prop-open"
          aria-expanded={open.has(key)}
          onClick={() => show(key)}
          className="flex min-h-[34px] w-full min-w-0 items-center rounded-sm border-0 bg-transparent px-1.5 text-left text-sm text-n-800 hover:bg-n-50"
        >
          <span className="min-w-0 flex-1">{closed}</span>
        </button>
      </PropertyRow>
      {open.has(key) && (
        <GrantEditor
          testId={`agent-editor-${key}`}
          seed={draft}
          keys={keys}
          write={write}
          onClose={() => hide(key)}
          render={editor}
        />
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-1">
      <DescriptionRow
        value={draft.description}
        onCommit={(v) => write({ ...draft, description: v }, ['description'])}
      />

      {boundary(
        'identity',
        'Identity',
        'fingerprint',
        ['slug'],
        <>
          process:{handle}{' '}
          <span className="text-n-500">
            · {draft.slug.trim() === '' ? 'derived from the title' : 'fixed'}
          </span>
        </>,
        (d, set) => (
          <div className="flex flex-col gap-1.5">
            <TextField
              testId="agent-slug"
              ariaLabel="Identity"
              value={d.slug}
              onChange={(v) => set({ ...d, slug: v })}
              placeholder={derived}
            />
            <p className="m-0 text-2xs leading-[15px] text-n-500">
              {d.slug.trim() === ''
                ? `Derived from the title — everything this agent writes is attributed to process:${derived || 'untitled'}, and renaming it, or moving it to another folder, splits that history in two. Set one to fix it.`
                : `Fixed. Writes are attributed to process:${slugify(d.slug)} through any rename.`}
            </p>
          </div>
        ),
      )}

      {boundary(
        'schedule',
        'Schedule',
        'clock',
        ['schedule'],
        draft.schedule === ''
          ? draft.triggers.length > 0
            ? 'none — its triggers fire it'
            : 'none — off duty, runs only when you ask'
          : draft.schedule,
        (d, set) => (
          <ScheduleField value={d.schedule} onChange={(v) => set({ ...d, schedule: v })} />
        ),
      )}

      <TriggersRow
        draft={draft}
        open={open}
        show={show}
        hide={hide}
        write={write}
        folders={folderOptions}
        fields={vault.fields}
        valuesFor={vault.valuesFor}
      />

      {boundary(
        'scope',
        'Writes in',
        'pencil',
        ['scope'],
        scopeWords(draft.scope, 'anywhere in the vault', 'nowhere — proposals only'),
        (d, set) => (
          <GuardRow
            label="Limit where this agent can write"
            hint="Folders, and only folders — a prefix is what can be refused without knowing the vault's schema. Off means it may write anywhere in the vault."
            tone="warn"
            checked={d.scope !== null}
            onChange={(on) => set({ ...d, scope: on ? [] : null })}
          >
            <Picker
              testId="agent-scope"
              ariaLabel="Folders this agent may write in"
              addLabel="Add folder"
              emptyLabel="Nowhere — it can write no file in this vault."
              options={folderOptions}
              selected={d.scope ?? []}
              onChange={(next) => set({ ...d, scope: next })}
            />
            <p className="m-0 mt-1.5 text-2xs text-n-500">
              {d.scope !== null && d.scope.length === 0
                ? 'It can still record findings in Knowledge, which has its own guard.'
                : `Writes anywhere under ${(d.scope ?? []).join(' or ')} and nowhere else.`}
            </p>
          </GuardRow>
        ),
      )}

      {/* M36.3 — the READ axis, its own row. Cerebro's tools have refused
          past it since M34.4; the CLI's own Read, Glob and Grep read around
          it until M53.5 withdrew them, with the shell, from every read-scoped
          run. Deliberately not folded into the write row: the normal agent
          reads broadly and writes narrowly, so one switch for both would make
          the safest write scope also the blindest reader. */}
      {boundary(
        'read-scope',
        'Reads',
        'eye',
        ['readScope'],
        scopeWords(draft.readScope, 'everything', 'nothing'),
        (d, set) => (
          <GuardRow
            label="Limit where this agent can read"
            hint="The same folder grammar as writing, on its own axis. Off means it may read the whole vault. Refused in cerebro before a note's body is served — searches say how many hits were withheld rather than pretending they do not exist. The CLI's own Read, Glob and Grep are withdrawn too, and so is the shell."
            tone="warn"
            checked={d.readScope !== null}
            onChange={(on) => set({ ...d, readScope: on ? [] : null })}
          >
            <Picker
              testId="agent-read-scope"
              ariaLabel="Folders this agent may read from"
              addLabel="Add folder"
              emptyLabel="Nothing — it can read no note in this vault."
              options={folderOptions}
              selected={d.readScope ?? []}
              onChange={(next) => set({ ...d, readScope: next })}
            />
            <p className="m-0 mt-1.5 text-2xs text-n-500">
              {d.readScope !== null && d.readScope.length === 0
                ? 'It can still be handed material in its task — it just cannot go looking.'
                : `Reads anywhere under ${(d.readScope ?? []).join(' or ')} and nowhere else.`}
            </p>
          </GuardRow>
        ),
      )}

      {boundary(
        'tools',
        'Tools',
        'wrench',
        ['allowedTools'],
        draft.allowedTools === null
          ? 'unrestricted'
          : draft.allowedTools.length === 0
            ? 'none'
            : `${draft.allowedTools.length} granted: ${draft.allowedTools.join(', ')}`,
        (d, set) => (
          <ToolsEditor draft={d} set={set} connectors={vault.connectors} />
        ),
      )}

      {boundary(
        'connectors',
        'Connectors',
        'plug',
        ['connectors'],
        <>
          {draft.connectors === null
            ? // M54.9: a run nobody watches reaches only connectors its
              // record names; a turn you address it in, every approved one.
              'none on its own; every approved one when you address it'
            : draft.connectors.length === 0
              ? 'none'
              : draft.connectors.join(', ')}
          {/* M54.9 — the record's `disallowed-tools:`, shown and never
              written: no AgentKey names it. */}
          {draft.disallowedTools !== null && draft.disallowedTools.length > 0 && (
            <span data-testid="agent-never-calls" className="mt-0.5 block text-2xs text-n-600">
              <span className="font-medium text-n-800">Never calls:</span>{' '}
              {draft.disallowedTools.join(', ')}
              <span className="mt-0.5 block text-n-500">
                From disallowed-tools: in the file, and edited there. Only connector tools count,
                each spelled exactly as its server names it, and no allow rule of yours can undo
                one.
              </span>
            </span>
          )}
        </>,
        (d, set) => (
          <GuardRow
            label="Limit which connectors this agent can reach"
            hint="Which outside systems it may act in for you: a connector’s tools can change things there, not only read them. Off, it reaches no connector when it runs on its own, and every one that is on and approved here in a turn you address it in. Narrow a connector to single tools under Tools — your own Claude Code allow rules can widen that pick, and only a disallowed-tools: entry in the file binds against them."
            tone="warn"
            checked={d.connectors !== null}
            onChange={(on) => set({ ...d, connectors: on ? [] : null })}
          >
            {vault.connectors.length === 0 ? (
              <p className="m-0 text-2xs text-n-500">
                This vault has no connectors enabled. Add them in Settings; an empty list here means
                this agent reaches none of them either way.
              </p>
            ) : (
              <Picker
                testId="agent-connectors"
                ariaLabel="Connectors this agent may reach"
                addLabel="Add connector"
                emptyLabel="None — it reaches no external system."
                options={vault.connectors.map((c) => ({
                  value: c.name,
                  label: c.name,
                  hint:
                    c.transport === 'stdio'
                      ? 'Runs a command on this machine'
                      : 'Reaches a server over HTTP',
                  icon: 'plug',
                }))}
                selected={d.connectors ?? []}
                onChange={(next) => set({ ...d, connectors: next })}
              />
            )}
          </GuardRow>
        ),
      )}

      {boundary(
        'shell',
        'Shell',
        'terminal',
        ['shell'],
        draft.shell
          ? 'host tools, capped by the Settings ceiling; withdrawn by a read limit'
          : 'off',
        (d, set) => (
          <GuardRow
            label="Let this agent run shell commands"
            hint="The host tools, still capped by the ceiling in Settings. Unattended runs with shell access can do anything your account can. A read limit withdraws it: a shell reads past any folder list."
            tone="warn"
            checked={d.shell}
            onChange={(on) => set({ ...d, shell: on })}
          />
        ),
      )}
    </div>
  );
}

function scopeWords(scope: string[] | null, anywhere: string, nowhere: string): string {
  if (scope === null) return anywhere;
  if (scope.length === 0) return nowhere;
  return scope.map((f) => `${f}/`).join(', ');
}

/** The one prose row: commits on blur or Enter when it changed; Escape puts
 * back what the file says. Re-seeded from the record only while not focused,
 * so a rescan never eats what you are typing. */
function DescriptionRow({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  const reverting = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);

  return (
    <div data-testid="agent-prop-description">
      <PropertyRow kind="text" name="Description" icon="align-left" align="center">
        <input
          data-testid="agent-description"
          aria-label="Description"
          value={text}
          placeholder="Watches open risks for anything that threatens a release"
          onFocus={() => {
            focused.current = true;
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.stopPropagation();
              reverting.current = true;
              setText(value);
              e.currentTarget.blur();
            }
          }}
          onBlur={() => {
            focused.current = false;
            if (reverting.current) {
              reverting.current = false;
              return;
            }
            if (text.trim() !== value.trim()) void onCommit(text);
          }}
          className="h-[34px] w-full min-w-0 rounded-sm border-0 bg-transparent px-1.5 text-sm text-n-800 outline-none placeholder:text-n-400 hover:bg-n-50 focus:bg-n-50"
        />
      </PropertyRow>
    </div>
  );
}

/**
 * A grant's editor, open in place under its row. The draft is seeded ONCE,
 * from the record as it was when the row opened, so a rescan never resets it.
 */
function GrantEditor({
  testId,
  seed,
  keys,
  write,
  onClose,
  render,
}: {
  testId: string;
  seed: AgentDraft;
  keys: readonly AgentKey[];
  write: (next: AgentDraft, keys: readonly AgentKey[]) => Promise<boolean>;
  onClose: () => void;
  render: (d: AgentDraft, set: (next: AgentDraft) => void) => React.ReactNode;
}) {
  const [draft, setDraft] = useState(seed);
  const [start] = useState(seed);
  const [busy, setBusy] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  // Escape discards — after an open picker inside has taken its own Escape.
  useEscapeLayer(onClose, { contains: (node) => shell.current?.contains(node) === true });

  const done = () => {
    if (busy) return;
    if (deepEqual(agentPatch(draft, keys), agentPatch(start, keys))) {
      onClose();
      return;
    }
    setBusy(true);
    void write(draft, keys).then((ok) => {
      setBusy(false);
      // Refused: the store said why; the draft stays to be fixed.
      if (ok) onClose();
    });
  };

  return (
    <EditorShell shellRef={shell} testId={testId} busy={busy} onDone={done} onCancel={onClose}>
      {render(draft, setDraft)}
    </EditorShell>
  );
}

function EditorShell({
  shellRef,
  testId,
  busy,
  onDone,
  onCancel,
  children,
}: {
  shellRef: React.RefObject<HTMLDivElement | null>;
  testId: string;
  busy: boolean;
  onDone: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={shellRef}
      data-testid={testId}
      className="mb-2 ml-[124px] flex flex-col gap-2 rounded-lg border border-n-200 bg-n-0 p-3"
    >
      {children}
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** The Tools editor: the catalog, the connectors' tools, and the sentences a
 * tool picker owes you. */
function ToolsEditor({
  draft,
  set,
  connectors,
}: {
  draft: AgentDraft;
  set: (next: AgentDraft) => void;
  connectors: { name: string; transport: string }[];
}) {
  // M54.9: a connector's tools are granted by name, so the picker offers one
  // entry per enabled connector for all of them, and a single tool already
  // in the file (`mcp__<name>__<tool>`) reads as known rather than as a name
  // the vault does not have. Rust matches either against the run's merged
  // connectors and drops what names none.
  const connectorToolOptions: PickerOption[] = [
    ...connectors.map((c) => ({
      value: `mcp__${c.name}`,
      label: `Every ${c.name} tool`,
      hint: 'Whatever tools the server lists, now and later.',
      group: CONNECTOR_GROUP,
      icon: 'plug',
    })),
    ...(draft.allowedTools ?? []).flatMap((value) => {
      const owner = connectors.find(
        (c) => value.startsWith(`mcp__${c.name}__`) && value.length > `mcp__${c.name}__`.length,
      );
      if (owner === undefined) return [];
      const tool = value.slice(`mcp__${owner.name}__`.length);
      return [
        {
          value,
          label: `${tool} (${owner.name})`,
          hint: `One ${owner.name} tool, as the server names it.`,
          group: CONNECTOR_GROUP,
          icon: 'plug',
        },
      ];
    }),
  ];
  const toolOptions: PickerOption[] = [
    ...TOOLSETS.flatMap((set_) =>
      set_.tools.map((tool) => ({
        value: tool.name,
        label: tool.name,
        hint: tool.summary,
        group: set_.label,
        icon: tool.writes ? 'pencil' : 'eye',
      })),
    ),
    ...connectorToolOptions,
  ];
  const toolGroupHints: Record<string, string> = {
    ...Object.fromEntries(TOOLSETS.map((s) => [s.label, s.hint])),
    [CONNECTOR_GROUP]: 'Tools of the connectors this vault has on, granted by name.',
  };
  const preset = draft.allowedTools === null ? null : matchedToolset(draft.allowedTools);
  const reachesOutside = (draft.allowedTools ?? []).some((value) =>
    connectorToolOptions.some((option) => option.value === value),
  );

  return (
    <GuardRow
      label="Restrict this agent to specific tools"
      hint="A narrowing of the policy the run already has. Never a widening."
      tone="warn"
      checked={draft.allowedTools !== null}
      onChange={(on) => set({ ...draft, allowedTools: on ? [] : null })}
    >
      <Picker
        testId="agent-allowed-tools"
        ariaLabel="Tools this agent may use"
        addLabel="Add tools"
        emptyLabel="No tools at all — it can read nothing and write nothing."
        options={toolOptions}
        groupHint={toolGroupHints}
        selected={draft.allowedTools ?? []}
        onChange={(next) => set({ ...draft, allowedTools: next })}
      />
      {draft.allowedTools !== null && draft.allowedTools.length > 0 && (
        <p className="m-0 mt-1.5 text-2xs text-n-500" data-testid="agent-tools-summary">
          {preset !== null ? `${preset.label}. ` : ''}
          {writesAnything(draft.allowedTools)
            ? 'This selection can change files in your vault.'
            : 'Read-only: nothing in this selection changes a file.'}
          {reachesOutside ? ' Connector tools can change things outside your vault.' : ''}
          {/* M54.9: a run nobody watches reaches only the connectors its
              record names, so a pick here does nothing on a schedule until
              the connector is named in the Connectors row below too. */}
          {reachesOutside && draft.connectors === null
            ? ' On its own it reaches none of them until you name the connector below.'
            : ''}
        </p>
      )}
      {/* M36.5 — consequence, not membership: what this agent's proposals DO,
          with counts derived from the shared policy artifact so this sentence
          and the channel's behavior cannot drift. Armed agents only — an
          unarmed agent gets no table about weapons it does not carry. */}
      {holdsProposalTools(draft.allowedTools) &&
        (() => {
          const { applies, queues } = proposalConsequence();
          return (
            <div
              data-testid="agent-consequence"
              className="mt-2 flex flex-col gap-0.5 rounded-xs border border-n-200 px-2.5 py-2 text-2xs text-n-600"
            >
              <span>
                Applies on its own once committed — {applies} low- and medium-risk operations.
              </span>
              <span>Queues for you — {queues} high-risk operations, decided on a card.</span>
              <span>
                Locked — people only: no operation can mark a concept verified. Verification is your
                stamp.
              </span>
              <span>
                Revising a page a person has verified always queues, whatever the operation.
              </span>
            </div>
          );
        })()}
    </GuardRow>
  );
}

/**
 * The Triggers row: one sentence per standing trigger, each opening its own
 * editor. "Add trigger" opens a new draft that reaches the file only on Done —
 * a bare `{event: changed}` is valid, and fires on every change.
 */
function TriggersRow({
  draft,
  open,
  show,
  hide,
  write,
  folders,
  fields,
  valuesFor,
}: {
  draft: AgentDraft;
  open: ReadonlySet<string>;
  show: (key: string) => void;
  hide: (key: string) => void;
  write: (next: AgentDraft, keys: readonly AgentKey[]) => Promise<boolean>;
  folders: PickerOption[];
  fields: string[];
  valuesFor: (field: string) => string[];
}) {
  const editor = (key: string, index: number | null) => (
    <TriggerEditor
      key={key}
      testId={`agent-editor-${key}`}
      index={index ?? draft.triggers.length}
      seed={index === null ? { event: 'changed' } : draft.triggers[index]}
      folders={folders}
      fields={fields}
      valuesFor={valuesFor}
      onClose={() => hide(key)}
      // Built against the record as it stands at Done, so another row's
      // write since this one opened is kept.
      onDone={(trigger) =>
        write(
          {
            ...draft,
            triggers:
              index === null
                ? [...draft.triggers, trigger]
                : draft.triggers.map((t, n) => (n === index ? trigger : t)),
          },
          ['triggers'],
        )
      }
      onRemove={
        index === null
          ? null
          : () =>
              write({ ...draft, triggers: draft.triggers.filter((_, n) => n !== index) }, [
                'triggers',
              ])
      }
    />
  );

  return (
    <div data-testid="agent-prop-triggers">
      <PropertyRow kind="text" name="Triggers" icon="zap">
        <div className="flex min-h-[34px] flex-col justify-center gap-0.5">
          {draft.triggers.length === 0 && (
            <span className="px-1.5 text-sm text-n-500">
              none — add one to have it react to the vault changing
            </span>
          )}
          {draft.triggers.map((trigger, i) => (
            <div key={i}>
              <button
                type="button"
                data-testid="agent-trigger-line"
                aria-expanded={open.has(`trigger-${i}`)}
                onClick={() => show(`trigger-${i}`)}
                className="flex w-full min-w-0 items-start gap-1.5 rounded-sm border-0 bg-transparent px-1.5 py-1 text-left text-sm text-n-800 hover:bg-n-50"
              >
                <Icon name="zap" size={12} color="var(--synapse-500)" />
                <span className="min-w-0 flex-1">{describeTrigger(trigger)}</span>
              </button>
            </div>
          ))}
          <button
            type="button"
            data-testid="agent-add-trigger"
            onClick={() => show('trigger-new')}
            className="inline-flex w-fit items-center gap-1 rounded-sm border-0 bg-transparent px-1.5 py-1 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
          >
            <Icon name="plus" size={12} />
            Add trigger
          </button>
        </div>
      </PropertyRow>
      {draft.triggers.map((_, i) => (open.has(`trigger-${i}`) ? editor(`trigger-${i}`, i) : null))}
      {open.has('trigger-new') && editor('trigger-new', null)}
    </div>
  );
}

function TriggerEditor({
  testId,
  index,
  seed,
  folders,
  fields,
  valuesFor,
  onClose,
  onDone,
  onRemove,
}: {
  testId: string;
  index: number;
  seed: Trigger;
  folders: PickerOption[];
  fields: string[];
  valuesFor: (field: string) => string[];
  onClose: () => void;
  onDone: (trigger: Trigger) => Promise<boolean>;
  /** Null for a new draft, which has nothing on disk to remove. */
  onRemove: (() => Promise<boolean>) | null;
}) {
  const [trigger, setTrigger] = useState(seed);
  const [start] = useState(seed);
  const [busy, setBusy] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  useEscapeLayer(onClose, { contains: (node) => shell.current?.contains(node) === true });

  const settle = (pending: Promise<boolean>) => {
    setBusy(true);
    void pending.then((ok) => {
      setBusy(false);
      if (ok) onClose();
    });
  };
  const done = () => {
    if (busy) return;
    if (onRemove !== null && deepEqual(trigger, start)) {
      onClose();
      return;
    }
    settle(onDone(trigger));
  };
  const remove = () => {
    if (busy) return;
    if (onRemove === null) onClose();
    else settle(onRemove());
  };

  return (
    <EditorShell shellRef={shell} testId={testId} busy={busy} onDone={done} onCancel={onClose}>
      <TriggerRow
        index={index}
        trigger={trigger}
        folders={folders}
        fields={fields}
        valuesFor={valuesFor}
        onChange={(patch) => {
          const next = { ...trigger, ...patch };
          // An undefined clause is an ABSENT clause, not an empty one: a
          // trigger carrying `field: ''` would never match anything and would
          // look, in the file, exactly like one that was meant to.
          for (const key of Object.keys(next) as (keyof Trigger)[]) {
            if (next[key] === undefined || next[key] === '') delete next[key];
          }
          setTrigger(next);
        }}
        onRemove={remove}
      />
    </EditorShell>
  );
}

/**
 * One trigger, built from clauses rather than typed.
 *
 * Layer one is deliberately a small deterministic grammar — event, folder,
 * field, value — because a person should be able to say what will fire an agent
 * WITHOUT running it. Every clause is therefore a picker over something real:
 * the folders in this vault, the property names its records carry, the values
 * that property has actually held. The one free-text field is `ask:`, which is
 * layer two, is answered by a model, and is prose on purpose.
 */
function TriggerRow({
  index,
  trigger,
  folders,
  fields,
  valuesFor,
  onChange,
  onRemove,
}: {
  index: number;
  trigger: Trigger;
  folders: PickerOption[];
  fields: string[];
  valuesFor: (field: string) => string[];
  onChange: (patch: Partial<Trigger>) => void;
  onRemove: () => void;
}) {
  const values = trigger.field === undefined ? [] : valuesFor(trigger.field);
  return (
    <div data-testid="agent-trigger" className="rounded-lg border border-n-200 bg-n-25 p-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-n-600">
        <span>When a record is</span>
        <Select
          size="sm"
          width={116}
          value={trigger.event ?? 'any'}
          ariaLabel={`Trigger ${index + 1} event`}
          onChange={(e) =>
            onChange({
              event: e.target.value === 'any' ? undefined : (e.target.value as Trigger['event']),
            })
          }
          options={[
            { value: 'any', label: 'touched' },
            { value: 'created', label: 'created' },
            { value: 'changed', label: 'changed' },
            { value: 'moved', label: 'moved' },
          ]}
        />
        <span className="flex-1" />
        <button
          type="button"
          aria-label={`Remove trigger ${index + 1}`}
          onClick={onRemove}
          className="rounded-xs border-0 bg-transparent p-1 text-n-400 hover:bg-n-50 hover:text-n-700"
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-n-600">
        <span className="w-9">in</span>
        <Picker
          testId={`trigger-folder-${index}`}
          ariaLabel="Folder to watch"
          addLabel="Pick a folder"
          emptyLabel="Anywhere in the vault"
          options={folders}
          // One folder, but the same picker: `in:` is a single prefix in the
          // grammar, so the last one picked wins rather than silently
          // dropping the choice.
          selected={trigger.in === undefined ? [] : [trigger.in]}
          onChange={(next) => onChange({ in: next.at(-1) ?? undefined })}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-n-600">
        <span className="w-9">and its</span>
        <Select
          size="sm"
          width={150}
          value={trigger.field ?? ''}
          ariaLabel={`Trigger ${index + 1} field`}
          onChange={(e) => onChange({ field: e.target.value, to: undefined })}
          options={[
            { value: '', label: 'any field' },
            ...fields.map((f) => ({ value: f, label: f })),
          ]}
        />
        <span>became</span>
        {values.length > 0 ? (
          <Select
            size="sm"
            width={150}
            value={trigger.to ?? ''}
            ariaLabel={`Trigger ${index + 1} value`}
            onChange={(e) => onChange({ to: e.target.value })}
            options={[
              { value: '', label: 'any value' },
              ...values.map((v) => ({ value: v, label: v })),
            ]}
          />
        ) : (
          <input
            value={trigger.to ?? ''}
            aria-label={`Trigger ${index + 1} value`}
            placeholder="any value"
            onChange={(e) => onChange({ to: e.target.value })}
            className="w-[150px] rounded-md border border-n-200 bg-n-0 px-2 py-1 font-mono text-2xs text-n-800 outline-none focus-visible:border-cortex-400"
          />
        )}
      </div>

      {/* The two prose fields, in the order they run: whether to act, then
          what acting means for THIS waking. Both optional; a trigger with
          neither is the deterministic clause and nothing else. */}
      <div className="mt-2 flex flex-col gap-1.5">
        <input
          value={trigger.ask ?? ''}
          aria-label={`Trigger ${index + 1} question`}
          placeholder="…and only if: a yes/no question the agent answers first (optional)"
          onChange={(e) => onChange({ ask: e.target.value })}
          className="w-full rounded-md border border-n-200 bg-n-0 px-2 py-1.5 text-2xs text-n-800 outline-none placeholder:text-n-400 focus-visible:border-cortex-400"
        />
        <input
          value={trigger.do ?? ''}
          aria-label={`Trigger ${index + 1} instructions`}
          placeholder="…then do this in particular: added to the standing instructions, not instead of them (optional)"
          onChange={(e) => onChange({ do: e.target.value })}
          className="w-full rounded-md border border-n-200 bg-n-0 px-2 py-1.5 text-2xs text-n-800 outline-none placeholder:text-n-400 focus-visible:border-cortex-400"
        />
      </div>

      {/* The same sentence the library and the run log print. If the summary
          does not match what you meant, the trigger does not either — which is
          the entire value of a deterministic layer. */}
      <p className="m-0 mt-2 flex items-start gap-1.5 text-2xs leading-[15px] text-n-500">
        <Icon name="zap" size={11} color="var(--synapse-500)" />
        {describeTrigger(trigger)}
      </p>
    </div>
  );
}

/**
 * What the pickers pick FROM (M18.4).
 *
 * Derived from the vault rather than typed, which is the whole point: a folder
 * that does not exist, a property nothing carries, and a connector nobody
 * enabled are all values the old text boxes accepted without complaint and that
 * silently did nothing.
 */
export interface VaultOptions {
  folders: { path: string; count: number }[];
  fields: string[];
  valuesFor: (field: string) => string[];
  connectors: { name: string; transport: string }[];
}

export function vaultOptions(entries: Entry[], connectorSpecs: ConnectorSpec[]): VaultOptions {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.folder === '') continue;
    // Every ancestor, not only the immediate parent: `records` is a legitimate
    // scope even when every file lives two levels down, and a picker that only
    // offered leaves would make the broad, common choice unreachable.
    const parts = entry.folder.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('/');
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }

  // Property names records actually carry. Relationship fields included:
  // wikilink-valued properties land in `relationships` (the scanner shape
  // AGENTS.md warns about), and `owner` is exactly the kind of field somebody
  // wants a trigger on.
  const fields = new Set<string>();
  for (const entry of entries) {
    if (!isRecordEntry(entry)) continue;
    for (const key of Object.keys(entry.properties)) fields.add(key);
    for (const key of Object.keys(entry.relationships)) fields.add(key);
  }

  return {
    folders: [...counts.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    fields: [...fields].sort(),
    // Values a field has actually HELD. A trigger on `status: blocked` in a
    // vault whose statuses are open/doing/done fires never, and nothing else
    // in the app would ever say so.
    valuesFor: (field: string) => {
      const seen = new Set<string>();
      for (const entry of entries) {
        const value = entry.properties[field];
        if (typeof value === 'string' && value.trim() !== '') seen.add(value.trim());
      }
      return [...seen].sort().slice(0, 40);
    },
    connectors: connectorSpecs
      .filter((c) => c.enabled)
      .map((c) => ({ name: c.name, transport: c.transport })),
  };
}
