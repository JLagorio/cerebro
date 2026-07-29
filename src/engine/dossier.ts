import {
  conceptEdges,
  conceptsAbout,
  type Concept,
  type Source,
} from './okf';
import type { Entry } from './types';

/**
 * Everything the base knows about one entity, assembled (M8.9).
 *
 * The three slices before this one made knowledge accumulate, connect, and
 * retire. None of them gave you a place to STAND and see what the base holds
 * about the thing you are working on — the Knowledge page lists concepts, and
 * a list of thirty rows is not the same as knowing something.
 *
 * The shape is deliberate. `current` and `retired` are separated rather than
 * ordered, because a replaced claim shown among live ones is worse than not
 * showing it at all. `unsettled` exists because the honest answer to "what do
 * you know about Phoenix" includes the parts that disagree, and a summary that
 * hides them is the kind of confident-and-wrong that makes people stop
 * trusting the whole thing. `readFrom` is the reading list — it is what turns
 * "the assistant says X" into "the assistant read these four notes and says X".
 */

export interface DossierSource {
  resource: string;
  title: string | null;
  /** How many concepts cite it — a source used repeatedly carries more. */
  citedBy: number;
}

export interface Unsettled {
  concept: Concept;
  /** `contradicts` — an open disagreement. `stale` — past its recheck date. */
  reason: 'contradicts' | 'stale';
  /** The other side of a disagreement. */
  other: Concept | null;
}

export interface Dossier {
  /** Live knowledge, most-recently-written first. */
  current: Concept[];
  /** Replaced — kept, because what was believed before is part of the record. */
  retired: Concept[];
  unsettled: Unsettled[];
  readFrom: DossierSource[];
  /** Earliest and latest `generated.at` across `current`. */
  firstLearned: string | null;
  lastLearned: string | null;
}

const stampOf = (c: Concept): string => c.generated?.at ?? '';

/** Two entries naming the same file are one source, however each spelled it. */
const sourceKey = (source: Source): string => source.resource.replace(/^\.?\//, '');

export function buildDossier(
  path: string,
  concepts: readonly Concept[],
  entries: Entry[],
): Dossier {
  const mine = conceptsAbout(path, [...concepts], entries);
  const current = mine
    .filter((c) => c.supersededBy === null && c.lifecycle !== 'deprecated')
    .sort((a, b) => stampOf(b).localeCompare(stampOf(a)) || a.title.localeCompare(b.title));
  const retired = mine
    .filter((c) => c.supersededBy !== null || c.lifecycle === 'deprecated')
    .sort((a, b) => stampOf(b).localeCompare(stampOf(a)) || a.title.localeCompare(b.title));

  const unsettled: Unsettled[] = [];
  const seenPairs = new Set<string>();
  for (const concept of current) {
    for (const edge of conceptEdges(concept, concepts, entries)) {
      if (edge.kind !== 'contradicts') continue;
      // A disagreement is one fact, not two. Keyed on the unordered pair so
      // it is reported once however many ends declared it.
      const pair = [concept.entry.path, edge.concept.entry.path].sort().join('|');
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      unsettled.push({ concept, reason: 'contradicts', other: edge.concept });
    }
  }
  for (const concept of current) {
    if (concept.stale) unsettled.push({ concept, reason: 'stale', other: null });
  }

  // Deduped across every concept: the same standup feeding four concepts is
  // one thing you read, and listing it four times would overstate the corpus.
  const sources = new Map<string, DossierSource>();
  for (const concept of current) {
    for (const source of concept.sources) {
      const key = sourceKey(source);
      const existing = sources.get(key);
      if (existing === undefined) {
        sources.set(key, { resource: key, title: source.title, citedBy: 1 });
      } else {
        existing.citedBy += 1;
        existing.title ??= source.title;
      }
    }
  }
  const readFrom = [...sources.values()].sort(
    (a, b) => b.citedBy - a.citedBy || a.resource.localeCompare(b.resource),
  );

  const stamps = current.map(stampOf).filter((s) => s !== '').sort();
  return {
    current,
    retired,
    unsettled,
    readFrom,
    firstLearned: stamps[0] ?? null,
    lastLearned: stamps[stamps.length - 1] ?? null,
  };
}

/** True when there is nothing to show — the caller renders its own empty state. */
export function isEmptyDossier(dossier: Dossier): boolean {
  return dossier.current.length === 0 && dossier.retired.length === 0;
}
