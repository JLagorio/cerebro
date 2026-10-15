import { askFirstOf as readAskFirst, TOOL_APPROVAL } from '@/lib/policy/toolApproval';
import { slugify } from '@/lib/slug';
import { declaredSlug, recordIdentity } from './identity';
import { AGENT_TYPE, libraryKind } from './library';
import { storedChoice } from './runOptions';
import { parseAllowedTools } from './skills';
import type { Entry } from './types';

/**
 * Agents (M13.4): an agent is a record.
 *
 * A record of `type: Agent` whose body is its standing instructions. It runs
 * unattended on its `schedule:`, its writes are attributed to
 * `process:<slug>` — the actor slot the OKF schema has reserved since M8 —
 * and its working notes between runs are the `recent:` frontmatter property
 * (M17.14; `memory:` before it), which a run that holds update_frontmatter is
 * asked to rewrite at the end of each run (M54.7) and may: `recent` alone, on
 * its own record, size-capped (D7, mcp.rs, M56.10). Memory in frontmatter
 * rather than a hidden state file on purpose: it renders as an ordinary
 * property on the record, so what the agent carries forward is always one
 * click from the person it works for.
 *
 * Activation is a human act: an Agent record without a `schedule:` is a
 * description, not a daemon.
 */

// Moved to engine/library with M18; re-exported so imports keep working.
export { AGENT_TYPE };

export interface AgentRef {
  /** `process:<slug>` — how this agent's writes are attributed. */
  actor: string;
  /**
   * The name it answers to when it is addressed — `@handle` in a chat turn
   * (M33b.6).
   *
   * The SAME string `actor` is built from, so an agent is addressed by exactly
   * the identity its writes are stamped with. A second naming rule for
   * addressing would be a twin inventory of the one thing that must not have
   * two answers: who this is.
   */
  handle: string;
  /** Ledger key, stable across renames when the record declares a `slug:`
   * (M17.8). The same identity skills use. */
  id: string;
  title: string;
  path: string;
  description: string;
  /** The record's `tools:` — 'shell' widens the run to the host tools,
   * still capped by the Settings ceiling, unless the record also declares a
   * `read-scope:`, which withdraws it in Rust (M53.5). Anything else reads as
   * safe. */
  shell: boolean;
  /**
   * Vault-relative folders this agent may WRITE inside (M17.13).
   *
   * Null when the record declares no `scope:` — unrestricted, which is what
   * every agent was before this. An EMPTY list is not the same thing: a record
   * that declares `scope:` and lists nothing has scoped itself to nothing, and
   * reading that as "everywhere" would make the safest-looking declaration the
   * most dangerous one.
   *
   * Folders, and only folders, because a folder prefix is what Rust can refuse
   * without knowing the vault's schema. "Only records of type Risk" would have
   * to be re-derived per write and would break the moment a type is renamed —
   * and the honest version of it is a sentence in a prompt, which is the thing
   * this replaces.
   */
  scope: string[] | null;
  /**
   * Folders this agent may READ (M34.4) — `read-scope:`. Null when the
   * record declares none: unrestricted, which is what every agent was. Its
   * own axis because the normal agent reads broadly and writes narrowly;
   * folding read into write would make the safest write scope also the
   * blindest reader. Same null-vs-empty reading as `scope`, enforced on the
   * same bearer token in Rust.
   */
  readScope: string[] | null;
  /** Tools this agent may use, intersected with the granted policy (M17.8).
   * An `mcp__<connector>` or `mcp__<connector>__<tool>` entry narrows that
   * connector's grant the same way (M54.9). */
  allowedTools: string[] | null;
  /**
   * Connector tools this agent may never call (M54.9) — `disallowed-tools:`.
   *
   * Only entries that name one of the run's connectors count: the whole
   * server (`mcp__gmail`), which then never loads, or one tool
   * (`mcp__gmail__trash_thread`), which the run's `--disallowedTools` denies
   * — and a deny binds even where the person's own Claude Code allow rules
   * would widen the run. In a vault with no connector list, an entry that
   * names any connector keeps the run off the person's global MCP config,
   * which no deny could bind. Null and [] both deny nothing; it can only
   * subtract.
   */
  disallowedTools: string[] | null;
  /**
   * Named system-prompt fragments this agent opts into (M34.1.3).
   * Deliberately the smallest possible mechanism: a capability selects TEXT,
   * never a code path — routing behavior on it would be the type
   * special-casing AGENTS.md forbids. Empty when undeclared: no agent is the
   * knowledge agent by default.
   */
  capabilities: string[];
  /**
   * Connectors this agent may reach (M18.4).
   *
   * Null when the record names none: its unattended runs then reach no
   * connector at all, and a turn you address it in reaches every enabled
   * connector approved on this machine (M54.9). An empty list is the
   * opposite of reaching everything: named, and named nothing. A named
   * connector the vault cannot give a run is dropped, never conjured, and
   * the run's prompt names it with why (M54.11).
   *
   * Worth having as its own axis rather than folding into `scope:`, because
   * they bound different things. `scope:` says what the agent may CHANGE in
   * your vault; this says which outside systems it may act in on your behalf
   * — a connector's tools can read, and can change things there too — and a
   * tightly scoped agent that can still reach every connected system is only
   * half-bounded.
   */
  connectors: string[] | null;
  /**
   * The model its runs ask Claude Code for (M56.5) — `model:`, trimmed. Null
   * when blank, absent or not a string: Claude Code's default. Whether the
   * value is one Claude Code takes is the agent page's warning and Rust's
   * refusal, never this parser's.
   */
  model: string | null;
  /** The effort its runs ask for (M56.5) — `effort:`, read like `model`. */
  effort: string | null;
  /**
   * Does it ask before every page write (M57.4) — `ask-first:`? Its
   * confirmable writes (the tool manifest's note writers) wait for the
   * person's Allow in an attended turn, and are refused in a run nobody
   * watches. Read by the tool-approval table's `ask_first` cases: anything
   * but `true` or `false` reads on, so an odd value fails closed. Rust
   * reads the record again before a run's bearer is minted, so this can
   * only tighten what the run gets.
   */
  askFirst: boolean;
  /** The warning an odd `ask-first:` value earns on the agent page, or null
   * when the value is `true`, `false` or absent. */
  askFirstWarning: string | null;
  /**
   * What this agent carries between runs (M17.14).
   *
   * ClickUp's three tiers, and only two of them are fields — which is the
   * finding rather than a shortcut:
   *
   * - **Recent** is `recent:` (or the pre-M17 `memory:`): the agent's own
   *   working notes, which the agent's own runs may rewrite: `recent` alone,
   *   at most 30 lines and 4096 bytes, held so in mcp.rs (D7, M56.10).
   *   Volatile by design.
   * - **Preferences** is `preferences:`: what the HUMAN corrected. Durable,
   *   higher priority than anything the agent concluded itself, and an agent
   *   run is refused if it tries to write the key (mcp.rs) — an agent that can
   *   edit the corrections made to it does not have preferences, it has notes.
   * - **Intelligence** — what the agent inferred — is not a field at all. It is
   *   the knowledge bundle, which already stores inferences with provenance,
   *   already requires a human stamp to become verified, and since M17.20
   *   already reaches the turn. A third frontmatter blob would be a second,
   *   worse copy of a thing this app spent M8 building properly.
   */
  memory: AgentMemory;
}

export interface AgentMemory {
  /** The agent's own working notes, which its own runs may rewrite (`recent`
   * alone and size-capped, mcp.rs, M56.10). */
  recent: string;
  /** What the human told it. The agent may read this and never write it. */
  preferences: string;
}

/** The tier names, for the builder and for the prompt. */
export const MEMORY_TIERS = ['recent', 'preferences'] as const;

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * One memory tier's text, wherever the scan filed it (M56.13).
 *
 * A hand-written `[[link]]` in `preferences:` or `recent:` turns the field
 * into a relation: it arrives bracket-stripped in `entry.relationships`, not
 * `properties` (CV-09), and read from properties alone the tier was empty, so
 * a correction that named a note silently stopped reaching every prompt and
 * the Memory tab. The scan keeps a relation's targets and nothing around
 * them, so the tier reads back as its links, `[[target]]` one per line in
 * the order written: less than the file says, never nothing.
 *
 * A read, and only that. Written back, this text would replace the prose
 * still on disk with the links alone, so `linkedTiers` names the tiers that
 * arrived this way and the Memory tab (`AgentMemoryTab.tsx`) will not save
 * over one: its corrections box goes read-only for a linked `preferences`.
 * Agent runs cannot cause the case: mcp.rs refuses a `[[link]]` in the
 * `recent` a run writes (M56.10).
 */
function tierOf(entry: Entry, key: string): string {
  const text = textOf(entry.properties[key]);
  if (text !== '') return text;
  return linksOf(entry, key)
    .map((target) => `[[${target}]]`)
    .join('\n');
}

function linksOf(entry: Entry, key: string): string[] {
  return (entry.relationships[key] ?? [])
    .map((target) => target.trim())
    .filter((target) => target !== '');
}

/** Whether a tier's value is a relation's links, not its text (M56.13). */
function linked(entry: Entry, key: string): boolean {
  return textOf(entry.properties[key]) === '' && linksOf(entry, key).length > 0;
}

/**
 * Which memory tiers `parseMemory` rebuilt from a relation (M56.13): the
 * record's value holds `[[links]]`, the scan kept only the links, and saving
 * the rebuilt text would erase every word around them on disk. The Memory
 * tab reads this and never writes a linked tier.
 */
export function linkedTiers(entry: Entry): Record<(typeof MEMORY_TIERS)[number], boolean> {
  return {
    recent: tierOf(entry, 'recent') !== '' ? linked(entry, 'recent') : linked(entry, 'memory'),
    preferences: linked(entry, 'preferences'),
  };
}

/** The agent's memory tiers (M17.14) — the one reader prompts and the agent
 * page's Memory tab go through. */
export function parseMemory(entry: Entry): AgentMemory {
  return {
    // `memory:` is the pre-M17.14 name and is still read, because a vault
    // written against the old shape must not silently forget everything its
    // agents had learned. A record carrying both prefers the new key.
    recent: tierOf(entry, 'recent') || tierOf(entry, 'memory'),
    preferences: tierOf(entry, 'preferences'),
  };
}

/** What an Agent record's `ask-first:` says (M57.4): whether it asks first,
 * and the agent page's warning for a value other than `true` or `false`,
 * which reads on until the person chooses. */
export function askFirstOf(entry: Entry): { on: boolean; warning: string | null } {
  const { on, warn } = readAskFirst(entry.properties, entry.relationships);
  if (!warn) return { on, warning: null };
  const key = TOOL_APPROVAL.ask_first.record_key;
  const related = entry.relationships[key];
  const value = entry.properties[key] ?? null;
  const shown =
    related !== undefined
      ? related.map((target) => `[[${target}]]`).join(', ')
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  return { on, warning: `${key}: ${shown} — read as on until you choose` };
}

/** `scope:` frontmatter — a folder, or a list of them. */
export function parseScope(entry: Entry): string[] | null {
  // Wikilink-valued fields land in `relationships`; a folder is not a
  // wikilink, so this only reads properties — but a hand-written
  // `scope: [[Product]]` would arrive there, and is not a folder either way.
  return folderList(entry.properties.scope);
}

/** `read-scope:` frontmatter (M34.4) — same grammar, the READ axis. */
export function parseReadScope(entry: Entry): string[] | null {
  return folderList(entry.properties['read-scope']);
}

function folderList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const items = Array.isArray(raw) ? raw : [raw];
  return items
    .filter((v): v is string => typeof v === 'string')
    .map((v) =>
      v
        .trim()
        .replace(/^\.?\/+/, '')
        .replace(/\/+$/, ''),
    )
    .filter((v) => v !== '');
}

export function isAgentEntry(entry: Entry): boolean {
  // See isSkillEntry — one rule, in libraryKind.
  return libraryKind(entry) === 'agent' && entry.parseError === null;
}

/**
 * The name an agent answers to (M13.4's actor slug, named in M33b.6).
 *
 * A declared `slug:` fixes it, which is the part that ends up stamped into
 * provenance: renaming an agent used to silently re-attribute everything it
 * wrote from then on, so the record of who wrote what split in two at the
 * rename (M17.8). It is now also what `@handle` resolves against, so a rename
 * does not change who you are talking to either.
 */
export function agentHandle(entry: Entry): string {
  return declaredSlug(entry) || slugify(entry.title);
}

export function agentRef(entry: Entry): AgentRef {
  const handle = agentHandle(entry);
  return {
    actor: `process:${handle}`,
    handle,
    id: recordIdentity(entry),
    title: entry.title,
    path: entry.path,
    description:
      typeof entry.properties.description === 'string'
        ? entry.properties.description.replace(/\s+/g, ' ').trim()
        : '',
    shell: entry.properties.tools === 'shell',
    scope: parseScope(entry),
    readScope: parseReadScope(entry),
    allowedTools: parseAllowedTools(entry.properties['allowed-tools']),
    disallowedTools: parseAllowedTools(entry.properties['disallowed-tools']),
    capabilities: parseAllowedTools(entry.properties.capabilities) ?? [],
    connectors: parseAllowedTools(entry.properties.connectors),
    model: storedChoice(entry.properties.model),
    effort: storedChoice(entry.properties.effort),
    askFirst: askFirstOf(entry).on,
    askFirstWarning: askFirstOf(entry).warning,
    memory: parseMemory(entry),
  };
}

export function listAgents(entries: Entry[]): AgentRef[] {
  return entries
    .filter(isAgentEntry)
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(agentRef);
}

// --- Addressing an agent by name (M33b.6) ------------------------------------

/**
 * `@handle` on a word boundary — the same token the composer's `@` menu
 * completes, and the same boundary rule it uses, so `josef@example` is an
 * email address here as well as there.
 */
const MENTION = /(?:^|[\s(])@([A-Za-z0-9][A-Za-z0-9_-]*)/;

/**
 * Who a message is addressed to: a chat turn (M33b.6), or a person's comment
 * in a page's thread (M70.4, `askAgentInThread`).
 *
 * `agent` is null when the vault holds nobody by that name. That is not an
 * error and not silence: the `@name` stays in the message as ordinary text —
 * which is all it ever was — and the handle is carried out so the surface can
 * say, quietly, that it did not route.
 */
export interface Address {
  /** The handle as typed, slugified — what was looked up. */
  handle: string;
  agent: AgentRef | null;
}

/**
 * Read the recipient out of a composed message or comment.
 *
 * `null` means the message addresses nobody, which is every message that does
 * not contain an `@` — the common case, and the one that must cost nothing.
 *
 * The FIRST mention wins and any later one is left as text. A turn carries one
 * grant, one scope and one memory, so it has one recipient; quietly merging two
 * agents' grants is exactly the widening this phase must not become.
 */
export function readAddress(text: string, entries: Entry[]): Address | null {
  const match = text.match(MENTION);
  if (match === null) return null;
  const handle = slugify(match[1]);
  if (handle === '') return null;
  // Title order, via listAgents, so two records that somehow claim one handle
  // resolve the same way on every send rather than by scan order.
  return { handle, agent: listAgents(entries).find((a) => a.handle === handle) ?? null };
}

/**
 * Intersect two tool narrowings, either of which may be absent (M33b.6).
 *
 * A turn can be narrowed twice — a skill's `allowed-tools:` and, now, the
 * addressed agent's — and the answer has to be the narrower of the two, never
 * their union. `null` means "does not narrow", so it yields to the other side;
 * `[]` means "narrow to nothing", which survives everything. Same direction as
 * `narrow()` in agent/mod.rs, which applies the result to the granted policy:
 * every layer here subtracts, and no layer can add.
 */
export function narrowTools(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): string[] | null {
  if (a == null) return b == null ? null : [...b];
  if (b == null) return [...a];
  const wanted = new Set(b.map((t) => t.trim().toLowerCase()));
  return a.filter((t) => wanted.has(t.trim().toLowerCase()));
}
