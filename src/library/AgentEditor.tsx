import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import type { AgentDraft } from '@/engine/libraryDraft';
import {
  holdsProposalTools,
  matchedToolset,
  proposalConsequence,
  TOOLSETS,
  writesAnything,
} from '@/engine/tools';
import { describeTrigger, type Trigger } from '@/engine/triggers';
import { AgentDossier } from './AgentDossier';
import { slugify } from '@/lib/slug';
import { BodyField, EditorSection, Field, GuardRow, TextField } from './chrome';
import { Picker, type PickerOption } from './Picker';
import { ScheduleField } from './ScheduleField';

/**
 * The agent builder (M18, rebuilt in M18.4).
 *
 * Building an agent used to be writing a markdown file and knowing the
 * frontmatter grammar by heart, which meant the two halves that actually make
 * an agent safe — `scope:` and `when:` — were the two nobody wrote. The first
 * pass gave them a form; this one gives them PICKERS, because a form made of
 * comma-separated text boxes has the same defect the property table had: it
 * asks you to hold the vault's folder list and thirteen tool identifiers in
 * your head, and it fails silently when you get one wrong.
 *
 * Four axes, each answered from something real:
 *
 * - **Scope** — folders that exist in this vault, with the count in each.
 * - **Tools** — the catalog the MCP server actually serves (engine/tools,
 *   parity-tested against mcp.rs).
 * - **Connectors** — the servers `.cerebro/connectors.json` has enabled.
 * - **Triggers** — events, folders and field values from the vault's schema.
 *
 * The boundaries live beside the instructions rather than in a settings page,
 * and that is deliberate: `scope:` is not a preference. It is the answer to
 * "what can this thing damage", it is enforced in Rust before a write reaches
 * disk, and it belongs on the same screen as the prose that decides what the
 * agent will try to do.
 */
export function AgentEditor({
  draft,
  title,
  folders,
  fields,
  valuesFor,
  connectors,
  onChange,
}: {
  draft: AgentDraft;
  title: string;
  /** Real folders in the vault, with how many notes each holds. */
  folders: { path: string; count: number }[];
  /** Property names records actually carry, for a trigger's `field`. */
  fields: string[];
  /** Values seen for one field, for a trigger's `to`. */
  valuesFor: (field: string) => string[];
  /** Connectors this vault has enabled, from .cerebro/connectors.json. */
  connectors: { name: string; transport: string }[];
  onChange: (next: AgentDraft) => void;
}) {
  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const derived = slugify(title);

  const folderOptions: PickerOption[] = folders.map((f) => ({
    value: f.path,
    label: f.path,
    icon: 'folder',
    meta: `${f.count}`,
  }));

  const toolOptions: PickerOption[] = TOOLSETS.flatMap((set_) =>
    set_.tools.map((tool) => ({
      value: tool.name,
      label: tool.name,
      hint: tool.summary,
      group: set_.label,
      icon: tool.writes ? 'pencil' : 'eye',
    })),
  );
  const toolGroupHints = Object.fromEntries(TOOLSETS.map((s) => [s.label, s.hint]));
  const preset = draft.allowedTools === null ? null : matchedToolset(draft.allowedTools);

  const connectorOptions: PickerOption[] = connectors.map((c) => ({
    value: c.name,
    label: c.name,
    hint: c.transport === 'stdio' ? 'Runs a command on this machine' : 'Reaches a server over HTTP',
    icon: 'plug',
  }));

  const setTrigger = (i: number, patch: Partial<Trigger>) =>
    set(
      'triggers',
      draft.triggers.map((t, n) => {
        if (n !== i) return t;
        const next = { ...t, ...patch };
        // An undefined clause is an ABSENT clause, not an empty one: a trigger
        // carrying `field: ''` would never match anything and would look, in
        // the file, exactly like one that was meant to.
        for (const key of Object.keys(next) as (keyof Trigger)[]) {
          if (next[key] === undefined || next[key] === '') delete next[key];
        }
        return next;
      }),
    );

  // The actor this record's runs are booked under — the same string the run's
  // bearer token stamps (`engine/agents.ts:145`), derived here from the same
  // two inputs rather than stored a second time.
  const actor = `process:${draft.slug.trim() === '' ? derived : slugify(draft.slug)}`;

  return (
    <>
      {/* M33.6 — capability-gated, not type-gated: the dossier renders for a
          record that CAN be on duty, which is a question about what it does
          and never about what it is called. A record with no identity to book
          runs under has no history to show, so it gets no strip. */}
      {actor !== 'process:' && (
        <EditorSection title="What it has done">
          <AgentDossier draft={draft} actor={actor} />
        </EditorSection>
      )}

      <EditorSection title="What it is">
        <Field
          label="Description"
          htmlFor="agent-description"
          hint="One line, in the library and in the run log. Say what it watches and what it produces."
        >
          <TextField
            id="agent-description"
            testId="agent-description"
            value={draft.description}
            onChange={(v) => set('description', v)}
            placeholder="Watches open risks for anything that threatens a release"
          />
        </Field>
        <Field
          label="Identity"
          htmlFor="agent-slug"
          hint={
            draft.slug.trim() === ''
              ? `Derived from the title — everything this agent writes is attributed to process:${derived || 'untitled'}, and renaming it splits that history in two. Set one to fix it.`
              : `Fixed. Writes are attributed to process:${slugify(draft.slug)} through any rename.`
          }
        >
          <TextField
            id="agent-slug"
            testId="agent-slug"
            value={draft.slug}
            onChange={(v) => set('slug', v)}
            placeholder={derived}
          />
        </Field>
      </EditorSection>

      <EditorSection
        title="Standing instructions"
        hint="Sent at the start of every run. Numbered steps beat prose, and an explicit “never” is worth three paragraphs of encouragement."
      >
        <BodyField
          testId="agent-instructions"
          ariaLabel="Standing instructions"
          value={draft.instructions}
          onChange={(v) => set('instructions', v)}
          placeholder={
            '# Release scout\n\n1. Read the open risks.\n2. …\n\nNever edit existing records — flag, don’t fix.'
          }
        />
      </EditorSection>

      <EditorSection
        title="When it runs"
        hint="A clock, a change in the vault, or both. An agent with neither is a description — nothing can fire it, and nothing will."
        action={
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            onClick={() => set('triggers', [...draft.triggers, { event: 'changed' }])}
          >
            Add trigger
          </Button>
        }
      >
        <Field label="Schedule">
          <ScheduleField value={draft.schedule} onChange={(v) => set('schedule', v)} />
        </Field>

        {draft.triggers.map((trigger, i) => (
          <TriggerRow
            key={i}
            index={i}
            trigger={trigger}
            folders={folderOptions}
            fields={fields}
            valuesFor={valuesFor}
            onChange={(patch) => setTrigger(i, patch)}
            onRemove={() =>
              set(
                'triggers',
                draft.triggers.filter((_, n) => n !== i),
              )
            }
          />
        ))}
        {draft.triggers.length === 0 && (
          <p className="m-0 text-xs text-n-500">
            No triggers. Add one to have this agent react to the vault changing.
          </p>
        )}
      </EditorSection>

      <EditorSection
        title="What it may touch"
        hint="Enforced before a write reaches disk, whatever the instructions above say. This is the part that lets you leave an agent running unattended."
      >
        <GuardRow
          label="Limit where this agent can write"
          hint="Folders, and only folders — a prefix is what can be refused without knowing the vault's schema. Off means it may write anywhere in the vault."
          tone="warn"
          checked={draft.scope !== null}
          onChange={(on) => set('scope', on ? [] : null)}
        >
          <Picker
            testId="agent-scope"
            ariaLabel="Folders this agent may write in"
            addLabel="Add folder"
            emptyLabel="Nowhere — it can write no file in this vault."
            options={folderOptions}
            selected={draft.scope ?? []}
            onChange={(next) => set('scope', next)}
          />
          <p className="m-0 mt-1.5 text-2xs text-n-500">
            {draft.scope !== null && draft.scope.length === 0
              ? 'It can still record findings through the knowledge bundle, which has its own guard.'
              : `Writes anywhere under ${(draft.scope ?? []).join(' or ')} and nowhere else.`}
          </p>
        </GuardRow>

        {/* M36.3 — the READ axis, its own row (enforced since M34.4; this is
            the editor catching up to the enforcement). Deliberately not
            folded into the write row: the normal agent reads broadly and
            writes narrowly, so one switch for both would make the safest
            write scope also the blindest reader. */}
        <GuardRow
          label="Limit where this agent can read"
          hint="The same folder grammar as writing, on its own axis. Off means it may read the whole vault. Refused in cerebro before a note's body is served — searches say how many hits were withheld rather than pretending they do not exist."
          tone="warn"
          checked={draft.readScope !== null}
          onChange={(on) => set('readScope', on ? [] : null)}
        >
          <Picker
            testId="agent-read-scope"
            ariaLabel="Folders this agent may read from"
            addLabel="Add folder"
            emptyLabel="Nothing — it can read no note in this vault."
            options={folderOptions}
            selected={draft.readScope ?? []}
            onChange={(next) => set('readScope', next)}
          />
          <p className="m-0 mt-1.5 text-2xs text-n-500">
            {draft.readScope !== null && draft.readScope.length === 0
              ? 'It can still be handed material in its task — it just cannot go looking.'
              : `Reads anywhere under ${(draft.readScope ?? []).join(' or ')} and nowhere else.`}
          </p>
        </GuardRow>

        <GuardRow
          label="Restrict this agent to specific tools"
          hint="A narrowing of the policy the run already has. Never a widening."
          tone="warn"
          checked={draft.allowedTools !== null}
          onChange={(on) => set('allowedTools', on ? [] : null)}
        >
          <Picker
            testId="agent-allowed-tools"
            ariaLabel="Tools this agent may use"
            addLabel="Add tools"
            emptyLabel="No tools at all — it can read nothing and write nothing."
            options={toolOptions}
            groupHint={toolGroupHints}
            selected={draft.allowedTools ?? []}
            onChange={(next) => set('allowedTools', next)}
          />
          {draft.allowedTools !== null && draft.allowedTools.length > 0 && (
            <p className="m-0 mt-1.5 text-2xs text-n-500" data-testid="agent-tools-summary">
              {preset !== null ? `${preset.label}. ` : ''}
              {writesAnything(draft.allowedTools)
                ? 'This selection can change files in your vault.'
                : 'Read-only: nothing in this selection changes a file.'}
            </p>
          )}
          {/* M36.5 — consequence, not membership: what this agent's
              proposals DO, with counts derived from the shared policy
              artifact so this sentence and the channel's behavior cannot
              drift. Armed agents only — an unarmed agent gets no table
              about weapons it does not carry. */}
          {holdsProposalTools(draft.allowedTools) &&
            (() => {
              const { applies, queues } = proposalConsequence();
              return (
                <div
                  data-testid="agent-consequence"
                  className="mt-2 flex flex-col gap-0.5 rounded border border-n-200 px-2.5 py-2 text-2xs text-n-600"
                >
                  <span>
                    Applies on its own once committed — {applies} low- and medium-risk operations.
                  </span>
                  <span>Queues for you — {queues} high-risk operations, decided on a card.</span>
                  <span>
                    Locked — people only: no operation can mark a concept verified. Verification is
                    your stamp.
                  </span>
                  <span>
                    Revising a page a person has verified always queues, whatever the operation.
                  </span>
                </div>
              );
            })()}
        </GuardRow>

        <GuardRow
          label="Limit which connectors this agent can reach"
          hint="What it may read from the outside world on your behalf. A tightly scoped agent that can still query every connected system is only half-bounded."
          tone="warn"
          checked={draft.connectors !== null}
          onChange={(on) => set('connectors', on ? [] : null)}
        >
          {connectors.length === 0 ? (
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
              options={connectorOptions}
              selected={draft.connectors ?? []}
              onChange={(next) => set('connectors', next)}
            />
          )}
        </GuardRow>

        <GuardRow
          label="Let this agent run shell commands"
          hint="The host tools, still capped by the ceiling in Settings. Unattended runs with shell access can do anything your account can."
          tone="warn"
          checked={draft.shell}
          onChange={(on) => set('shell', on)}
        />
      </EditorSection>

      <EditorSection
        title="Memory"
        hint="What survives between runs. Two tiers are fields on this record; the third — what the agent inferred — is the knowledge bundle, which already stores inferences with provenance and already requires your stamp to become verified."
      >
        <Field
          label="Your corrections"
          htmlFor="agent-preferences"
          hint="Durable, and higher priority than anything the agent concluded on its own. A run that tries to write this key is refused — an agent that can edit the corrections made to it does not have preferences, it has notes."
        >
          <BodyField
            id="agent-preferences"
            testId="agent-preferences"
            rows={4}
            ariaLabel="Your corrections"
            value={draft.preferences}
            onChange={(v) => set('preferences', v)}
            placeholder="Never file a risk without an owner."
          />
        </Field>
        <Field
          label="The agent's own notes"
          hint="Rewritten at the end of every run, so this is read-only here — a form that saved over it would erase what the last run learned."
        >
          <p
            data-testid="agent-recent"
            className="m-0 whitespace-pre-wrap rounded-md border border-dashed border-n-200 bg-n-25 p-2.5 font-mono text-2xs leading-[17px] text-n-500"
          >
            {draft.recent === '' ? 'Nothing yet — it has not run.' : draft.recent}
          </p>
        </Field>
      </EditorSection>
    </>
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
          className="rounded border-0 bg-transparent p-1 text-n-400 hover:bg-n-50 hover:text-n-700"
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
