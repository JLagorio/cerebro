import { useWaitingFollowup } from '@/stores/followupStore';
import { agentRef } from '@/engine/agents';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useEscapeLayer } from '@/components/ui/Popover';
import { Select } from '@/components/ui/Select';
import { PropertyRow } from '@/detail/PropertyRow';
import { writesInWords } from '@/engine/agentAccess';
import { agentFieldNames } from '@/engine/assignment';
import { agentHandle, askFirstOf } from '@/engine/agents';
import { parseConnectors, type ConnectorSpec } from '@/engine/connectors';
import { agentDraft, agentPatch, type AgentDraft, type AgentKey } from '@/engine/libraryDraft';
import {
  CLAUDE_CODE_DEFAULT,
  EFFORT_LEVELS,
  effortLabel,
  effortRefusal,
  isEffort,
  isModelName,
  MODEL_SUGGESTIONS,
  modelLabel,
  modelRefusal,
} from '@/engine/runOptions';
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
import { stampActivation, SCHEDULE_STAMP_FAILED } from '@/agent/activation';
import { recordIdentity } from '@/engine/identity';
import { describeScheduleSet, scheduleText } from '@/engine/skills';
import { deepEqual } from '@/lib/deepEqual';
import { readConnectors } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import type { ShellCeiling } from '@/lib/policy/toolApproval';
import { useUiStore } from '@/stores/uiStore';
import { getSchema, useVaultStore } from '@/stores/vaultStore';
import { GuardRow, TextField } from './chrome';
import { Picker, type PickerOption } from './Picker';
import { ScheduleField } from './ScheduleField';

/** The tool picker's group for connector tools (M54.9). */
const CONNECTOR_GROUP = 'Connectors';

type ConnectorInventory =
  | { kind: 'loading' }
  | { kind: 'ready'; specs: ConnectorSpec[]; recorded: boolean }
  | { kind: 'unavailable'; reason: 'read_failed' | 'invalid_configuration' };
const LOADING_CONNECTORS: ConnectorInventory = { kind: 'loading' };
const NO_CONNECTORS: ConnectorSpec[] = [];

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
 * - **Asks first** — `ask-first:`, which the tool-approval table reads
 *   (M57.4): on, its page writes wait for your Allow in the panel and are
 *   refused when it runs on its own; Rust reads the record again before a
 *   run starts, so the page can only tighten it.
 * - **Tools** — the catalog the MCP server actually serves (engine/tools,
 *   read off the tool manifest the server serves from), and one "Every
 *   <name> tool" per enabled connector (M54.9).
 * - **Connectors** — the servers `.cerebro/connectors.json` has enabled. A
 *   run reaches one only once it is also approved on this machine, and is
 *   granted its tools by the name the CLI hears (M54.9).
 * - **Triggers** — events, folders and field values from the vault's schema.
 * - **Model and Effort** — `run-options.v1.json`'s aliases and levels, the
 *   vocabulary Rust refuses a run outside of (M56.5).
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
  const later = useWaitingFollowup(agentRef(entry).actor);
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const [connectorRequest, setConnectorRequest] = useState(0);
  const [connectorRead, setConnectorRead] = useState<{
    vault: string | null;
    request: number;
    inventory: ConnectorInventory;
  } | null>(null);
  // Scope the snapshot during render as well as completion: a newly selected
  // vault must never display the previous vault's connector options, even
  // before its effect runs. Retrying does not remount the grant editors.
  const connectorInventory =
    connectorRead?.vault === vaultPath && connectorRead?.request === connectorRequest
      ? connectorRead.inventory
      : LOADING_CONNECTORS;
  const connectorSpecs =
    connectorInventory.kind === 'ready' ? connectorInventory.specs : NO_CONNECTORS;
  useEffect(() => {
    if (vaultPath === null) return;
    let live = true;
    let reason: 'read_failed' | 'invalid_configuration' = 'read_failed';
    void readConnectors(vaultPath)
      .then((raw) => {
        reason = 'invalid_configuration';
        // The legacy parser intentionally accepts a missing file as empty.
        // A malformed file is instead a failed inventory read for this UI.
        if (raw.trim() !== '') {
          const value: unknown = JSON.parse(raw);
          if (
            value === null ||
            typeof value !== 'object' ||
            !('servers' in value) ||
            value.servers === null ||
            typeof value.servers !== 'object' ||
            Array.isArray(value.servers)
          ) {
            throw new Error('Malformed connector configuration');
          }
        }
        if (live)
          setConnectorRead({
            vault: vaultPath,
            request: connectorRequest,
            inventory: { kind: 'ready', specs: parseConnectors(raw), recorded: raw.trim() !== '' },
          });
      })
      .catch(() => {
        if (live)
          setConnectorRead({
            vault: vaultPath,
            request: connectorRequest,
            inventory: { kind: 'unavailable', reason },
          });
      });
    return () => {
      live = false;
    };
  }, [vaultPath, connectorRequest]);
  const vault = useMemo(() => vaultOptions(entries, connectorSpecs), [entries, connectorSpecs]);

  // Parsed on every render: the closed rows always say what the FILE says.
  const draft = agentDraft(entry, '');
  const missingConnectors = (draft.connectors ?? []).filter(
    (name) => !vault.connectors.some((connector) => connector.name === name),
  );
  const inventoryState =
    connectorInventory.kind !== 'ready'
      ? connectorInventory.kind
      : !connectorInventory.recorded
        ? 'not-recorded'
        : missingConnectors.length > 0
          ? 'partial'
          : vault.connectors.length === 0
            ? 'empty'
            : 'ready';
  // The Settings shell ceiling, which caps what the record declares (M57.2).
  const ceiling = useUiStore((s) => s.agentShell);
  // And the web ceiling, which caps its `tools: web` (M57.7).
  const webAccess = useUiStore((s) => s.agentWebAccess);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const show = (key: string) => setOpen((s) => new Set(s).add(key));
  const hide = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });

  const write = async (next: AgentDraft, keys: readonly AgentKey[]): Promise<boolean> => {
    const saved = await patchFrontmatter(entry.path, agentPatch(next, keys));
    if (
      saved &&
      vaultPath !== null &&
      keys.includes('schedule') &&
      scheduleText(next.schedule) !== scheduleText(entry.properties.schedule)
    ) {
      if (!(await stampActivation(vaultPath, recordIdentity(entry), next.schedule, new Date())))
        useUiStore.getState().toast(SCHEDULE_STAMP_FAILED);
    }
    return saved;
  };

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
    blocked?: (d: AgentDraft) => boolean,
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
          blocked={blocked}
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
        draft.schedule.length === 0
          ? draft.triggers.length > 0
            ? 'none — its triggers fire it'
            : later
              ? 'none — a follow-up waits for Learn on its own to be on'
              : 'none — off duty, runs only when you ask'
          : describeScheduleSet(draft.schedule),
        (d, set) => (
          <div className="flex flex-col gap-2">
            <ScheduleField value={d.schedule} onChange={(v) => set({ ...d, schedule: v })} />
            <p className="m-0 text-2xs text-n-500">
              An agent with neither runs only when you ask it, or when a follow-up it booked comes
              due while Learn on its own is on.
            </p>
          </div>
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
        // M58.6 — what its tools and shell actually reach, never the bare
        // scope: an empty scope still writes Knowledge through its own doors,
        // and the shell can reach past every folder.
        writesInWords(draft, ceiling),
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

      {/* M57.4 — whether its page writes wait for the person's Allow. An
          odd value in the file reads as on until a choice is made, so Done
          writes nothing until one is. */}
      {boundary(
        'ask-first',
        ASK_FIRST_COPY.name,
        'hand',
        ['askFirst'],
        askFirstWords(draft.askFirst, askFirstOf(entry).warning),
        (d, set) => (
          <ChoiceList
            name="agent-ask-first"
            ariaLabel={ASK_FIRST_COPY.name}
            value={d.askFirst === null ? '' : d.askFirst ? 'on' : 'off'}
            options={[
              { value: 'on', label: ASK_FIRST_COPY.on },
              { value: 'off', label: ASK_FIRST_COPY.off },
            ]}
            onChange={(choice) => set({ ...d, askFirst: choice === 'on' })}
          />
        ),
        (d) => d.askFirst === null,
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

      <div
        data-testid="agent-connector-inventory"
        data-state={inventoryState}
        role="status"
        className="flex flex-wrap items-center gap-2 px-1.5 py-2 text-sm text-n-600"
      >
        {inventoryState === 'loading' ? (
          <span>Loading connectors…</span>
        ) : inventoryState === 'unavailable' ? (
          <>
            <span data-testid="section-unavailable">
              Connector inventory unavailable.{' '}
              {connectorInventory.kind === 'unavailable' &&
              connectorInventory.reason === 'invalid_configuration'
                ? 'The configuration could not be parsed. Check it in Settings.'
                : 'The configuration could not be read.'}
            </span>
            <Button size="sm" onClick={() => setConnectorRequest((request) => request + 1)}>
              Retry connectors
            </Button>
          </>
        ) : inventoryState === 'not-recorded' ? (
          <span>Connector configuration not recorded. Add connectors in Settings.</span>
        ) : inventoryState === 'partial' ? (
          <span>Some granted connectors are not enabled here: {missingConnectors.join(', ')}.</span>
        ) : inventoryState === 'empty' ? (
          <span>This vault has no connectors enabled. Add them in Settings.</span>
        ) : (
          <span>
            {vault.connectors.length} {vault.connectors.length === 1 ? 'connector' : 'connectors'}{' '}
            enabled in this vault.
          </span>
        )}
      </div>

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
          <ToolsEditor
            draft={d}
            set={set}
            connectors={vault.connectors}
            inventoryReady={connectorInventory.kind === 'ready'}
          />
        ),
      )}

      {/* M56.5 — what its runs ask Claude Code for. Rust refuses a value
          outside run-options.v1.json before a run starts, so the closed row
          says so rather than letting a schedule fail quietly. */}
      {boundary(
        'model',
        'Model',
        'cpu',
        ['model'],
        modelWords(draft.model),
        (d, set) => (
          <ModelEditor value={d.model} onChange={(model) => set({ ...d, model })} />
        ),
        (d) => modelRefusal(d.model) !== null,
      )}

      {boundary(
        'effort',
        'Effort',
        'gauge',
        ['effort'],
        effortWords(draft.effort),
        (d, set) => (
          <ChoiceList
            name="agent-effort"
            ariaLabel="Effort"
            value={d.effort}
            options={[
              { value: '', label: CLAUDE_CODE_DEFAULT },
              ...EFFORT_LEVELS.map((level) => ({ value: level.id, label: level.label })),
            ]}
            onChange={(effort) => set({ ...d, effort })}
          />
        ),
        (d) => effortRefusal(d.effort) !== null,
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
              unavailableValues={connectorInventory.kind === 'ready' ? [] : (d.connectors ?? [])}
              inventoryUnavailable={connectorInventory.kind !== 'ready'}
              onChange={(next) => set({ ...d, connectors: next })}
            />
          </GuardRow>
        ),
      )}

      {boundary(
        'shell',
        'Shell',
        'terminal',
        ['shell'],
        shellWords(draft.shell, draft.readScope !== null, ceiling),
        (d, set) => (
          <GuardRow
            label="Let this agent run shell commands"
            hint="The host tools, still capped by Shell access in Settings: On runs them, Ask asks first in the panel and leaves scheduled runs without them, Off withholds them. A read limit withdraws it: a shell reads past any folder list."
            tone="warn"
            checked={d.shell}
            onChange={(on) => set({ ...d, shell: on })}
          />
        ),
      )}

      {/* M57.7 — the web, its own row beside the shell. Both write `tools:`,
          each from its own draft, so Done here writes only that key. */}
      {boundary('web', 'Web', 'globe', ['web'], webWords(draft.web, webAccess), (d, set) => (
        <GuardRow
          label="Let this agent search and fetch the web"
          hint="Still capped by Web access in Settings. A fetch can carry what the agent read to any site."
          tone="warn"
          checked={d.web}
          onChange={(on) => set({ ...d, web: on })}
        />
      ))}
    </div>
  );
}

/** The Asks first row's words (M57.4). */
export const ASK_FIRST_COPY = {
  name: 'Asks first',
  on: 'Asks before every page write',
  off: 'Writes without asking',
} as const;

/** The Asks first row's closed words: on, off, or the file's odd value,
 * which reads as on until the person chooses. */
export function askFirstWords(askFirst: boolean | null, warning: string | null): string {
  if (askFirst === null) return warning ?? ASK_FIRST_COPY.on;
  return askFirst ? ASK_FIRST_COPY.on : ASK_FIRST_COPY.off;
}

/** The Shell row's closed words (M57.2): what the agent's runs actually get,
 * its declaration capped by the Settings ceiling and withdrawn by a read
 * limit. */
export function shellWords(declared: boolean, readScoped: boolean, ceiling: ShellCeiling): string {
  if (!declared) return 'off';
  if (readScoped) return 'Withdrawn by its read limit';
  switch (ceiling) {
    case 'on':
      return 'On';
    case 'ask':
      return 'Asks first in the panel; scheduled runs go without';
    case 'off':
      return 'Off in Settings';
  }
}

/** The Web row's closed words (M57.7): what the agent's runs actually get,
 * its declaration capped by Web access in Settings. */
export function webWords(declared: boolean, webAccess: boolean): string {
  if (!declared) return 'No web';
  return webAccess
    ? 'Searches and fetches the web'
    : 'Web access is off in Settings, so it has none.';
}

/** What a stored value Rust would refuse reads as (M56.5). */
function refusedWords(value: string): string {
  return `${value} — Claude Code won't take this; runs are refused until you change it.`;
}

function modelWords(model: string): string {
  if (model === '') return CLAUDE_CODE_DEFAULT;
  return isModelName(model) ? modelLabel(model) : refusedWords(model);
}

function effortWords(effort: string): string {
  if (effort === '') return CLAUDE_CODE_DEFAULT;
  return isEffort(effort) ? effortLabel(effort) : refusedWords(effort);
}

/** One choice of a few, as radio buttons: the closed set a row offers. */
function ChoiceList({
  name,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  name: string;
  ariaLabel: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-col gap-0.5">
      {options.map((option) => (
        <label
          key={option.value}
          className="flex items-center gap-2 rounded-sm px-1.5 py-1 text-sm text-n-800 hover:bg-n-50"
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

/** The Model editor: Claude Code's default, the aliases, or Other — any full
 * model name, which Done refuses while it is not one (M56.5). */
function ModelEditor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const suggested = (v: string) => v === '' || MODEL_SUGGESTIONS.some((m) => m.id === v);
  const [other, setOther] = useState(!suggested(value));
  const [typed, setTyped] = useState(suggested(value) ? '' : value);
  // Never a stored value: a draft read from the file is trimmed.
  const OTHER = ' other';
  return (
    <div className="flex flex-col gap-1.5">
      <ChoiceList
        name="agent-model"
        ariaLabel="Model"
        value={other ? OTHER : value}
        options={[
          { value: '', label: CLAUDE_CODE_DEFAULT },
          ...MODEL_SUGGESTIONS.map((m) => ({ value: m.id, label: m.label })),
          { value: OTHER, label: 'Other' },
        ]}
        onChange={(next) => {
          if (next === OTHER) {
            setOther(true);
            onChange(typed);
          } else {
            setOther(false);
            onChange(next);
          }
        }}
      />
      {other && (
        <>
          <TextField
            testId="agent-model-other"
            ariaLabel="Model name"
            value={typed}
            onChange={(v) => {
              setTyped(v);
              onChange(v);
            }}
            placeholder="claude-sonnet-5"
          />
          <p className="m-0 text-2xs leading-[15px] text-n-500">
            {modelRefusal(typed) ?? 'A full model name, passed to Claude Code as it is written.'}
          </p>
        </>
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
  blocked,
}: {
  testId: string;
  seed: AgentDraft;
  keys: readonly AgentKey[];
  write: (next: AgentDraft, keys: readonly AgentKey[]) => Promise<boolean>;
  onClose: () => void;
  render: (d: AgentDraft, set: (next: AgentDraft) => void) => React.ReactNode;
  /** True while the draft holds a value Done must not write (M56.5). */
  blocked?: (d: AgentDraft) => boolean;
}) {
  const [draft, setDraft] = useState(seed);
  const [start] = useState(seed);
  const [busy, setBusy] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  // Escape discards — after an open picker inside has taken its own Escape.
  useEscapeLayer(onClose, { contains: (node) => shell.current?.contains(node) === true });

  const refused = blocked?.(draft) ?? false;
  const done = () => {
    if (busy || refused) return;
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
    <EditorShell
      shellRef={shell}
      testId={testId}
      busy={busy || refused}
      onDone={done}
      onCancel={onClose}
    >
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
  inventoryReady,
}: {
  draft: AgentDraft;
  set: (next: AgentDraft) => void;
  connectors: { name: string; transport: string }[];
  inventoryReady: boolean;
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
        unavailableValues={
          inventoryReady
            ? []
            : (draft.allowedTools ?? []).filter((value) => value.startsWith('mcp__'))
        }
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
 * An editor open on a trigger already in the file. It is held by the trigger
 * it was seeded from, never by its place in `when:`: another editor's Remove or
 * an outside edit shifts the list under it, and a slot number would then point
 * Done and Remove at a different trigger. `nth` of `copies` tells identical
 * triggers apart.
 */
type OpenTrigger = { id: number; seed: Trigger; nth: number; copies: number; openedAt: number };

/** Where an open editor's trigger sits now, or null when the file no longer
 * holds it as it did — gone, edited, or copied — so no slot can be trusted. */
function locate(triggers: readonly Trigger[], open: OpenTrigger): number | null {
  const at = triggers.flatMap((t, i) => (deepEqual(t, open.seed) ? [i] : []));
  return at.length === open.copies ? at[open.nth] : null;
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
  const [editing, setEditing] = useState<readonly OpenTrigger[]>([]);
  const nextId = useRef(0);
  const placed = editing.map((o) => ({ o, at: locate(draft.triggers, o) }));
  const openAt = (i: number) => placed.some((p) => p.at === i);
  const edit = (i: number) => {
    if (openAt(i)) return;
    const seed = draft.triggers[i];
    const same = draft.triggers.flatMap((t, n) => (deepEqual(t, seed) ? [n] : []));
    const o = {
      id: nextId.current++,
      seed,
      nth: same.indexOf(i),
      copies: same.length,
      openedAt: i,
    };
    setEditing((list) => [...list, o]);
  };
  const close = (id: number) => setEditing((list) => list.filter((o) => o.id !== id));

  // Built against the record as it stands at Done, so another row's write
  // since this one opened is kept; a trigger the file no longer holds as it
  // was writes nothing.
  const replace = (o: OpenTrigger, trigger: Trigger | null): Promise<boolean> => {
    const at = locate(draft.triggers, o);
    if (at === null) return Promise.resolve(false);
    const triggers =
      trigger === null
        ? draft.triggers.filter((_, n) => n !== at)
        : draft.triggers.map((t, n) => (n === at ? trigger : t));
    return write({ ...draft, triggers }, ['triggers']);
  };

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
                aria-expanded={openAt(i)}
                onClick={() => edit(i)}
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
      {/* In list order; an editor whose trigger is gone sits last. The testid
          counts editors in the order they opened, never a slot in `when:`. */}
      {[...placed]
        .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
        .map(({ o, at }) => (
          <TriggerEditor
            key={o.id}
            testId={`agent-editor-trigger-${o.id}`}
            index={at ?? o.openedAt}
            seed={o.seed}
            lost={at === null}
            folders={folders}
            fields={fields}
            valuesFor={valuesFor}
            onClose={() => close(o.id)}
            onDone={(trigger) => replace(o, trigger)}
            onRemove={() => replace(o, null)}
          />
        ))}
      {open.has('trigger-new') && (
        <TriggerEditor
          testId="agent-editor-trigger-new"
          index={draft.triggers.length}
          seed={{ event: 'changed' }}
          lost={false}
          folders={folders}
          fields={fields}
          valuesFor={valuesFor}
          onClose={() => hide('trigger-new')}
          onDone={(trigger) =>
            write({ ...draft, triggers: [...draft.triggers, trigger] }, ['triggers'])
          }
          onRemove={null}
        />
      )}
    </div>
  );
}

function TriggerEditor({
  testId,
  index,
  seed,
  lost,
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
  /** True when the file no longer holds the trigger this editor opened on:
   * Done and Remove write nothing until it is closed and opened again. */
  lost: boolean;
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
  const [error, setError] = useState<string | null>(null);
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
    if (lost) return;
    if (
      trigger.event === 'assigned' &&
      !agentFieldNames(getSchema(useVaultStore.getState().entries)).some(
        (option) => option.field === trigger.field,
      )
    ) {
      setError('Pick the field that assigns it.');
      return;
    }
    settle(onDone(trigger));
  };
  const remove = () => {
    if (busy) return;
    if (onRemove === null) onClose();
    else if (!lost) settle(onRemove());
  };
  const unchanged = onRemove !== null && deepEqual(trigger, start);

  return (
    <EditorShell
      shellRef={shell}
      testId={testId}
      busy={busy || (lost && !unchanged)}
      onDone={done}
      onCancel={onClose}
    >
      {lost && (
        <p role="status" data-testid="agent-trigger-lost" className="text-xs text-n-600">
          This trigger changed in the file since you opened it, so this editor writes nothing.
          Cancel, then open it again.
        </p>
      )}
      {error !== null && (
        <p role="alert" className="m-0 text-xs text-n-600">
          {error}
        </p>
      )}
      <TriggerRow
        index={index}
        trigger={trigger}
        folders={folders}
        fields={fields}
        valuesFor={valuesFor}
        onChange={(patch) => {
          setError(null);
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
 * the folders in this vault, declared Agent relation fields for assignments,
 * and stored property names and values for ordinary changes. The optional
 * `ask:` is a yes/no question answered by the cheap check before the run.
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
  const entries = useVaultStore((state) => state.entries);
  const agentFields = useMemo(() => agentFieldNames(getSchema(entries)), [entries]);
  const assigned = trigger.event === 'assigned';
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
          onChange={(event) =>
            onChange({
              event: event === 'any' ? undefined : (event as Trigger['event']),
              ...(event === 'assigned' ? { field: undefined, to: undefined } : {}),
            })
          }
          options={[
            { value: 'any', label: 'touched' },
            { value: 'created', label: 'created' },
            { value: 'changed', label: 'changed' },
            { value: 'moved', label: 'moved' },
            { value: 'assigned', label: 'assigned to it' },
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
        <span className="w-11 flex-none whitespace-nowrap">in</span>
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

      {assigned ? (
        <div className="mt-2 flex flex-col gap-1.5 text-xs text-n-600">
          <div className="flex items-center gap-1.5">
            <span className="w-11 flex-none whitespace-nowrap">via</span>
            {/* Anything but a declared Agent relation is a field Done refuses,
                so it reads as the placeholder, never as a row; with no such
                relation there is nothing to pick. */}
            <Select
              size="sm"
              width={200}
              value={trigger.field ?? ''}
              ariaLabel={`Trigger ${index + 1} field`}
              placeholder="Pick a field"
              disabled={agentFields.length === 0}
              onChange={(field) => onChange({ field, to: undefined })}
              options={agentFields.map(({ field, label }) => ({ value: field, label }))}
            />
          </div>
          {agentFields.length === 0 && (
            <p data-testid="trigger-no-agent-field" className="m-0 text-xs text-n-500">
              No database has a relation to Agent yet. Add a Relation property related to Agent,
              then pick it here.
            </p>
          )}
          <p className="m-0 text-xs text-n-500">Only links made while Cerebro is open wake it.</p>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-n-600">
          <span className="w-11 flex-none whitespace-nowrap">and its</span>
          <Select
            size="sm"
            width={150}
            value={trigger.field ?? ''}
            ariaLabel={`Trigger ${index + 1} field`}
            onChange={(field) => onChange({ field, to: undefined })}
            options={withHeld(
              [{ value: '', label: 'any field' }, ...fields.map((f) => ({ value: f, label: f }))],
              trigger.field,
            )}
          />
          <span>became</span>
          {values.length > 0 ? (
            <Select
              size="sm"
              width={150}
              value={trigger.to ?? ''}
              ariaLabel={`Trigger ${index + 1} value`}
              onChange={(to) => onChange({ to })}
              options={withHeld(
                [{ value: '', label: 'any value' }, ...values.map((v) => ({ value: v, label: v }))],
                trigger.to,
              )}
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
      )}

      {/* The two prose fields, in the order they run: whether to act, then
          what acting means for THIS waking. Both optional; a trigger with
          neither is the deterministic clause and nothing else. */}
      <div className="mt-2 flex flex-col gap-1.5">
        <input
          value={trigger.ask ?? ''}
          aria-label={`Trigger ${index + 1} question`}
          placeholder="…and only if: a yes/no question a quick check answers before the run (optional)"
          maxLength={500}
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
 * The options, plus the value the trigger already holds when the vault no
 * longer offers it — a field no record carries now, a value none holds — so
 * the clause reads what the file says instead of a blank, or another choice.
 */
function withHeld(
  options: { value: string; label: string }[],
  held: string | undefined,
): { value: string; label: string }[] {
  if (held === undefined || held === '' || options.some((o) => o.value === held)) return options;
  return [...options, { value: held, label: held }];
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
