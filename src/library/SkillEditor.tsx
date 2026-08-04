import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { formatList, parseList, type SkillDraft } from '@/engine/libraryDraft';
import { parseSchedule } from '@/engine/skills';
import { slugify } from '@/lib/slug';
import { BodyField, EditorSection, Field, GuardRow, TextField } from './chrome';

/**
 * The skill editor (M18).
 *
 * A skill has five things worth deciding, and every one of them was previously
 * a row in a generic property table where the label was the key name and there
 * was nowhere to say what it did. Two of them are load-bearing in ways nobody
 * could guess from `allowed-tools: []`:
 *
 * - the HANDLE is what you type after the slash, and leaving it blank means it
 *   is derived from the title — so renaming the skill silently renames the
 *   command, and every note that mentions `/weekly-review` goes stale;
 * - `allowed-tools:` is a NARROWING enforced in Rust. Absent means "whatever
 *   the turn already had"; an empty list means "nothing at all". Those are
 *   opposite instructions that a text box renders identically.
 */
export function SkillEditor({
  draft,
  title,
  onChange,
}: {
  draft: SkillDraft;
  /** The record's title, for the derived-handle preview. */
  title: string;
  onChange: (next: SkillDraft) => void;
}) {
  const set = <K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const derived = slugify(title);
  const scheduleValid = draft.schedule.trim() === '' || parseSchedule(draft.schedule) !== null;

  return (
    <>
      <EditorSection title="What it is">
        <Field
          label="Description"
          htmlFor="skill-description"
          hint="One line. This is the only thing the assistant sees until the skill is invoked — it is what decides whether the agent reaches for it unprompted."
        >
          <TextField
            id="skill-description"
            testId="skill-description"
            value={draft.description}
            onChange={(v) => set('description', v)}
            placeholder="Sweep open work for risks nobody has written down"
          />
        </Field>
        <Field
          label="Command"
          htmlFor="skill-slug"
          hint={
            draft.slug.trim() === ''
              ? `Derived from the title — this skill answers to /${derived || 'untitled'} and will answer to something else if you rename it. Set one to fix it.`
              : 'Fixed. The skill keeps this command through any rename, and its run history stays attached to it.'
          }
        >
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-sm text-n-400">/</span>
            <TextField
              id="skill-slug"
              testId="skill-slug"
              value={draft.slug}
              onChange={(v) => set('slug', v)}
              placeholder={derived}
            />
          </div>
        </Field>
      </EditorSection>

      <EditorSection
        title="Instructions"
        hint="The body of the file, sent verbatim when the skill runs. Write it as instructions to a capable colleague — numbered steps, and what NOT to do."
      >
        <BodyField
          testId="skill-instructions"
          ariaLabel="Instructions"
          value={draft.instructions}
          onChange={(v) => set('instructions', v)}
          placeholder={'# Weekly review\n\n1. Read everything that changed since Monday.\n2. …'}
        />
      </EditorSection>

      <EditorSection
        title="Inputs"
        hint="Declared inputs are named in the prompt and hinted in the / completion. A skill with a required input that gets none is told to ask rather than to guess."
        action={
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            onClick={() =>
              set('arguments', [...draft.arguments, { name: '', description: '', required: false }])
            }
          >
            Add input
          </Button>
        }
      >
        {draft.arguments.length === 0 ? (
          <p className="m-0 text-xs text-n-500">
            No declared inputs — the whole message is the input.
          </p>
        ) : (
          draft.arguments.map((arg, i) => (
            <div key={i} className="flex items-center gap-2" data-testid="skill-argument">
              <input
                value={arg.name}
                aria-label={`Input ${i + 1} name`}
                placeholder="scope"
                onChange={(e) =>
                  set(
                    'arguments',
                    draft.arguments.map((a, n) => (n === i ? { ...a, name: e.target.value } : a)),
                  )
                }
                className="w-[130px] flex-none rounded-md border border-n-200 px-2 py-1.5 font-mono text-xs text-n-800 outline-none focus-visible:border-cortex-400"
              />
              <input
                value={arg.description}
                aria-label={`Input ${i + 1} description`}
                placeholder="A project or list to sweep"
                onChange={(e) =>
                  set(
                    'arguments',
                    draft.arguments.map((a, n) =>
                      n === i ? { ...a, description: e.target.value } : a,
                    ),
                  )
                }
                className="min-w-0 flex-1 rounded-md border border-n-200 px-2 py-1.5 text-xs text-n-800 outline-none focus-visible:border-cortex-400"
              />
              <label className="flex flex-none items-center gap-1.5 text-2xs text-n-600">
                <input
                  type="checkbox"
                  checked={arg.required}
                  aria-label={`Input ${i + 1} required`}
                  onChange={(e) =>
                    set(
                      'arguments',
                      draft.arguments.map((a, n) =>
                        n === i ? { ...a, required: e.target.checked } : a,
                      ),
                    )
                  }
                  className="h-3.5 w-3.5 accent-[var(--cortex-500)]"
                />
                Required
              </label>
              <button
                type="button"
                aria-label={`Remove input ${i + 1}`}
                onClick={() =>
                  set(
                    'arguments',
                    draft.arguments.filter((_, n) => n !== i),
                  )
                }
                className="flex-none rounded border-0 bg-transparent p-1 text-n-400 hover:bg-n-50 hover:text-n-700"
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          ))
        )}
      </EditorSection>

      <EditorSection
        title="What it may do"
        hint="A narrowing only. The run already has a policy from Settings and from whatever started it; this can subtract from that and never add to it, and the subtraction happens in Rust rather than being asked for in a prompt."
      >
        <GuardRow
          label="Restrict this skill to specific tools"
          hint="Off means the skill uses whatever the turn already had. On with an empty list means no tools at all — a pure text transformation."
          tone="warn"
          checked={draft.allowedTools !== null}
          onChange={(on) => set('allowedTools', on ? [] : null)}
        >
          <TextField
            testId="skill-allowed-tools"
            ariaLabel="Allowed tools"
            value={formatList(draft.allowedTools ?? [])}
            onChange={(v) => set('allowedTools', parseList(v))}
            placeholder="search_notes, get_note"
          />
          <p className="m-0 mt-1 text-2xs text-n-500">
            {draft.allowedTools !== null && draft.allowedTools.length === 0
              ? 'Empty: this skill runs with no tools at all.'
              : `Only these ${draft.allowedTools?.length ?? 0} will be available.`}
          </p>
        </GuardRow>
      </EditorSection>

      <EditorSection
        title="On a schedule"
        hint="A skill with a schedule runs unattended, like an agent. An app that was closed all week owes one catch-up run, not seven."
      >
        <Field
          label="Schedule"
          htmlFor="skill-schedule"
          hint="hourly · daily 09:00 · weekdays 08:30 · weekly fri 17:00. Leave blank to run only when invoked."
        >
          <TextField
            id="skill-schedule"
            testId="skill-schedule"
            value={draft.schedule}
            onChange={(v) => set('schedule', v)}
            placeholder="weekly fri 17:00"
          />
        </Field>
        {!scheduleValid && (
          // Said at the point of entry, because a schedule nobody can parse is
          // silently not a schedule — the skill simply never runs, and there is
          // nowhere else the app would ever mention it.
          <p className="m-0 flex items-center gap-1.5 text-2xs text-danger-600" role="alert">
            <Icon name="triangle-alert" size={12} color="var(--danger-600)" />
            Not a schedule this app can read — it will not run. Try “weekly fri 17:00”.
          </p>
        )}
      </EditorSection>
    </>
  );
}
