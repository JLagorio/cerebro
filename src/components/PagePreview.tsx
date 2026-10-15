import { useMemo } from 'react';
import { EntryIcon } from '@/components/PageIcon';
import { Icon } from '@/components/ui/Icon';
import { statusFieldOf } from '@/engine/pageCard';
import type { Entry } from '@/engine/types';
import { parseLinkTarget, resolveLink } from '@/engine/wikilink';
import { FlagChip, ReviewChip } from '@/knowledge/ReviewChip';
import { useConcept } from '@/knowledge/useConcepts';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { FieldChip } from '@/views/FieldChip';

/**
 * What a page link's hover card shows (M59.7), beside the page card
 * (PageCard) and the icon (PageIcon) it borrows from.
 *
 * - Resolved: the icon, the title (`Title › Heading` for a section link) as a
 *   button that opens it, the path, the status chip when the target's type
 *   has a status field (`statusFieldOf`, a capability, never a type name —
 *   CV-08), a concept's review state or Replaced, and the scan's snippet.
 * - Unresolved: `No page named "<page>"`, the dangling copy of M55.8.
 *
 * Everything comes from the scan: the snippet is the scan's, so a hover reads
 * no file and writes nothing (M17.19). A section link previews the page's
 * opening, not the section.
 */

export const PAGE_PREVIEW_GROUP = 'page-preview';

/** The page and section `target` reaches. `[[#Heading]]` is a heading of the
 * page the link sits in (`notePath`), as the chip reads it. */
function reach(
  target: string,
  entries: Entry[],
  notePath: string | null,
): { entry: Entry; section: string | null } | null {
  const { page, section } = parseLinkTarget(target);
  if (page === '' && section !== null) {
    const own = notePath === null ? undefined : entries.find((e) => e.path === notePath);
    return own === undefined ? null : { entry: own, section };
  }
  return resolveLink(target, entries);
}

export function PagePreview({
  target,
  onOpen,
  notePath = null,
}: {
  target: string;
  onOpen: () => void;
  /** The page the link sits in, for `[[#Heading]]`. */
  notePath?: string | null;
}) {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const link = useMemo(() => reach(target, entries, notePath), [entries, notePath, target]);
  const concept = useConcept(link?.entry.path ?? null);

  if (link === null) {
    const { page } = parseLinkTarget(target);
    return (
      <div
        data-testid="page-preview"
        data-state="missing"
        className="flex items-center gap-2 px-3 py-2.5 text-sm"
      >
        <Icon name="file-x" size={16} color="var(--n-400)" />
        <span className="min-w-0 flex-1 text-n-500" data-testid="page-preview-missing">
          No page named &quot;{page === '' ? target : page}&quot;
        </span>
      </div>
    );
  }

  const { entry, section } = link;
  const field = statusFieldOf(entry, schema);
  const status = field === null ? null : schema.resolveField(entry, field.name);
  const snippet = entry.snippet.trim();

  return (
    <div
      data-testid="page-preview"
      data-state="resolved"
      className="flex flex-col gap-1.5 px-3 py-2.5 text-sm"
    >
      <button
        type="button"
        data-testid="page-preview-title"
        aria-label={`Open ${entry.title}`}
        onClick={onOpen}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left font-medium text-n-900 hover:underline"
      >
        <EntryIcon
          entry={entry}
          size={16}
          fallback={{ name: 'file-text', color: 'var(--n-500)' }}
        />
        <span className="truncate">
          {entry.title}
          {section !== null && ` › ${section}`}
        </span>
      </button>
      <div className="truncate text-2xs text-n-500" data-testid="page-preview-path">
        {entry.path}
      </div>
      {((status !== null && status.display !== '') || concept !== null) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {status !== null && status.display !== '' && (
            <span data-testid="page-preview-status" className="inline-flex">
              <FieldChip resolved={status} />
            </span>
          )}
          {concept !== null &&
            (concept.supersededBy !== null ? (
              <FlagChip icon="archive" label="Replaced" tone="muted" />
            ) : (
              <ReviewChip status={concept.review} by={concept.reviewedBy} size="sm" />
            ))}
        </div>
      )}
      {snippet !== '' ? (
        <p
          data-testid="page-preview-snippet"
          className="m-0 line-clamp-3 text-xs leading-[1.45] text-n-600"
        >
          {snippet}
        </p>
      ) : (
        <p data-testid="page-preview-empty" className="m-0 text-xs text-n-400">
          No text to preview.
        </p>
      )}
    </div>
  );
}
