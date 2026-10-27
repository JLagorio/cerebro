import type { Entry } from './types';
import { compareUnicodeScalars as compare } from './stringOrder';
import limits from '../../shared/knowledge/source-occurrences.v1.json';
import { sha256Hex } from '@/lib/sha256';
import { boundedSourceBody, sourceLocatorForWindow, sourceUtf8Length } from './sourceLocation';
import { itemKeyOf, targetIndexFor, wikilinkSpans } from './wikilink';
import type { SourceLocator } from './sourceLocation';

export type OccurrenceMode = 'linked' | 'mention';
export interface SourceOccurrence {
  id: string;
  location: SourceLocator;
  targetPath: string;
  targetFragment?: string;
  via: string;
}
export interface OccurrenceCounts {
  shownOccurrences: number;
  shownPages: number;
  examinedSources: number;
  cappedSources: number;
  unavailableSources: number;
  unsupportedSources: number;
}
export type OccurrencePage =
  | {
      status: 'ready';
      snapshotId: string;
      rows: SourceOccurrence[];
      nextCursor: string | null;
      truncated: boolean;
      counts: OccurrenceCounts;
    }
  | { status: 'changedSnapshot'; reason: string };
export interface OccurrenceSource {
  entry: Entry;
  body: string;
  fields: { key: string; text: string }[];
  sourceHash: string | null;
  carrier: string;
  capped: boolean;
}
export interface OccurrenceScope {
  vaultId: string;
  admits: (path: string) => boolean;
}

interface Cursor {
  version: number;
  target: string;
  mode: OccurrenceMode;
  scope: string;
  snapshot: string;
  source: number;
  row: number;
}
interface Candidate {
  start: number;
  end: number;
  text: string;
  key?: string;
  fragment?: string;
  via: string;
}
const identifier = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}_]/u.test(char);
const fragmentPadding = new Set(limits.fragmentTrimCodePoints);

/** Run only after canonical whole-name-first resolution. Both readers use
 * the shared scalar set instead of their language's different trim rules. */
function occurrenceFragment(value: string | null): string | null {
  if (value === null) return null;
  const scalars = [...value];
  let start = 0;
  let end = scalars.length;
  while (start < end && fragmentPadding.has(scalars[start].codePointAt(0)!)) start++;
  while (end > start && fragmentPadding.has(scalars[end - 1].codePointAt(0)!)) end--;
  return start === end ? null : scalars.slice(start, end).join('');
}

/** Scalar lowercasing keeps a mapping across expansions such as İ → i + dot. */
function mentionRanges(text: string, names: readonly string[]): { start: number; end: number }[] {
  let folded = '';
  const original = new Map<number, number>([[0, 0]]);
  let offset = 0;
  for (const char of text) {
    folded += char.toLowerCase();
    offset += char.length;
    original.set(folded.length, offset);
  }
  const found: { start: number; end: number }[] = [];
  for (const name of names) {
    const needle = [...name].map((char) => char.toLowerCase()).join('');
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const at = folded.indexOf(needle, from);
      if (at < 0) break;
      const start = original.get(at);
      const end = original.get(at + needle.length);
      if (
        start !== undefined &&
        end !== undefined &&
        !identifier([...text.slice(Math.max(0, start - 2), start)].at(-1)) &&
        !identifier([...text.slice(end, end + 2)][0])
      )
        found.push({ start, end });
      from = at + 1;
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  let end = -1;
  return found.filter((range) => {
    if (range.start < end) return false;
    end = range.end;
    return true;
  });
}

function candidatesFor(
  source: OccurrenceSource,
  target: Entry,
  index: ReturnType<typeof targetIndexFor>,
  mode: OccurrenceMode,
  names: readonly string[],
): Candidate[] {
  const body = boundedSourceBody(source.body);
  const spans = wikilinkSpans(body);
  const candidates: Candidate[] = [];
  if (mode === 'linked') {
    for (const span of spans) {
      const resolved = index.resolveLink(span.target);
      if (resolved?.entry.path !== target.path) continue;
      const fragment = occurrenceFragment(resolved.section);
      candidates.push({
        start: span.start,
        end: span.end,
        text: body,
        via: 'body',
        ...(fragment === null ? {} : { fragment }),
      });
    }
    for (const field of [...source.fields].sort((a, b) => compare(a.key, b.key))) {
      for (const raw of source.entry.relationships[field.key] ?? []) {
        const resolved = index.resolveLink(raw);
        if (resolved?.entry.path !== target.path) continue;
        const fragment = occurrenceFragment(resolved.section);
        const at = field.text.indexOf(raw.trim());
        if (at < 0) continue;
        candidates.push({
          start: at,
          end: at + raw.trim().length,
          text: field.text,
          key: field.key,
          via: field.key,
          ...(fragment === null ? {} : { fragment }),
        });
        break; // A relation identifies its property row, never an array member.
      }
    }
  } else {
    let linked = 0;
    for (const range of mentionRanges(body, names)) {
      while (linked < spans.length && spans[linked].end <= range.start) linked++;
      if (linked < spans.length && spans[linked].start < range.end) continue;
      candidates.push({ ...range, text: body, via: 'body' });
    }
  }
  return candidates;
}

/** Browser twin of the native bounded snapshot query. Called only on request. */
export function findSourceOccurrencesWith(
  scope: OccurrenceScope,
  input: readonly OccurrenceSource[],
  targetPath: string,
  mode: OccurrenceMode,
  encoded?: string | null,
): OccurrencePage {
  const sources = input
    .filter((source) => scope.admits(source.entry.path))
    .slice()
    .sort((a, b) => compare(a.entry.path, b.entry.path));
  const entries = sources.map((source) => source.entry);
  const target = entries.find((entry) => entry.path === targetPath);
  const scopeId = sha256Hex(JSON.stringify([scope.vaultId, entries.map((entry) => entry.path)]));
  const snapshotId = sha256Hex(
    JSON.stringify(
      sources.map((source) => [
        source.entry.path,
        source.sourceHash,
        source.carrier,
        source.capped,
        source.entry.parseError,
      ]),
    ),
  );
  const identity = {
    version: limits.version,
    target: sha256Hex(targetPath),
    mode,
    scope: scopeId,
    snapshot: snapshotId,
  };
  const changed = (): OccurrencePage => ({
    status: 'changedSnapshot',
    reason: 'Sources or readable scope changed. Refresh to search again.',
  });
  let cursor: Cursor = { ...identity, source: 0, row: 0 };
  if (encoded) {
    if (sourceUtf8Length(encoded) > limits.cursorBytes) return changed();
    try {
      const parsed = JSON.parse(encoded) as Partial<Cursor>;
      if (
        Object.entries(identity).some(([key, value]) => parsed[key as keyof Cursor] !== value) ||
        !Number.isSafeInteger(parsed.source) ||
        !Number.isSafeInteger(parsed.row) ||
        parsed.source! < 0 ||
        parsed.source! > sources.length ||
        parsed.row! < 0
      )
        return changed();
      cursor = parsed as Cursor;
    } catch {
      return changed();
    }
  }
  if (!target) {
    if (encoded) return changed();
    throw new Error('Target is unavailable.');
  }
  const index = targetIndexFor(entries);
  const stem = target.filename.replace(/\.md$/i, '');
  const names = [
    ...new Set(
      [
        stem,
        target.filename.toLowerCase() === 'project.md'
          ? (target.folder.split('/').at(-1) ?? '')
          : '',
        itemKeyOf(target) ?? '',
        target.title,
      ]
        .map((name) => name.trim())
        .filter((name) => name !== '' && index.resolveLink(name)?.entry.path === targetPath),
    ),
  ];
  const rows: SourceOccurrence[] = [];
  const pages = new Set<string>();
  const counts: OccurrenceCounts = {
    shownOccurrences: 0,
    shownPages: 0,
    examinedSources: 0,
    cappedSources: 0,
    unavailableSources: 0,
    unsupportedSources: 0,
  };
  let examinedBytes = 0;
  let at = cursor.source;
  let ordinal = cursor.row;
  outer: for (; at < sources.length;) {
    if (counts.examinedSources >= limits.examinedSources) break;
    const source = sources[at];
    const size =
      sourceUtf8Length(boundedSourceBody(source.body)) +
      source.fields.reduce((sum, field) => sum + sourceUtf8Length(field.text), 0);
    if (examinedBytes + size > limits.examinedBytes) {
      if (size > limits.examinedBytes) {
        counts.examinedSources++;
        counts.cappedSources++;
        at++;
        ordinal = 0;
      }
      break;
    }
    counts.examinedSources++;
    examinedBytes += size;
    if (source.capped) counts.cappedSources++;
    if (source.entry.parseError !== null || source.sourceHash === null) {
      counts.unavailableSources++;
      at++;
      ordinal = 0;
      continue;
    }
    if (source.carrier !== 'markdown') {
      counts.unsupportedSources++;
      at++;
      ordinal = 0;
      continue;
    }
    if (source.entry.path === targetPath) {
      at++;
      ordinal = 0;
      continue;
    }
    const candidates = candidatesFor(source, target, index, mode, names);
    let unlocatable = false;
    for (; ordinal < candidates.length; ordinal++) {
      const item = candidates[ordinal];
      const range = {
        start: sourceUtf8Length(item.text.slice(0, item.start)),
        end: sourceUtf8Length(item.text.slice(0, item.end)),
      };
      const location = sourceLocatorForWindow(
        scope.vaultId,
        source.entry.path,
        source.sourceHash,
        item.text,
        range,
        item.key,
      );
      if (!location) {
        unlocatable = true;
        continue;
      }
      rows.push({
        id: sha256Hex(
          JSON.stringify([
            location.path,
            location.sourceHash,
            location.kind,
            location.propertyKey ?? null,
            location.bodyUtf8Range ?? null,
            targetPath,
            item.fragment ?? null,
          ]),
        ),
        location,
        targetPath,
        via: item.via,
        ...(item.fragment === undefined ? {} : { targetFragment: item.fragment }),
      });
      pages.add(location.path);
      if (rows.length === limits.pageRows) {
        ordinal++;
        if (ordinal === candidates.length) {
          at++;
          ordinal = 0;
        }
        if (unlocatable && !source.capped) counts.cappedSources++;
        break outer;
      }
    }
    if (unlocatable && !source.capped) counts.cappedSources++;
    at++;
    ordinal = 0;
  }
  counts.shownOccurrences = rows.length;
  counts.shownPages = pages.size;
  const nextCursor =
    at < sources.length ? JSON.stringify({ ...identity, source: at, row: ordinal }) : null;
  return { status: 'ready', snapshotId, rows, nextCursor, truncated: nextCursor !== null, counts };
}
