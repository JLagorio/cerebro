import { slugify } from '@/lib/slug';
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
  title: string;
  path: string;
  description: string;
  /** The record's `tools:` — 'shell' widens the run to the host tools,
   * still capped by the Settings ceiling. Anything else reads as safe. */
  shell: boolean;
  /** Carried memory, '' on a first run. */
  memory: string;
}

export function isAgentEntry(entry: Entry): boolean {
  return isRecordEntry(entry) && entry.type === AGENT_TYPE && entry.parseError === null;
}

export function agentRef(entry: Entry): AgentRef {
  return {
    actor: `process:${slugify(entry.title)}`,
    title: entry.title,
    path: entry.path,
    description:
      typeof entry.properties.description === 'string'
        ? entry.properties.description.replace(/\s+/g, ' ').trim()
        : '',
    shell: entry.properties.tools === 'shell',
    memory: typeof entry.properties.memory === 'string' ? entry.properties.memory : '',
  };
}

export function listAgents(entries: Entry[]): AgentRef[] {
  return entries
    .filter(isAgentEntry)
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(agentRef);
}
