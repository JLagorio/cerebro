import { agentRef, isAgentEntry } from './agents';
import { isKnowledgePath, parseActor, type Actor } from './okf';
import type { Entry } from './types';

/**
 * Who an actor stamp names, in the terms the rest of the app uses (M50.3).
 *
 * A concept said "Written by claude-code", the Knowledge page said
 * "Maintained by Knowledge", and the fleet listed `process:knowledge` — one
 * cast under three names, none linked to another. The stamps are right; they
 * were just never read back into the app's own nouns.
 *
 * - `process:<handle>` is an agent's stamp (`agentRef().actor`). With a record
 *   that answers to it, it IS that agent, found by actor and never by title.
 * - `claude-code` is what the attended assistant stamps (`mcp::DEFAULT_ACTOR`);
 *   `claude-code/<version>` is its older spelling. That is the Assistant.
 * - `human:<id>` is a person — and, when exactly one page in the vault answers
 *   to that id (M52.3), that person's page: `human:tom-keller` reads "Tom
 *   Keller" and opens `people/tom-keller.md`.
 * - Anything else keeps its raw label: an unknown stamp is shown, not guessed.
 */
export type Author =
  | { kind: 'agent'; title: string; path: string; actor: string }
  | { kind: 'assistant'; raw: string }
  | { kind: 'human'; label: string; path?: string }
  | { kind: 'other'; label: string };

export const ASSISTANT_ACTOR = 'claude-code';

export function isAssistantActor(raw: string): boolean {
  return raw === ASSISTANT_ACTOR || raw.startsWith(`${ASSISTANT_ACTOR}/`);
}

/**
 * The three internal constructs, by the actor names Rust stamps
 * (`agent::meter::CONSTRUCT_ACTORS`), with the word a person reads for each
 * (M52.3). The one TypeScript copy: the fleet's filter offers them before any
 * has run, and the Agents page says they are internal instead of offering an
 * editor that could not exist — both used to carry the list themselves, and
 * both printed `agent:m26-ingest` at a reader.
 *
 * Permanently record-less (`meter.rs` records why), so no vault page can name
 * them; their words live here, beside `actorLabel`, which reads them.
 */
export const CONSTRUCT_ACTORS: readonly { actor: string; label: string }[] = [
  { actor: 'agent:m26-ingest', label: 'Ingest' },
  { actor: 'agent:m26-maintenance', label: 'Maintenance' },
  { actor: 'agent:m26-synthesis', label: 'Synthesis' },
];

const stem = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/i, '');

/**
 * The one page a person's id names, or null (M52.3). Matched on the file's
 * name or its declared `slug:` — never on its type, which would be routing on
 * a type name (AGENTS.md) — and only when exactly ONE page answers: two
 * `tom-keller` pages is a question this cannot settle, and a guess would put
 * the wrong name on somebody's verification. Knowledge is not a person.
 */
function personPage(id: string, entries: Entry[]): Entry | null {
  const matches = entries.filter(
    (e) => !isKnowledgePath(e.path) && (stem(e.path) === id || e.properties.slug === id),
  );
  return matches.length === 1 ? matches[0] : null;
}

export function resolveAuthor(actor: Actor, entries: Entry[]): Author {
  if (actor.kind === 'human') {
    const page = personPage(actor.label, entries);
    return page === null
      ? { kind: 'human', label: actor.label }
      : { kind: 'human', label: page.title, path: page.path };
  }
  if (isAssistantActor(actor.raw)) return { kind: 'assistant', raw: actor.raw };
  const record = entries.find((e) => isAgentEntry(e) && agentRef(e).actor === actor.raw);
  if (record !== undefined) {
    return { kind: 'agent', title: record.title, path: record.path, actor: actor.raw };
  }
  return { kind: 'other', label: actor.label };
}

/**
 * A run's or a proposal's actor, as one line of text (M52.3).
 *
 * The fleet rows, its actor filter, a run's header and the roster's
 * "also ran here" note each printed the raw column — `process:knowledge`
 * beside a concept that said "Knowledge agent" — so the same worker had two
 * names depending on which surface you met it on.
 *
 * - `text` is what a person reads. An agent is its record's title; the
 *   attended assistant is "Assistant"; a construct is "Background ingest"; a
 *   person is their page's title, or their id when no page answers; `null` is
 *   "unattributed" — a category, never a blank — and anything unrecognised is
 *   its raw id, shown and not guessed.
 * - `raw` is the stamp itself, for a `title=`: what the runtime recorded
 *   stays one hover away. Null only when nothing was recorded.
 * - `actor` is set when a record answers to the stamp, so a caller can link it.
 */
export interface ActorLabel {
  text: string;
  raw: string | null;
  actor?: string;
}

export function actorLabel(raw: string | null, entries: Entry[]): ActorLabel {
  if (raw === null) return { text: 'unattributed', raw: null };
  const construct = CONSTRUCT_ACTORS.find((c) => c.actor === raw);
  // "Background maintenance", not "Maintenance · internal" (M52.5): the
  // middle dot and "internal" read as a code on a proposal card.
  if (construct !== undefined) {
    return { text: `Background ${construct.label.toLowerCase()}`, raw };
  }
  const parsed = parseActor(raw);
  if (parsed === null) return { text: raw, raw };
  const author = resolveAuthor(parsed, entries);
  switch (author.kind) {
    case 'agent':
      return { text: author.title, raw, actor: author.actor };
    case 'assistant':
      return { text: 'Assistant', raw };
    case 'human':
      // The page's title when one answers, else the id after `human:` — the
      // same word the concept's Details tab shows for them.
      return { text: author.label, raw };
    case 'other':
      return { text: raw, raw };
  }
}
