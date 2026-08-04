import { isTemplate } from '@/lib/templates';
import { isKnowledgePath } from './okf';
import type { Entry, LibraryTab } from './types';

/**
 * The library (M18): skills, agents and templates are not record types.
 *
 * They were. A Skill was `type: Skill`, which meant it got everything an
 * ordinary record gets — a row in the Types sidebar, a type screen, a place in
 * Lists and views, a detail panel that edits its frontmatter with the vault's
 * generic field editors. That is the wrong shape for all three, for one reason:
 *
 * **They are not things the vault is ABOUT. They are how the vault WORKS.**
 *
 * A Risk and a Decision are subject matter; you file them, group them, chart
 * them, and the app has no opinion about their fields. A Skill's fields are the
 * app's own contract — `allowed-tools:` is a security boundary Rust enforces,
 * `when:` is a trigger grammar, `schedule:` is a clock. Editing those through a
 * generic property table is how you get an agent scoped to a folder that does
 * not exist and a trigger that silently never fires. They need a form that
 * knows what the values mean.
 *
 * ## What does NOT change
 *
 * The file. A skill is still one markdown file with frontmatter and a body,
 * still greppable, still diffable, still editable in any other editor — the
 * files-first contract is untouched. What changed is which SURFACE owns it.
 *
 * ## Why this is not "type special-casing"
 *
 * The convention that bans special-casing is about SUBJECT types: nothing may
 * route on the name "Project" or "Person", because those are the user's
 * vocabulary and they may rename or delete them. These three are the app's own
 * vocabulary, in the same class as `type: Type` — which has been an explicitly
 * named system type since M12 for exactly this reason. The rule is "the app
 * does not know your types", not "the app has no types of its own".
 */

export const SKILL_TYPE = 'Skill';
export const AGENT_TYPE = 'Agent';

/** The same three names the Selection's `tab` carries — one union, so a tab
 * and the kind it lists can never drift apart. */
export type LibraryKind = LibraryTab;

/** Tab order in the library, and the order these are described anywhere. */
export const LIBRARY_KINDS: LibraryKind[] = ['skill', 'agent', 'template'];

/** Where the New button puts each one. An existing file stays where it is. */
export const LIBRARY_FOLDER: Record<LibraryKind, string> = {
  skill: 'records/skills',
  agent: 'records/agents',
  template: 'templates',
};

const LABELS: Record<LibraryKind, { one: string; many: string; icon: string }> = {
  skill: { one: 'Skill', many: 'Skills', icon: 'zap' },
  agent: { one: 'Agent', many: 'Agents', icon: 'bot' },
  template: { one: 'Template', many: 'Templates', icon: 'layout-template' },
};

export function libraryLabel(kind: LibraryKind): string {
  return LABELS[kind].one;
}

export function libraryLabelPlural(kind: LibraryKind): string {
  return LABELS[kind].many;
}

export function libraryIcon(kind: LibraryKind): string {
  return LABELS[kind].icon;
}

/**
 * True when a `type:` name belongs to the library rather than to the vault's
 * schema. Checked by NAME as well as by entry, because a vault upgraded from
 * an older build may still carry a `types/skill.md` Type doc — the doc should
 * stop surfacing a Types row without anyone having to delete a file first.
 */
export function isLibraryType(name: string | null | undefined): boolean {
  return name === SKILL_TYPE || name === AGENT_TYPE;
}

/**
 * Which library surface owns this entry, or null when the library does not.
 *
 * Templates are decided by FOLDER (`isTemplate`) and the other two by `type:`,
 * which is not an inconsistency — it is what each one already was. A template
 * has always been "a file in templates/" and carries the type it will confer
 * on the page made from it, so keying it on `type:` would file it under
 * whatever it stamps.
 */
export function libraryKind(entry: Entry): LibraryKind | null {
  // Never inside the knowledge bundle, and this is a SECURITY rule rather than
  // a tidiness one: `knowledge/` is the corpus the agent writes, so a file it
  // authors there that counted as a Skill would be the agent granting itself a
  // new capability — and one the `/` menu would then offer to the user under a
  // name of the agent's choosing.
  if (isKnowledgePath(entry.path)) return null;
  if (isTemplate(entry)) return 'template';
  if (entry.type === SKILL_TYPE) return 'skill';
  if (entry.type === AGENT_TYPE) return 'agent';
  return null;
}

export function isLibraryEntry(entry: Entry): boolean {
  return libraryKind(entry) !== null;
}
