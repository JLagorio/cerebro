import type { CitationSource } from '@/components/ai/InlineCitation';

/**
 * A footnote citation's source as the Inline Citation card shows it
 * (M91.14): the editor's `[^id]` chip and a concept body's citation each
 * open one over their own trigger. Pure.
 *
 * Only a source the page lists has a card. A citation nothing lists keeps
 * its words on the trigger instead — a claim that cites nothing is what a
 * reviewer most needs to see, so it is never left with an empty card.
 */

/** What a citation nothing backs is called. */
export const noSourceText = (id: string): string => `No source "${id}"`;

/** A resource that names a scheme leads out of the vault. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export interface CitedSource {
  /** The source's `resource`, as the frontmatter lists it. */
  resource: string;
  /** What the citation calls it. */
  name: string;
  /** What the page's own `[^id]:` line says of it. */
  definition?: string;
}

/**
 * One listed source as its card's entry: an address out of the vault (only
 * an http(s) one is ever a link, CV-16) or a vault path (a page opens only
 * through the caller, and a path no page answers to is text). It is titled
 * by the citation's name; the page's own definition is its description when
 * that says more than the name.
 */
export function citedSource({ resource, name, definition = '' }: CitedSource): CitationSource {
  const where = resource.trim();
  const title = name.trim() === '' ? undefined : name.trim();
  const says = definition.trim();
  const description = says !== '' && says !== title ? says : undefined;
  return SCHEME.test(where)
    ? { kind: 'url', url: where, title, description, via: 'text' }
    : { kind: 'vault', path: where.replace(/^\/+/, ''), title, description, via: 'text' };
}
