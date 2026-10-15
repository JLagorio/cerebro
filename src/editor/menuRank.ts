import type { DefaultReactSuggestionItem } from '@blocknote/react';
import { NO_RECENCY, rankGroups, type Recency } from '@/lib/nameRank';

/** Rows each group of a ranked editor menu keeps (M59.3); typing narrows the rest. */
export const MENU_PER_GROUP = 20;

/**
 * One title per menu row (M52.1).
 *
 * BlockNote keys a suggestion row by its TITLE, so two pages with one title —
 * the demo vault's knowledge index and its Knowledge agent — were two rows
 * with one key, and React, reconciling the list as it changed, left one
 * behind. MEASURED: typing `[^` on a concept showed a stale "Knowledge" link
 * row above the sources it offered, and clicking it would have linked a page.
 * A repeat takes an invisible suffix: the rows read the same, and their
 * subtext already tells them apart.
 */
export function distinctTitles(items: DefaultReactSuggestionItem[]): DefaultReactSuggestionItem[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const repeats = seen.get(item.title) ?? 0;
    seen.set(item.title, repeats + 1);
    return repeats === 0 ? item : { ...item, title: item.title + '​'.repeat(repeats) };
  });
}

export interface MenuRankOptions {
  recency?: Recency;
  /** The page a row links, for the open log's ranking; none for other rows. */
  pathOf?: (item: DefaultReactSuggestionItem) => string | undefined;
  perGroup?: number;
}

/**
 * The editor's `@` menu and `[` page rows, best first (M59.3): ranked by
 * `src/lib/nameRank.ts` over each row's title, aliases and subtext (a page
 * row's subtext is its path), groups kept contiguous in the order they first
 * appear, each capped at `perGroup`. Titles are made distinct AFTER ranking,
 * so the suffix follows the row that is actually shown second.
 */
export function rankSuggestionItems(
  items: DefaultReactSuggestionItem[],
  query: string,
  { recency = NO_RECENCY, pathOf, perGroup = MENU_PER_GROUP }: MenuRankOptions = {},
): DefaultReactSuggestionItem[] {
  return distinctTitles(
    rankGroups({
      query,
      items,
      texts: (item) => [
        item.title,
        ...(item.aliases ?? []),
        typeof item.subtext === 'string' ? item.subtext : null,
      ],
      path: pathOf,
      recency,
      group: (item) => item.group ?? '',
      perGroup,
    }),
  );
}
