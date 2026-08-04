import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import { formatList, parseList, type AgentDraft } from '@/engine/libraryDraft';
import { parseSchedule } from '@/engine/skills';
import { describeTrigger, type Trigger } from '@/engine/triggers';
import { slugify } from '@/lib/slug';
import { BodyField, EditorSection, Field, GuardRow, TextField } from './chrome';

/**
 * The agent builder (M18).
 *
 * Building an agent used to be writing a markdown file and knowing the
 * frontmatter grammar by heart — which meant the two halves that actually make
 * an agent safe, `scope:` and `when:`, were the two nobody wrote. This is the
 * five-axis model the category converged on (instructions, triggers, tools,
 * knowledge, memory), with one deliberate difference:
 *
 * **The boundaries are edited beside the instructions, not in a settings page.**
 * `scope:` is not a preference. It is the answer to "what can this thing damage",
 * it is enforced in Rust before a write reaches disk, and it belongs on the same
 * screen as the prose that decides what the agent will try to do.
 *
 * ## The trigger builder
 *
 * Structured rows rather than a text box, because layer one of a trigger is
 * deliberately a small deterministic grammar — event, folder, field, value —
 * and a person should be able to read what will fire it without running it. The
 * one free-text field is `ask:`, which is layer two and is prose on purpose.
 */
export function AgentEditor({
  draft,
  title,
  folders,
  onChange,
}: {
  draft: AgentDraft;
  title: string;
  /** Real folders in the vault, so scope is picked rather than typed. */
  folders: string[];
  onChange: (next: AgentDraft) => void;
}) {
  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const derived = slugify(title);
  const scheduleValid = draft.schedule.trim() === '' || parseSchedule(draft.schedule) !== null;

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

  return (
    <>
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
        <Field
          label="Schedule"
          htmlFor="agent-schedule"
          hint="hourly · daily 09:00 · weekdays 08:30 · weekly fri 17:00."
        >
          <TextField
            id="agent-schedule"
            testId="agent-schedule"
            value={draft.schedule}
            onChange={(v) => set('schedule', v)}
            placeholder="weekdays 08:30"
          />
        </Field>
        {!scheduleValid && (
          <p className="m-0 flex items-center gap-1.5 text-2xs text-danger-600" role="alert">
            <Icon name="triangle-alert" size={12} color="var(--danger-600)" />
            Not a schedule this app can read — it will not run on a clock.
          </p>
        )}

        {draft.triggers.map((trigger, i) => (
          <div
            key={i}
            data-testid="agent-trigger"
            className="rounded-lg border border-n-200 bg-n-25 p-2.5"
          >
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-n-600">
              <span>When a record is</span>
              <Select
                size="sm"
                width={120}
                value={trigger.event ?? 'any'}
                aria-label={`Trigger ${i + 1} event`}
                onChange={(e) =>
                  setTrigger(i, {
                    event:
                      e.target.value === 'any' ? undefined : (e.target.value as Trigger['event']),
                  })
                }
                options={[
                  { value: 'any', label: 'touched' },
                  { value: 'created', label: 'created' },
                  { value: 'changed', label: 'changed' },
                  { value: 'moved', label: 'moved' },
                ]}
              />
              <span>in</span>
              <input
                value={trigger.in ?? ''}
                aria-label={`Trigger ${i + 1} folder`}
                placeholder="anywhere"
                list="library-folders"
                onChange={(e) => setTrigger(i, { in: e.target.value })}
                className="w-[150px] rounded-md border border-n-200 bg-n-0 px-2 py-1 font-mono text-2xs text-n-800 outline-none focus-visible:border-cortex-400"
              />
              <span className="flex-1" />
              <button
                type="button"
                aria-label={`Remove trigger ${i + 1}`}
                onClick={() =>
                  set(
                    'triggers',
                    draft.triggers.filter((_, n) => n !== i),
                  )
                }
                className="rounded border-0 bg-transparent p-1 text-n-400 hover:bg-n-50 hover:text-n-700"
              >
                <Icon name="x" size={13} />
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-n-600">
              <span>and its</span>
              <input
                value={trigger.field ?? ''}
                aria-label={`Trigger ${i + 1} field`}
                placeholder="any field"
                onChange={(e) => setTrigger(i, { field: e.target.value })}
                className="w-[110px] rounded-md border border-n-200 bg-n-0 px-2 py-1 font-mono text-2xs text-n-800 outline-none focus-visible:border-cortex-400"
              />
              <span>became</span>
              <input
                value={trigger.to ?? ''}
                aria-label={`Trigger ${i + 1} value`}
                placeholder="any value"
                onChange={(e) => setTrigger(i, { to: e.target.value })}
                className="w-[110px] rounded-md border border-n-200 bg-n-0 px-2 py-1 font-mono text-2xs text-n-800 outline-none focus-visible:border-cortex-400"
              />
            </div>
            <div className="mt-1.5">
              <input
                value={trigger.ask ?? ''}
                aria-label={`Trigger ${i + 1} question`}
                placeholder="…and only if: a yes/no question the agent answers first (optional)"
                onChange={(e) => setTrigger(i, { ask: e.target.value })}
                className="w-full rounded-md border border-n-200 bg-n-0 px-2 py-1 text-2xs text-n-800 outline-none placeholder:text-n-400 focus-visible:border-cortex-400"
              />
            </div>
            {/* The same sentence the library and the run log print. If the
                summary does not match what you meant, the trigger does not
                either — which is the entire value of a deterministic layer. */}
            <p className="m-0 mt-2 text-2xs leading-[15px] text-n-500">
              {describeTrigger(trigger)}
            </p>
          </div>
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
          <TextField
            testId="agent-scope"
            ariaLabel="Scope"
            value={formatList(draft.scope ?? [])}
            onChange={(v) => set('scope', parseList(v))}
            placeholder="records/risks, records/decisions"
          />
          <p className="m-0 mt-1 text-2xs text-n-500">
            {draft.scope !== null && draft.scope.length === 0
              ? 'Empty: this agent can write nowhere in the vault. It can still record findings through the knowledge bundle, which has its own guard.'
              : `Writes anywhere under ${draft.scope?.join(' or ') ?? ''} and nowhere else.`}
          </p>
        </GuardRow>
        <GuardRow
          label="Restrict this agent to specific tools"
          hint="A narrowing of the policy the run already has. Never a widening."
          tone="warn"
          checked={draft.allowedTools !== null}
          onChange={(on) => set('allowedTools', on ? [] : null)}
        >
          <TextField
            testId="agent-allowed-tools"
            ariaLabel="Allowed tools"
            value={formatList(draft.allowedTools ?? [])}
            onChange={(v) => set('allowedTools', parseList(v))}
            placeholder="search_notes, get_note, write_concept"
          />
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

      <datalist id="library-folders">
        {folders.map((folder) => (
          <option key={folder} value={folder} />
        ))}
      </datalist>
    </>
  );
}
