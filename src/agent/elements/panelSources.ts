import type { KnowledgeNote } from '@/agent/context';
import type { PrLink } from '@/agent/types';
import type { SourceRef } from '@/engine/ai/types';

/**
 * The panel's own sources (M91.14), as the Sources element lists them: the
 * pull requests a conversation's session opened, under its thread (M56.3),
 * and the Knowledge its next turn carries, beside its context (M50.4). A pull
 * request is a link out, which the element draws as one only for an http(s)
 * address and says opens a new tab; a concept is a page of this vault, which
 * the element opens in the app through the caller, never through an href
 * (CV-16). Pure.
 */

export const PANEL_SOURCES_WORDS = {
  /** The line over a session's pull requests. */
  pullRequests: (count: number) => `Opened ${count} pull request${count === 1 ? '' : 's'}`,
  /** The line over the Knowledge a turn carries: what stands, counted as the
   *  page's own strip counts it (M52.4). */
  knowledge: (count: number) => `Knowledge · ${count}`,
  /** After a concept another has replaced. */
  replaced: '· replaced',
  /** After a concept no person's review covers as it now reads. */
  unreviewed: '· unreviewed',
} as const;

/**
 * A session's pull requests, in the order it opened them, each named as its
 * repository writes it: `owner/repo#12`. The address is the record's own;
 * whether it may be a link is the element's one check.
 */
export function pullRequestSources(links: readonly PrLink[]): SourceRef[] {
  return links.map((link): SourceRef => ({
    kind: 'url',
    url: link.url,
    title: `${link.repository}#${link.number}`,
    // No page the reply read or fetched: of the element's ways in, the
    // nearest is an address in what the session wrote.
    via: 'text',
  }));
}

/** A concept the turn carries, as a Sources row. */
export interface KnowledgeSource {
  ref: SourceRef;
  /** Where it stands, in the words after its title; null when a person's
   *  review covers what it says now. */
  standing: string | null;
}

export interface TurnKnowledge {
  /** The concepts that stand: replaced ones travel, and are not counted. */
  count: number;
  /** Every concept the turn carries, those that stand first and in the
   *  order the snapshot gives them, then the replaced ones. */
  rows: KnowledgeSource[];
}

/**
 * The Knowledge a turn carries. A replaced concept still travels — the agent
 * must not quote it as current — so it is listed, last, and says so; one
 * that stands but no person has reviewed as it now reads says that instead.
 */
export function turnKnowledge(knowledge: readonly KnowledgeNote[]): TurnKnowledge {
  const replaced = (note: KnowledgeNote) => note.supersededBy !== undefined;
  const row = (note: KnowledgeNote): KnowledgeSource => ({
    ref: {
      kind: 'vault',
      path: note.path,
      // Handed to the turn with its context, a page it reads.
      via: 'read',
      ...(note.title.trim() === '' ? {} : { title: note.title }),
    },
    standing: replaced(note)
      ? PANEL_SOURCES_WORDS.replaced
      : note.review === 'current'
        ? null
        : PANEL_SOURCES_WORDS.unreviewed,
  });
  const standing = knowledge.filter((note) => !replaced(note));
  return {
    count: standing.length,
    rows: [...standing, ...knowledge.filter(replaced)].map(row),
  };
}
