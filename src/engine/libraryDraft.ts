import { slugify } from '@/lib/slug';
import { parseMemory, parseReadScope, parseScope, type AgentMemory } from './agents';
import { parseAllowedTools, parseArguments, type SkillArgument } from './skills';
import { parseTriggers, type Trigger } from './triggers';
import type { Entry } from './types';

/**
 * The library's form model (M18): one place where a draft becomes a file.
 *
 * The editors are forms over frontmatter, and the temptation is to have each
 * input write its own key on change. That is how the old surface worked — a
 * generic property table — and it is exactly what made these records dangerous
 * to edit: `schedule: ""` is not the same as no `schedule:`, `scope: []` is the
 * opposite of no `scope:`, and an `allowed-tools:` that round-trips through a
 * text box as `""` narrows a run to nothing instead of leaving it alone.
 *
 * So the rule here: **absent and empty are different values, and the draft
 * knows which one it holds.** A patch emits `null` for a key that should be
 * REMOVED — both backends delete on null — and only ever writes the keys the
 * form owns, so anything else in the file survives untouched.
 *
 * Every field below maps to behaviour that already exists. There is no
 * `visibility:` and no "agent only / slash only" toggle, however well they
 * would photograph: a control that writes a key nothing reads is a lie the
 * form tells about what the app does.
 */

// --- Skills -----------------------------------------------------------------

export interface SkillDraft {
  /** The `/handle`. Empty means "derive it from the title", which is what a
   * skill with no `slug:` has always done — and is the state that silently
   * changes the handle when the title is edited. */
  slug: string;
  description: string;
  arguments: SkillArgument[];
  /** Null when the skill does not narrow the turn; [] narrows it to nothing. */
  allowedTools: string[] | null;
  /** `schedule:` verbatim, '' for none. Validated by parseSchedule on save. */
  schedule: string;
  /** The body — the actual instructions. */
  instructions: string;
}

export function skillDraft(entry: Entry, body: string): SkillDraft {
  return {
    slug: text(entry.properties.slug),
    description: text(entry.properties.description),
    arguments: parseArguments(entry.properties.arguments),
    allowedTools: parseAllowedTools(entry.properties['allowed-tools']),
    schedule: text(entry.properties.schedule),
    instructions: body,
  };
}

export function skillPatch(draft: SkillDraft): Record<string, unknown> {
  return {
    slug: draft.slug.trim() === '' ? null : slugify(draft.slug),
    description: blank(draft.description),
    // Serialized back to the object form even when it was written as a bare
    // string list, because a description typed into the form has to land
    // somewhere — and the two shapes parse identically on the way in.
    arguments:
      draft.arguments.length === 0
        ? null
        : draft.arguments.map((a) => ({
            name: a.name,
            ...(a.description === '' ? {} : { description: a.description }),
            ...(a.required ? { required: true } : {}),
          })),
    'allowed-tools': draft.allowedTools,
    schedule: blank(draft.schedule),
  };
}

// --- Agents -----------------------------------------------------------------

export interface AgentDraft {
  slug: string;
  description: string;
  /** Folders it may write inside. Null = anywhere; [] = nowhere. */
  scope: string[] | null;
  /** Folders it may READ inside (M34.4 `read-scope:`, editable M36.3).
   * Null = reads everything; [] = reads nothing. Its own axis: the normal
   * agent reads broadly and writes narrowly, so folding read into write
   * would make the safest write scope also the blindest reader. */
  readScope: string[] | null;
  allowedTools: string[] | null;
  /** Connectors it may reach. Null = whatever the vault enabled; [] = none. */
  connectors: string[] | null;
  /** `tools: shell` — the host tools, still capped by the Settings ceiling. */
  shell: boolean;
  schedule: string;
  triggers: Trigger[];
  /** What the human corrected. The agent may read it and never write it. */
  preferences: string;
  /** The agent's own notes. Shown, never edited here — see the editor. */
  recent: string;
  instructions: string;
}

export function agentDraft(entry: Entry, body: string): AgentDraft {
  const memory: AgentMemory = parseMemory(entry);
  return {
    slug: text(entry.properties.slug),
    description: text(entry.properties.description),
    scope: parseScope(entry),
    readScope: parseReadScope(entry),
    allowedTools: parseAllowedTools(entry.properties['allowed-tools']),
    connectors: parseAllowedTools(entry.properties.connectors),
    shell: entry.properties.tools === 'shell',
    schedule: text(entry.properties.schedule),
    triggers: parseTriggers(entry.properties.when),
    preferences: memory.preferences,
    recent: memory.recent,
    instructions: body,
  };
}

export function agentPatch(draft: AgentDraft): Record<string, unknown> {
  return {
    slug: draft.slug.trim() === '' ? null : slugify(draft.slug),
    description: blank(draft.description),
    scope: draft.scope,
    'read-scope': draft.readScope,
    'allowed-tools': draft.allowedTools,
    connectors: draft.connectors,
    // `tools: safe` is written rather than removed: the default is safe either
    // way, but a record that says so out loud is one you can read the policy
    // off without knowing what the default is.
    tools: draft.shell ? 'shell' : 'safe',
    schedule: blank(draft.schedule),
    when: draft.triggers.length === 0 ? null : draft.triggers.map(triggerToYaml),
    preferences: blank(draft.preferences),
  };
}

function triggerToYaml(trigger: Trigger): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (trigger.event !== undefined) out.event = trigger.event;
  if (trigger.field !== undefined) out.field = trigger.field;
  if (trigger.to !== undefined) out.to = trigger.to;
  if (trigger.in !== undefined) out.in = trigger.in;
  if (trigger.ask !== undefined) out.ask = trigger.ask;
  if (trigger.do !== undefined) out.do = trigger.do;
  return out;
}

/**
 * Is this agent on duty?
 *
 * DERIVED, never stored. An agent is active exactly when something can fire
 * it, so there is no `enabled:` flag to fall out of step with a `schedule:`
 * somebody deleted — and the switch in the editor turns activation on by
 * writing a real trigger rather than by flipping a bit that means nothing.
 */
export function agentActive(draft: Pick<AgentDraft, 'schedule' | 'triggers'>): boolean {
  return draft.schedule.trim() !== '' || draft.triggers.length > 0;
}

// --- Templates --------------------------------------------------------------

export interface TemplateDraft {
  /** The `type:` this template stamps on pages made from it; '' for a doc. */
  type: string;
  /** The `fill:` prompt (M17.10), '' when the template does not fill itself. */
  fill: string;
  body: string;
}

export function templateDraft(entry: Entry, body: string): TemplateDraft {
  return {
    type: entry.type ?? '',
    fill: text(entry.properties.fill),
    body,
  };
}

export function templatePatch(draft: TemplateDraft): Record<string, unknown> {
  return {
    type: blank(draft.type),
    fill: blank(draft.fill),
  };
}

// --- Shared helpers ---------------------------------------------------------

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** '' → null, so an emptied field REMOVES its key instead of writing a blank
 * one. A `description: ''` sitting in frontmatter reads as a declared empty
 * description and would ride into every system prompt as a dangling dash. */
function blank(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A comma-or-newline separated list from a text box.
 *
 * Text only — it never decides between `[]` and null. That distinction is real
 * for `allowed-tools:` and `scope:` (an empty declared list means "nothing",
 * which is the opposite of undeclared), and an empty text box cannot express
 * it, so the editors carry a separate switch for it and call this for the
 * contents alone.
 */
export function parseList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function formatList(items: string[]): string {
  return items.join(', ');
}
