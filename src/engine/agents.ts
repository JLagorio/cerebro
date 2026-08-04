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

export function agentRef(entry: Entry): AgentRef {
  return {
    // A declared `slug:` also fixes the ACTOR, which is the part that ends up
    // stamped into provenance: renaming an agent used to silently re-attribute
    // everything it wrote from then on, so the record of who wrote what split
    // in two at the rename (M17.8).
    actor: `process:${declaredSlug(entry) || slugify(entry.title)}`,
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
    memory: parseMemory(entry),
  };
}

export function listAgents(entries: Entry[]): AgentRef[] {
  return entries
    .filter(isAgentEntry)
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(agentRef);
}
