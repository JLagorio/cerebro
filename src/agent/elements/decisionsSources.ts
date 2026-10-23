import { sourceTarget } from '@/editor/citations';
import type { SourceRef } from '@/engine/ai/types';
import { linkLabel } from '@/engine/linkLabels';
import type { Source } from '@/engine/okf';
import type { Entry } from '@/engine/types';

/**
 * A concept's sources (M91.14), as the Sources element lists them: a web page
 * is a link out, a page of this vault opens in the app through the caller,
 * and anything else is its words (CV-16). Where a `resource` leads is
 * `sourceTarget`'s one rule, which the body's citation chips follow too
 * (M51.5): a resource with a scheme is an address — a link only when it is
 * http(s), which the element checks — a path opens when a page answers to
 * it, and anything else (a path no page answers to, an OKF scope descriptor
 * such as "all queries in project X") names something nobody can follow.
 */

/** A row for the Sources element, and the vault page it opens, if any. */
export interface ResourceRow {
  ref: SourceRef;
  /** The vault page a press opens, or null: an address, or a resource no
   *  page answers to. */
  page: string | null;
}

/**
 * One resource as a row. An untitled web page reads as the name its link
 * carries (M69.2), where the link names one, else as its host; the address
 * stays one hover away. A vault page reads as its title. A concept's sources
 * are what its own text cites, so each is `via: 'text'`.
 */
export function resourceRow(
  resource: string,
  title: string | null,
  entries: readonly Pick<Entry, 'path' | 'title'>[],
): ResourceRow {
  const target = sourceTarget(resource, entries);
  if (target !== null && 'external' in target) {
    const named = title ?? linkLabel(resource)?.text;
    return {
      ref: { kind: 'url', url: resource, via: 'text', ...(named ? { title: named } : {}) },
      page: null,
    };
  }
  if (target !== null) {
    const page = entries.find((entry) => entry.path === target.internal);
    const named = title ?? (page?.title || undefined);
    return {
      ref: {
        kind: 'vault',
        path: target.internal,
        via: 'text',
        ...(named ? { title: named } : {}),
      },
      page: target.internal,
    };
  }
  return {
    ref: { kind: 'vault', path: resource, via: 'text', ...(title ? { title } : {}) },
    page: null,
  };
}

/** A concept source's row: its resource, by the title the concept gave it. */
export function conceptSourceRow(
  source: Pick<Source, 'resource' | 'title'>,
  entries: readonly Pick<Entry, 'path' | 'title'>[],
): ResourceRow {
  return resourceRow(source.resource, source.title, entries);
}
