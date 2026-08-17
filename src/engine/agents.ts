import { slugify } from '@/lib/slug';
import { declaredSlug, recordIdentity } from './identity';
import { AGENT_TYPE, libraryKind } from './library';
import { parseAllowedTools } from './skills';
import type { Entry } from './types';

/**
 * Agents (M13.4): an agent is a record.
 *
 * A record of `type: Agent` whose body is its standing instructions. It runs
 * unattended on its `schedule:`, its writes are attributed to
 * `process:<slug>` — the actor slot the OKF schema has reserved since M8 —
 * and its memory between runs is the `memory:` frontmatter property, which
 * it rewrites through update_frontmatter at the end of each run. Memory in
 * frontmatter rather than a hidden state file on purpose: it renders as an
 * ordinary property on the record, so what the agent carries forward is
 * always one click from the person it works for.
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
   * still capped by the Settings ceiling. Anything else reads as safe. */
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
  /** Tools this agent may use, intersected with the granted policy (M17.8). */
  allowedTools: string[] | null;
  /**
   * Connectors this agent may reach (M18.4).
   *
   * Null when the record names none — the run gets whatever the vault has
   * enabled, which is what every agent had before. An empty list is the
   * opposite: named, and named nothing.
   *
   * Worth having as its own axis rather than folding into `scope:`, because
   * they bound different things. `scope:` says what the agent may CHANGE in
   * your vault; this says what it may READ from the outside world on your
   * behalf — and a tightly scoped agent that can still query every connected
   * system is only half-bounded.
   */
  connectors: string[] | null;
  /**
   * What this agent carries between runs (M17.14).
   *
   * ClickUp's three tiers, and only two of them are fields — which is the
   * finding rather than a shortcut:
   *
   * - **Recent** is `recent:` (or the pre-M17 `memory:`): the agent's own
   *   working notes, rewritten at the end of every run. Volatile by design.
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
  /** The agent's own working notes, rewritten each run. */
  recent: string;
  /** What the human told it. The agent may read this and never write it. */
  preferences: string;
}

/** The tier names, for the builder and for the prompt. */
export const MEMORY_TIERS = ['recent', 'preferences'] as const;

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseMemory(entry: Entry): AgentMemory {
  return {
    // `memory:` is the pre-M17.14 name and is still read, because a vault
    // written against the old shape must not silently forget everything its
    // agents had learned. A record carrying both prefers the new key.
    recent: textOf(entry.properties.recent) || textOf(entry.properties.memory),
    preferences: textOf(entry.properties.preferences),
  };
}

/** `scope:` frontmatter — a folder, or a list of them. */
export function parseScope(entry: Entry): string[] | null {
  // Wikilink-valued fields land in `relationships`; a folder is not a
  // wikilink, so this only reads properties — but a hand-written
  // `scope: [[Product]]` would arrive there, and is not a folder either way.
  const raw = entry.properties.scope;
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
    allowedTools: parseAllowedTools(entry.properties['allowed-tools']),
    connectors: parseAllowedTools(entry.properties.connectors),
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
 * Who a message is addressed to (M33b.6).
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
 * Read the recipient out of a composed message.
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
