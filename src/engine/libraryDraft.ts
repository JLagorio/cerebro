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
 * form owns, so anything else in the file survives untouched. The agent page
 * narrows that to one row: each Done writes only that row's keys (M55.12).
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
  /** `disallowed-tools:` (M54.9): connector tools it may never call. Read
   * from the file and shown, never written — no AgentKey names it, so
   * `agentPatch` leaves the key to whoever wrote it. */
  disallowedTools: string[] | null;
  /** Connectors it may reach. Null = none when it runs on its own, every
   * enabled and approved one in a turn you address it in (M54.9); [] =
   * none. */
  connectors: string[] | null;
  /** `tools: shell` — the host tools, still capped by the Settings ceiling
   * and withdrawn in Rust by a read limit (M53.5). */
  shell: boolean;
  /** `model:` and `effort:` (M56.5), trimmed; '' is unset, Claude Code's
   * default, and writes no key. */
  model: string;
  effort: string;
  schedule: string;
  triggers: Trigger[];
  /** What the human corrected. The agent may read it and never write it. */
  preferences: string;
  /** The agent's own notes. Shown, never written — no AgentKey names it. */
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
    disallowedTools: parseAllowedTools(entry.properties['disallowed-tools']),
    connectors: parseAllowedTools(entry.properties.connectors),
    shell: entry.properties.tools === 'shell',
    model: text(entry.properties.model),
    effort: text(entry.properties.effort),
    schedule: text(entry.properties.schedule),
    triggers: parseTriggers(entry.properties.when),
    preferences: memory.preferences,
    recent: memory.recent,
    instructions: body,
  };
}

/**
 * A frontmatter axis the agent page writes (M55.12). One row of the page owns
 * one or two of these and writes only those on Done: a grant written whole is
 * a grant some other row's half-built draft could overwrite.
 *
 * Never keys: `recent` (the agent's own notes), `disallowedTools` (shown,
 * edited in the file — M54.9) and the body, which the page editor saves.
 */
export type AgentKey =
  | 'slug'
  | 'description'
  | 'scope'
  | 'readScope'
  | 'allowedTools'
  | 'connectors'
  | 'shell'
  | 'model'
  | 'effort'
  | 'schedule'
  | 'triggers'
  | 'preferences';

export const AGENT_KEYS: readonly AgentKey[] = [
  'slug',
  'description',
  'scope',
  'readScope',
  'allowedTools',
  'connectors',
  'shell',
  'model',
  'effort',
  'schedule',
  'triggers',
  'preferences',
];

/**
 * The patch for the asked keys, and nothing else. The agent page writes one
 * property per Done through this builder, so a row never carries another
 * row's value along with its own.
 */
export function agentPatch(draft: AgentDraft, keys: readonly AgentKey[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    switch (key) {
      case 'slug':
        out.slug = draft.slug.trim() === '' ? null : slugify(draft.slug);
        break;
      case 'description':
        out.description = blank(draft.description);
        break;
      case 'scope':
        out.scope = draft.scope;
        break;
      case 'readScope':
        out['read-scope'] = draft.readScope;
        break;
      case 'allowedTools':
        out['allowed-tools'] = draft.allowedTools;
        break;
      case 'connectors':
        out.connectors = draft.connectors;
        break;
      case 'shell':
        // `tools: safe` is written rather than removed: the default is safe
        // either way, but a record that says so out loud is one you can read
        // the policy off without knowing what the default is.
        out.tools = draft.shell ? 'shell' : 'safe';
        break;
      case 'model':
        out.model = blank(draft.model);
        break;
      case 'effort':
        out.effort = blank(draft.effort);
        break;
      case 'schedule':
        out.schedule = blank(draft.schedule);
        break;
      case 'triggers':
        out.when = draft.triggers.length === 0 ? null : draft.triggers.map(triggerToYaml);
        break;
      case 'preferences':
        out.preferences = blank(draft.preferences);
        break;
    }
  }
  return out;
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
 * somebody deleted — and the agent page turns activation on by writing a
 * real schedule or trigger rather than by flipping a bit that means nothing.
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
