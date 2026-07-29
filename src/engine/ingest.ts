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
  if (/^﻿?WEBVTT/.test(content)) return 'vtt';
  // SRT has no header, so it is recognised by its first cue: an index line
  // followed by a comma-decimal timing line.
  if (/^﻿?\s*\d+\s*\r?\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(content)) return 'srt';
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
const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'di', 'da', 'du', 'la', 'le', 'bin', 'ibn', 'al']);

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
    (word, i) =>
      /^[\p{Lu}\p{N}]/u.test(word) || (i > 0 && PARTICLES.has(word.toLowerCase())),
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
  /^﻿?WEBVTT/.test(line) ||
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
  };
  if (filename !== '') frontmatter.source_file = filename;

  if (transcript) {
    const speakers = speakersOf(turns);
    if (speakers.length > 0) frontmatter.speakers = speakers;
    const last = [...turns].reverse().find((t) => t.at !== null);
    if (last?.at != null) frontmatter.duration = last.at;
  }

  // The H1 is written into the body so the note reads as titled everywhere,
  // including surfaces that take their title from the body rather than
  // frontmatter (engine/types.ts: first H1, else humanized filename).
  return { title, frontmatter, body: `# ${title}\n\n${body}\n` };
}

// --- External references (the connector inlet) -----------------------------

export interface ExternalRef {
  kind: 'issue' | 'url';
  /** What to fetch: an issue key (`PHX-421`) or a URL. */
  id: string;
  /** Where a fetched copy is cached — see SOURCES_DIR. */
  cachePath: string;
}

/** Cached copies of fetched external material. A sibling of `knowledge/`:
 * both are machine-written, but this one is raw input, not distilled. */
export const SOURCES_DIR = 'sources';

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

const slugForUrl = (url: string): string =>
  url
    .replace(/^https?:\/\//, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .toLowerCase();

/**
 * External references in a note that have no cached copy yet.
 *
 * This is the trigger for the connector inlet: rather than syncing Jira or
 * Confluence on a schedule, the agent reaches for them exactly when a note
 * mentions something it cannot read, and writes the result down so the next
 * turn reads a local file instead of calling the API again.
 */
export function findExternalRefs(text: string, options: RefOptions = {}): ExternalRef[] {
  const refs = new Map<string, ExternalRef>();
  const issues = issuePattern(options.issuePrefixes ?? []);
  if (issues !== null) {
    for (const match of text.matchAll(issues)) {
      const id = match[0];
      refs.set(id, { kind: 'issue', id, cachePath: `${SOURCES_DIR}/issues/${id.toLowerCase()}.md` });
    }
  }
  for (const match of text.matchAll(URL_PATTERN)) {
    // Trailing punctuation belongs to the sentence, not the URL.
    const id = match[0].replace(/[.,;:!?)\]]+$/, '');
    refs.set(id, { kind: 'url', id, cachePath: `${SOURCES_DIR}/web/${slugForUrl(id)}.md` });
  }
  return [...refs.values()];
}

/** The subset of refs with nothing cached — what is actually worth a fetch. */
export function uncachedRefs(
  text: string,
  existingPaths: Iterable<string>,
  options: RefOptions = {},
): ExternalRef[] {
  const have = new Set(existingPaths);
  return findExternalRefs(text, options).filter((ref) => !have.has(ref.cachePath));
}
