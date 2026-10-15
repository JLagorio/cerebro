/**
 * Meeting transcripts as records (M64.7): who spoke, matched to people.
 *
 * A dropped `.vtt` or `.srt` records the labels it names in `speakers`
 * (engine/ingest.ts). This module reads them back and matches each label to
 * a page of a people type, deterministically: exactly one page by title,
 * ignoring case, or by filename stem or declared `slug`. None is "none", and
 * two or more is "ambiguous" with a count. The code never guesses, because a
 * guessed attendee is a wrong link on a record nobody rereads.
 *
 * The gates read `ingest_format`, `speakers` and field kinds, never a type
 * name (CV-08). A people type is whatever `peopleTypes` derives.
 */

import { slugify } from '@/lib/slug';
import { isKnowledgePath } from './okf';
import { peopleTypes } from './properties';
import type { Entry, Schema } from './types';
import { formatWikilink, linkTargetOf, linkTargetsFor, resolveTarget } from './wikilink';

/** One speaker label, and the link the file already holds for it, if any. */
export interface Speaker {
  label: string;
  /** The wikilink target the file holds (`relationships.speakers`, CV-09), or null. */
  link: string | null;
}

export interface TranscriptFacts {
  /**
   * The speakers the file names. `null` is NOT RECORDED (a capture from
   * before M64.7 has no key); `[]` is a transcript that names nobody. The two
   * are different sentences and never collapse into one (CV-05).
   */
  speakers: Speaker[] | null;
}

const TRANSCRIPT_FORMATS = new Set(['vtt', 'srt']);

/** The plain labels a `speakers` value holds: a string or a list of them. */
function labelsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v).trim())
    .filter((v) => v !== '');
}

/**
 * What a transcript says about its speakers, or null for any capture that is
 * not one (`ingest_format` other than vtt or srt).
 */
export function transcriptFacts(entry: Entry): TranscriptFacts | null {
  const format = entry.properties.ingest_format;
  if (typeof format !== 'string' || !TRANSCRIPT_FORMATS.has(format)) return null;
  const plain = entry.properties.speakers;
  const linked = entry.relationships.speakers;
  if (plain === undefined && linked === undefined) return { speakers: null };
  const speakers: Speaker[] = [
    ...labelsOf(plain).map((label) => ({ label, link: null })),
    ...(linked ?? []).map((target) => ({ label: target, link: target })),
  ];
  return { speakers };
}

export type SpeakerMatch =
  | { label: string; kind: 'matched'; page: Entry; link: string }
  | { label: string; kind: 'none' }
  | { label: string; kind: 'ambiguous'; count: number };

/** The wikilink a matched speaker is written as: the name that reaches its page. */
export function speakerLink(page: Entry, entries: readonly Entry[]): string {
  return formatWikilink(linkTargetsFor(entries)(page) ?? linkTargetOf(page));
}

const stemOf = (entry: Entry): string => entry.filename.replace(/\.md$/i, '').toLowerCase();

/** The pages a speaker may match: people, outside knowledge/, never a Type doc. */
export function speakerCandidates(schema: Schema, entries: Entry[]): Entry[] {
  const people = peopleTypes(schema, entries);
  return entries.filter(
    (e) => e.type !== null && e.type !== 'Type' && people.has(e.type) && !isKnowledgePath(e.path),
  );
}

/**
 * Match each speaker to one people page, or say why not. A speaker the file
 * already links counts as matched to the page its link resolves to; a link
 * that names no page is "none".
 */
export function matchSpeakers(
  speakers: readonly (string | Speaker)[],
  schema: Schema,
  entries: Entry[],
): SpeakerMatch[] {
  const candidates = speakerCandidates(schema, entries);
  return speakers.map((raw) => {
    const speaker = typeof raw === 'string' ? { label: raw, link: null } : raw;
    const label = speaker.label;
    if (speaker.link !== null) {
      const page = resolveTarget(speaker.link, entries);
      return page === null
        ? { label, kind: 'none' }
        : { label, kind: 'matched', page, link: speakerLink(page, entries) };
    }
    const lower = label.trim().toLowerCase();
    const slug = slugify(label);
    if (lower === '') return { label, kind: 'none' };
    const hits = candidates.filter((page) => {
      if (page.title.trim().toLowerCase() === lower) return true;
      if (slug === '') return false;
      const declared = page.properties.slug;
      return stemOf(page) === slug || (typeof declared === 'string' && declared === slug);
    });
    if (hits.length === 1) {
      const [page] = hits;
      return { label, kind: 'matched', page, link: speakerLink(page, entries) };
    }
    if (hits.length === 0) return { label, kind: 'none' };
    return { label, kind: 'ambiguous', count: hits.length };
  });
}
