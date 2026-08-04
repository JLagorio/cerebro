import { slugify } from '@/lib/slug';
import { declaredSlug, recordIdentity } from './identity';
import { parseAllowedTools } from './skills';
import { isRecordEntry } from './typeCatalog';
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

export const AGENT_TYPE = 'Agent';

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
  /** Carried memory, '' on a first run. */
  memory: string;
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
  return isRecordEntry(entry) && entry.type === AGENT_TYPE && entry.parseError === null;
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
    memory: typeof entry.properties.memory === 'string' ? entry.properties.memory : '',
  };
}

export function listAgents(entries: Entry[]): AgentRef[] {
  return entries
    .filter(isAgentEntry)
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(agentRef);
}
