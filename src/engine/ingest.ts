/**
 * Ingest (M8.2) — turning outside material into working docs.
 *
 * The knowledge pipeline has three inlets and one object: a dropped `.vtt`
 * transcript, a pasted wall of text, and a fetched Jira ticket all become the
 * same thing — an untyped note in `inbox/` carrying provenance about where it
 * came from. Distillation reads that one shape, so adding an inlet never means
 * teaching the distiller a new format.
 *
 * Untyped is the whole point: no `type:` is what puts a note in the Inbox
 * (engine/inbox.ts), so ingested material queues for filing rather than
 * appearing, unreviewed, in the surfaces you author.
 */

import { sha256Hex } from '@/lib/sha256';
import { isKnowledgePath } from './okf';
import type { Entry } from './types';

export type IngestFormat = 'vtt' | 'srt' | 'markdown' | 'text';

/** One speaker turn, after adjacent cues from the same speaker are merged. */
export interface Turn {
  /** Null when the transcript never attributes the line. */
  speaker: string | null;
  /** `HH:MM:SS` of the turn's first cue; null for formats without timing. */
  at: string | null;
  text: string;
}

// --- Format detection ------------------------------------------------------

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
};

/**
 * Extension first, then content sniffing — a transcript exported as `.txt`
 * is still a transcript, and the extension is the least reliable thing about
 * a file that has been through three tools.
 */
export function detectFormat(filename: string, content: string): IngestFormat {
  const ext = extensionOf(filename);
  if (ext === 'vtt') return 'vtt';
  if (ext === 'srt') return 'srt';
  if (/^\uFEFF?WEBVTT/.test(content)) return 'vtt';
  // SRT has no header, so it is recognised by its first cue: an index line
  // followed by a comma-decimal timing line.
  if (/^\uFEFF?\s*\d+\s*\r?\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(content)) return 'srt';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return 'text';
}

// --- Transcript parsing ----------------------------------------------------

/** `00:01:04.500` / `01:04.500` / `00:01:04,500` → `00:01:04`. */
function normalizeTimestamp(raw: string): string | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(raw.trim());
  if (match === null) return null;
  const pad = (v: string) => v.padStart(2, '0');
  return `${pad(match[1] ?? '0')}:${pad(match[2])}:${pad(match[3])}`;
}

const TIMING = /^\s*(\S+)\s*-->\s*(\S+)/;

/** Lowercase name particles, so `Tom van der Berg` still reads as a name. */
const PARTICLES = new Set([
  'van',
  'von',
  'der',
  'den',
  'de',
  'del',
  'di',
  'da',
  'du',
  'la',
  'le',
  'bin',
  'ibn',
  'al',
]);

/**
 * Is this the name of a person, or the first clause of a sentence?
 *
 * Length cannot tell them apart — "The rule is simple" is as short as "Tom van
 * der Berg". Capitalisation can: a name is title-case throughout, and prose is
 * not. Every word must therefore start uppercase (or be a known particle),
 * which rejects the sentence on its second word.
 */
function looksLikeName(candidate: string): boolean {
  if (candidate === '' || /[.!?,;]/.test(candidate)) return false;
  const words = candidate.split(/\s+/);
  if (words.length > 4) return false;
  return words.every(
    (word, i) => /^[\p{Lu}\p{N}]/u.test(word) || (i > 0 && PARTICLES.has(word.toLowerCase())),
  );
}

/**
 * Speaker attribution comes in two shapes and both appear in the wild:
 * WebVTT's `<v Tom Keller>` voice span, and a bare `Tom Keller:` prefix that
 * most meeting tools emit. The voice span is explicit and always trusted; the
 * bare prefix is a guess, so it has to clear `looksLikeName`.
 */
function splitSpeaker(line: string): { speaker: string | null; text: string } {
  const voice = /^<v\s+([^>]+)>\s*(.*)$/.exec(line);
  if (voice !== null) return { speaker: voice[1].trim(), text: voice[2].trim() };

  const prefix = /^([^:]{1,40}):\s+(.*)$/.exec(line);
  if (prefix !== null && looksLikeName(prefix[1].trim())) {
    return { speaker: prefix[1].trim(), text: prefix[2].trim() };
  }
  return { speaker: null, text: line.trim() };
}

/** Starts a WebVTT block that carries no dialogue and runs to a blank line. */
const startsSkippedBlock = (line: string): boolean => /^(NOTE|STYLE|REGION)\b/.test(line.trim());

const isNoise = (line: string): boolean =>
  line.trim() === '' ||
  /^\uFEFF?WEBVTT/.test(line) ||
  startsSkippedBlock(line) ||
  // A bare cue index (`1`, `42`) between blocks.
  /^\d+$/.test(line.trim());

/**
 * Parse WebVTT or SRT into speaker turns, merging consecutive cues from the
 * same speaker. Merging matters: a transcript arrives as 3-second fragments,
 * and a distiller reading fragments loses the shape of an argument that took
 * a minute to make.
 */
export function parseTranscript(content: string): Turn[] {
  const turns: Turn[] = [];
  let pendingAt: string | null = null;
  // NOTE/STYLE/REGION blocks run until a blank line, so skipping only their
  // first line leaves the CSS in the transcript body.
  let skipping = false;

  for (const rawLine of content.split(/\r?\n/)) {
    if (rawLine.trim() === '') {
      skipping = false;
      continue;
    }
    if (startsSkippedBlock(rawLine)) {
      skipping = true;
      continue;
    }
    if (skipping) continue;

    const timing = TIMING.exec(rawLine);
    if (timing !== null) {
      pendingAt = normalizeTimestamp(timing[1]);
      continue;
    }
    if (isNoise(rawLine)) continue;

    // Inline tags (<i>, <c.colorE5E5E5>, <00:00:02.000>) are styling and
    // karaoke timing — they are not content and must not reach the body.
    const cleaned = rawLine.replace(/<(?!v\s)[^>]*>/g, '').trim();
    if (cleaned === '') continue;

    const { speaker, text } = splitSpeaker(cleaned);
    if (text === '') continue;

    const last = turns[turns.length - 1];
    // A continuation cue carries no speaker of its own, so an unattributed
    // line after a named one belongs to that speaker.
    const owner = speaker ?? last?.speaker ?? null;
    if (last !== undefined && last.speaker === owner) {
      last.text = `${last.text} ${text}`;
      pendingAt = null;
      continue;
    }
    turns.push({ speaker: owner, at: pendingAt, text });
    pendingAt = null;
  }

  return turns;
}

export function speakersOf(turns: Turn[]): string[] {
  const seen: string[] = [];
  for (const turn of turns) {
    if (turn.speaker !== null && !seen.includes(turn.speaker)) seen.push(turn.speaker);
  }
  return seen;
}

/**
 * Turns → markdown. Timestamps are kept because tracing a claim back to the
 * moment it was said is the same provenance question the knowledge bundle
 * asks of every concept; dropping them would make a distilled claim
 * uncheckable against its own source.
 */
export function turnsToMarkdown(turns: Turn[]): string {
  return turns
    .map((turn) => {
      const stamp = turn.at === null ? '' : `\`${turn.at}\` `;
      const who = turn.speaker === null ? '' : `**${turn.speaker}:** `;
      return `${stamp}${who}${turn.text}`;
    })
    .join('\n\n');
}

// --- Titles ----------------------------------------------------------------

const TITLE_STOPWORDS = /^(transcript|recording|meeting|copy of|audio|video)[\s-]+/i;

/** `2026-07-28 Phoenix Standup (1).vtt` → `Phoenix Standup`. */
export function titleFromFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  let stem = dot === -1 ? filename : filename.slice(0, dot);
  stem = stem
    .replace(/[_]+/g, ' ')
    .replace(/\s*\(\d+\)\s*$/, '')
    // A leading or trailing ISO date is filing metadata, not part of the name.
    .replace(/^\d{4}-\d{2}-\d{2}[\s-]*/, '')
    .replace(/[\s-]*\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  stem = stem.replace(TITLE_STOPWORDS, '').trim();
  return stem;
}

/** First markdown H1, else the first non-empty line, capped to a sane length. */
export function titleFromContent(content: string): string {
  const h1 = /^#\s+(.+)$/m.exec(content);
  if (h1 !== null) return h1[1].trim();
  const first = content.split(/\r?\n/).find((l) => l.trim() !== '' && !isNoise(l));
  if (first === undefined) return '';
  const { text } = splitSpeaker(first.trim());
  const clean = text.replace(/^#+\s*/, '').trim();
  return clean.length > 72 ? `${clean.slice(0, 69).trimEnd()}…` : clean;
}

// --- The working doc -------------------------------------------------------

export interface WorkingDoc {
  title: string;
  /** Frontmatter, deliberately without `type` — that is what queues it. */
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface IngestInput {
  /** Original filename; '' for pasted text. */
  filename: string;
  content: string;
  /** ISO instant the material entered the vault. */
  at: string;
}

/**
 * Normalize any inlet into one working doc.
 *
 * `source_file` and `ingested_at` are the provenance a distilled concept will
 * cite, so they are recorded even when the material is a paste with no file
 * behind it — "pasted on this date" is still an answer to where it came from.
 *
 * `source_sha256` is the material's identity (M64.7): a SHA-256 of the text
 * as decoded, on every inlet, files and pastes alike. A repeat is matched by
 * it (`filedCopyOf`), never by filename or title, which a rename changes.
 *
 * A transcript always records its `speakers`: the labels it names, or `[]`
 * when it names nobody. Only a capture made before M64.7 lacks the key, and
 * that reads as not recorded (engine/transcripts.ts), never as nobody.
 */
export function toWorkingDoc({ filename, content, at }: IngestInput): WorkingDoc {
  const format = detectFormat(filename, content);
  const transcript = format === 'vtt' || format === 'srt';

  const turns = transcript ? parseTranscript(content) : [];
  const body = transcript ? turnsToMarkdown(turns) : content.trim();

  const title =
    (filename === '' ? '' : titleFromFilename(filename)) ||
    titleFromContent(transcript ? turnsToMarkdown(turns) : content) ||
    'Untitled capture';

  const frontmatter: Record<string, unknown> = {
    title,
    ingested_at: at,
    ingest_format: format,
    source_sha256: sha256Hex(content),
  };
  if (filename !== '') frontmatter.source_file = filename;

  if (transcript) {
    frontmatter.speakers = speakersOf(turns);
    const last = [...turns].reverse().find((t) => t.at !== null);
    if (last?.at != null) frontmatter.duration = last.at;
  }

  // The H1 is written into the body so the note reads as titled everywhere,
  // including surfaces that take their title from the body rather than
  // frontmatter (engine/types.ts: first H1, else humanized filename).
  return { title, frontmatter, body: `# ${title}\n\n${body}\n` };
}

/**
 * The page already filed from the same material (M64.7): the first entry, in
 * path order, whose `source_sha256` equals `sha`, or null. Any folder counts,
 * since a filed capture moves out of inbox/, except the knowledge bundle,
 * which is agent-written and is never what a person filed.
 */
export function filedCopyOf<T extends Pick<Entry, 'path' | 'properties'>>(
  entries: readonly T[],
  sha: string,
): T | null {
  let found: T | null = null;
  for (const entry of entries) {
    if (entry.properties.source_sha256 !== sha || isKnowledgePath(entry.path)) continue;
    if (found === null || entry.path < found.path) found = entry;
  }
  return found;
}

// --- External references (the connector inlet) -----------------------------

export interface ExternalRef {
  kind: 'issue' | 'url';
  /** What to fetch: an issue key (`PHX-421`) or a URL. */
  id: string;
  /** Where a new copy lands (`sourceCachePath`). A copy fetched earlier may
   * live elsewhere under SOURCES_DIR; `uncachedRefs` finds it by `source_id`. */
  cachePath: string;
}

/** Cached copies of fetched external material. A sibling of `knowledge/`:
 * both are machine-written, but this one is raw input, not distilled. */
export const SOURCES_DIR = 'sources';

/**
 * What one cached copy's freshness IS (M34.5.2) — the fact the vault has
 * held since `cache_source` first stamped it, said out loud for the first
 * time. Derived from the fetch bookkeeping PROPERTIES, never from `type:
 * Source` — behavior is capability-gated (AGENTS.md), and a record carrying
 * `fetched_at`/`stale_after` is a cached copy wherever it lives.
 *
 * The honesty rules are the point:
 * - An absent `stale_after` is NOT fresh. It is `no-expiry`: nobody said
 *   this copy expires, and the Source Monitor's own header forbids
 *   inventing a default refresh schedule.
 * - An absent `fetched_at` is `null`, never an epoch or a blank — "fetch
 *   not recorded" is a sentence the surface has to say.
 * - Stale means `stale_after <= today`, compared as local date words: a
 *   copy is due ON its date, not after it. No background job re-fetches a
 *   due copy since M54.9 (engine/jobs.ts).
 */
export interface SourceFreshness {
  state: 'stale' | 'fresh' | 'no-expiry';
  /** The declared refresh date. Present for stale and fresh; absent means
   * nobody set one, which is what `no-expiry` says. */
  staleAfter?: string;
  /** ISO of the last fetch. `null` is NOT RECORDED — never zero. */
  fetchedAt: string | null;
}

/** Null for every record without fetch bookkeeping — the detail panel
 * self-gates on this rather than on a type name. */
export function sourceFreshness(entry: Entry, today: string): SourceFreshness | null {
  const stale = entry.properties.stale_after;
  const fetched = entry.properties.fetched_at;
  const staleAfter = typeof stale === 'string' && stale !== '' ? stale : null;
  const fetchedAt = typeof fetched === 'string' && fetched !== '' ? fetched : null;
  if (staleAfter === null && fetchedAt === null) return null;
  if (staleAfter === null) return { state: 'no-expiry', fetchedAt };
  return {
    state: staleAfter <= today ? 'stale' : 'fresh',
    staleAfter,
    fetchedAt,
  };
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>()[\]"']+/g;

/**
 * Issue keys cannot be recognised by shape, only declared.
 *
 * `PHX-421` and `UTF-8` are the same pattern: a short uppercase run, a
 * hyphen, digits. So are `COVID-19` and `ISO-8601`. Any regex broad enough to
 * catch your project keys also catches those, and the cost of a false
 * positive is not cosmetic — it is the agent opening a connector, spending a
 * round trip, and writing a cache file for a ticket that never existed.
 *
 * The project keys are something the user knows and the tool does not, so
 * they are configuration (Settings → Assistant → issue keys). With none
 * declared, no issue is ever detected — a quiet miss, which is the right
 * failure for something whose false positives cost API calls.
 */
function issuePattern(prefixes: readonly string[]): RegExp | null {
  const clean = prefixes
    .map((p) => p.trim().toUpperCase())
    .filter((p) => /^[A-Z][A-Z0-9]{0,9}$/.test(p));
  if (clean.length === 0) return null;
  return new RegExp(String.raw`\b(?:${clean.join('|')})-\d{1,6}\b`, 'g');
}

export interface RefOptions {
  /** Declared issue-tracker project keys, e.g. `['PHX', 'SYN']`. */
  issuePrefixes?: readonly string[];
}

/** `"phx, SYN, "` → `['PHX', 'SYN']`. What Settings stores is one string;
 * everything downstream wants the list, so the split lives in one place. */
export function parseIssuePrefixes(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const key = part.trim().toUpperCase();
    if (/^[A-Z][A-Z0-9]{0,9}$/.test(key)) seen.add(key);
  }
  return [...seen];
}

/** What a cached copy is a copy of: the `kind` `cache_source` takes and
 * stamps as `source_kind`. */
export type SourceKind = 'issue' | 'web';

const SOURCE_KINDS: readonly SourceKind[] = ['issue', 'web'];

const sourceKindOf = (kind: ExternalRef['kind']): SourceKind =>
  kind === 'issue' ? 'issue' : 'web';

/** One source, as a key: its kind and its canonical id. */
const identityOf = (kind: SourceKind, canonical: string): string => `${kind}\0${canonical}`;

/** How much of its URL a web copy's file name keeps, for a person to read. */
const READABLE_MAX = 64;
/** Hex characters of the identity hash a web copy's file name ends in: what
 * keeps two sources that read alike in two files. */
const SUFFIX_HEX = 12;

const lowerAscii = (text: string): string => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

/**
 * What a fetched source IS, however a note spells it (INTEGRATIONS-2a). The id
 * is trimmed of ASCII whitespace. An issue key is lowercased. A URL loses one
 * leading `https://` or `http://` in any case, its host (everything before the
 * first `/`, `?` or `#`) is ASCII-lowercased, and trailing `/` go. Path case,
 * query and fragment stay: each can name a different page.
 *
 * Twin of `canonical_source_id` in src-tauri/src/mcp.rs, which picks the file
 * `cache_source` writes. Both replay src-tauri/fixtures/source-slugs.json.
 */
export function canonicalSourceId(kind: SourceKind, id: string): string {
  const trimmed = id.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  if (kind === 'issue') return trimmed.toLowerCase();
  const scheme = ['https://', 'http://'].find(
    (prefix) => lowerAscii(trimmed.slice(0, prefix.length)) === prefix,
  );
  const rest = scheme === undefined ? trimmed : trimmed.slice(scheme.length);
  const hostEnd = rest.search(/[/?#]/);
  const cut = hostEnd === -1 ? rest.length : hostEnd;
  return (lowerAscii(rest.slice(0, cut)) + rest.slice(cut)).replace(/\/+$/, '');
}

function cachePathOf(kind: SourceKind, canonical: string): string {
  if (kind === 'issue') return `${SOURCES_DIR}/issues/${canonical}.md`;
  const readable = canonical
    .replace(/[^A-Za-z0-9._-]/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/-+$/, '')
    .toLowerCase()
    .slice(0, READABLE_MAX)
    .replace(/-+$/, '');
  const suffix = sha256Hex(`cerebro-source-cache-v1\0web\0${canonical}`).slice(0, SUFFIX_HEX);
  return `${SOURCES_DIR}/web/${readable === '' ? suffix : `${readable}-${suffix}`}.md`;
}

/**
 * Where a NEW copy of a source lands. An issue at `issues/<canonical>.md`, as
 * since M8.2. A web page at `web/<readable>-<suffix>.md`: the readable half is
 * the canonical id with every character outside `[A-Za-z0-9._-]` turned into
 * `-` (ASCII on purpose: no Unicode class means the same thing in both twins),
 * runs of `-` collapsed, no leading `-` or `.` (no dotfile) and no trailing
 * `-`, lowercased, cut at READABLE_MAX; the suffix is the first SUFFIX_HEX hex
 * characters of a sha256 over the canonical id. With nothing readable left,
 * the suffix alone names the file.
 *
 * Twin of `source_slug` in src-tauri/src/mcp.rs. Both replay
 * src-tauri/fixtures/source-slugs.json.
 */
export function sourceCachePath(kind: SourceKind, id: string): string {
  return cachePathOf(kind, canonicalSourceId(kind, id));
}

/**
 * External references in a note, one per source however it is spelled. The
 * first spelling stands for the source: it is the one a fetch asks for.
 *
 * This is the trigger for the connector inlet: rather than syncing Jira or
 * Confluence on a schedule, the agent reaches for them exactly when a note
 * mentions something it cannot read, and writes the result down so the next
 * turn reads a local file instead of calling the API again.
 */
export function findExternalRefs(text: string, options: RefOptions = {}): ExternalRef[] {
  const refs = new Map<string, ExternalRef>();
  const add = (kind: ExternalRef['kind'], id: string) => {
    const source = sourceKindOf(kind);
    const canonical = canonicalSourceId(source, id);
    // `https://` with nothing after it is nothing `cache_source` would write.
    if (canonical === '') return;
    const key = identityOf(source, canonical);
    if (!refs.has(key)) refs.set(key, { kind, id, cachePath: cachePathOf(source, canonical) });
  };
  const issues = issuePattern(options.issuePrefixes ?? []);
  if (issues !== null) {
    for (const match of text.matchAll(issues)) add('issue', match[0]);
  }
  for (const match of text.matchAll(URL_PATTERN)) {
    // Trailing punctuation belongs to the sentence, not the URL.
    add('url', match[0].replace(/[.,;:!?)\]]+$/, ''));
  }
  return [...refs.values()];
}

/**
 * The subset of refs with nothing cached — what is actually worth a fetch.
 *
 * A copy counts when it sits at the ref's `cachePath`, or anywhere under
 * SOURCES_DIR when its `source_id` names the same source: the same canonical
 * id, and a `source_kind` that agrees or was never recorded. The second half
 * finds a copy written under an older path rule, which `cache_source` then
 * refreshes where it lives. A note elsewhere that merely carries a
 * `source_id` is not a cached copy.
 */
export function uncachedRefs(
  text: string,
  entries: readonly Pick<Entry, 'path' | 'properties'>[],
  options: RefOptions = {},
): ExternalRef[] {
  const paths = new Set(entries.map((entry) => entry.path));
  const held = new Set<string>();
  for (const { path, properties } of entries) {
    if (!path.startsWith(`${SOURCES_DIR}/`) || !path.endsWith('.md')) continue;
    const id = properties.source_id;
    if (typeof id !== 'string') continue;
    const declared = properties.source_kind;
    for (const kind of SOURCE_KINDS) {
      if (declared === undefined || declared === null || declared === kind) {
        held.add(identityOf(kind, canonicalSourceId(kind, id)));
      }
    }
  }
  return findExternalRefs(text, options).filter((ref) => {
    const kind = sourceKindOf(ref.kind);
    return (
      !paths.has(ref.cachePath) && !held.has(identityOf(kind, canonicalSourceId(kind, ref.id)))
    );
  });
}
