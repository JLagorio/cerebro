import { resourceTarget, type ResourceTarget } from '@/editor/citations';
import type { SourceRef } from '@/engine/ai/types';
import { linkLabel } from '@/engine/linkLabels';
import type { Source } from '@/engine/okf';
import type { Entry } from '@/engine/types';

/**
 * A concept's sources (M91.14), as the Sources element lists them: a web page
 * is a link out, a page of this vault opens in the app through the caller,
 * and anything else is its words (CV-16). Where a `resource` leads is
 * `resourceTarget`'s one rule, which the body's citation chips project too
 * (M51.5). Missing local references, scope prose and unsafe addresses never
 * acquire a SourceRef's file or URL semantics. Classification is not evidence
 * that the resource was read or supports a claim.
 */

/** A row for the Sources element, and the vault page it opens, if any. */
export type ResourceRow =
  | {
      target: Extract<ResourceTarget, { kind: 'VaultPage' | 'ExternalUrl' }>;
      ref: SourceRef;
      page: string | null;
    }
  | {
      target: Extract<ResourceTarget, { kind: 'MissingLocal' | 'Descriptor' }>;
      ref: null;
      page: null;
      label: string;
      /** The literal source spelling, retained even when a title names it. */
      resource: string;
    };

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
  const target = resourceTarget(resource, entries);
  if (target.kind === 'ExternalUrl') {
    const named = title ?? linkLabel(target.url)?.text;
    return {
      target,
      ref: { kind: 'url', url: target.url, via: 'text', ...(named ? { title: named } : {}) },
      page: null,
    };
  }
  if (target.kind === 'VaultPage') {
    const page = entries.find((entry) => entry.path === target.path);
    const named = title ?? (page?.title || undefined);
    return {
      target,
      ref: {
        kind: 'vault',
        path: target.path,
        via: 'text',
        ...(named ? { title: named } : {}),
      },
      page: target.path,
    };
  }
  return {
    target,
    ref: null,
    page: null,
    label: title?.trim() || resource,
    resource,
  };
}

/** A concept source's row: its resource, by the title the concept gave it. */
export function conceptSourceRow(
  source: Pick<Source, 'resource' | 'title'>,
  entries: readonly Pick<Entry, 'path' | 'title'>[],
): ResourceRow {
  return resourceRow(source.resource, source.title, entries);
}
