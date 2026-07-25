// Minimal TS re-implementation of the Rust note parser, used ONLY by the mock
// IPC backend (browser dev, vitest, Playwright). The Rust scanner in
// src-tauri/src/vault/parse.rs is the source of truth inside Tauri.
//
// PARITY: the wikilink scanning, humanize rule, fence handling, and snippet
// rules below intentionally mirror parse.rs / entry.rs — including the
// post-plan hardening from commit 8db3664 (fence-aware H1 titles, BOM strip,
// CRLF tolerance, trailing whitespace on the closing fence, 64 KB frontmatter
// cap, fence-aware snippets). The shared fixtures in mockParse.test.ts are
// asserted by both implementations — keep them in sync.
import YAML from 'yaml';
import type { Entry, Scalar } from '@/engine/types';

/** Frontmatter blocks larger than this are rejected without parsing (parity
 * with MAX_FRONTMATTER_LEN in parse.rs). */
const MAX_FRONTMATTER_LEN = 64 * 1024;

/**
 * All wikilink targets in a string: `[[target]]` and `[[target|alias]]`.
 * Scanner (not a regex) for parity with `wikilink_targets` in parse.rs:
 * the target is the text before the first `|`, trimmed; empty targets and
 * targets containing brackets are rejected.
 */
function wikilinkTargets(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf('[[');
    if (start === -1) break;
    const innerStart = start + 2;
    const endRel = rest.indexOf(']]', innerStart);
    if (endRel === -1) break;
    const inner = rest.slice(innerStart, endRel);
    const target = (inner.split('|')[0] ?? '').trim();
    if (target !== '' && !target.includes('[') && !target.includes(']')) {
      out.push(target);
    }
    rest = rest.slice(endRel + 2);
  }
  return out;
}

/** Collect string content from a frontmatter value (strings and nested
 * arrays of strings — parity with `collect_targets` in entry.rs). */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
}

/** Wikilink targets from a frontmatter value; null when the value has none. */
export function extractWikilinks(value: unknown): string[] | null {
  const texts: string[] = [];
  collectStrings(value, texts);
  const targets = texts.flatMap(wikilinkTargets);
  return targets.length > 0 ? targets : null;
}

/** 'meeting-notes' -> 'Meeting notes' (parity with the Rust fallback title). */
export function humanize(stem: string): string {
  const spaced = stem.replace(/[-_]+/g, ' ').trim();
  return spaced === '' ? stem : spaced[0].toUpperCase() + spaced.slice(1);
}

/**
 * Split raw content into the frontmatter YAML block and the body, mirroring
 * `split_frontmatter` in parse.rs: a leading BOM is stripped, the opening
 * fence is `---` + LF/CRLF, the closing fence tolerates trailing spaces or
 * tabs, and an unterminated fence treats the whole file as body. The yaml
 * block is returned without the final newline of its last line.
 */
export function splitFrontmatter(raw: string): { yaml: string | null; body: string } {
  const content = raw.startsWith('\ufeff') ? raw.slice(1) : raw;
  let rest: string;
  if (content.startsWith('---\n')) rest = content.slice(4);
  else if (content.startsWith('---\r\n')) rest = content.slice(5);
  else return { yaml: null, body: content };
  // Fast path: closing fence immediately follows (empty frontmatter).
  const fastBody = closingFenceBody(rest);
  if (fastBody !== null) return { yaml: '', body: fastBody };
  let search = 0;
  for (;;) {
    const pos = rest.indexOf('\n---', search);
    if (pos === -1) break;
    const body = closingFenceBody(rest.slice(pos + 1));
    if (body !== null) {
      return { yaml: rest.slice(0, pos).replace(/\r$/, ''), body };
    }
    search = pos + 1;
  }
  return { yaml: null, body: content }; // unterminated fence: treat whole file as body
}

/** If `s` starts with a closing fence line — `---`, optional trailing spaces
 * or tabs, then a newline or end of input — return the body after it. */
function closingFenceBody(s: string): string | null {
  if (!s.startsWith('---')) return null;
  const trimmed = s.slice(3).replace(/^[ \t]+/, '');
  if (trimmed === '') return trimmed;
  if (trimmed.startsWith('\r\n')) return trimmed.slice(2);
  if (trimmed.startsWith('\n')) return trimmed.slice(1);
  return null;
}

/** Parse a frontmatter block into a mapping, mirroring `parse_frontmatter`
 * in parse.rs (empty → {}, oversized / malformed / non-mapping → error). */
function parseFrontmatterBlock(block: string): {
  mapping: Record<string, unknown>;
  error: string | null;
} {
  if (block.trim() === '') return { mapping: {}, error: null };
  // Parity with parse.rs: the Rust cap measures the raw block INCLUDING the
  // trailing newline that splitFrontmatter strips, so count it back in.
  const bytes = new TextEncoder().encode(block).length + 1;
  if (bytes > MAX_FRONTMATTER_LEN) {
    return {
      mapping: {},
      error: `frontmatter too large (${bytes} bytes, max ${MAX_FRONTMATTER_LEN})`,
    };
  }
  try {
    const parsed: unknown = YAML.parse(block);
    if (parsed === null) return { mapping: {}, error: null };
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { mapping: parsed as Record<string, unknown>, error: null };
    }
    return { mapping: {}, error: 'frontmatter is not a mapping' };
  } catch (err) {
    return { mapping: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Index (into `body.split('\n')`) of the line the parser reads the title
 * from: the first H1 (`# ...`) line with non-empty text, skipping lines
 * inside ``` fenced code blocks and indented code lines (>= 4 leading
 * spaces; up to 3 are allowed). -1 when the body has no real H1. Parity
 * with `first_h1_line_start` in parse.rs; shared with mockIpc.setNoteTitle
 * so reading and rewriting the title always agree on which line is the H1.
 */
export function firstH1LineIndex(body: string): number {
  let inFence = false;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.startsWith('    ')) continue;
    if (trimmed.startsWith('# ') && trimmed.slice(2).trim() !== '') return i;
  }
  return -1;
}

/**
 * Text of the first H1 (`# ...`) line anywhere in the body — parity with
 * `extract_h1_title` in parse.rs (fence/indent-aware via firstH1LineIndex).
 */
function extractH1Title(body: string): string | null {
  const index = firstH1LineIndex(body);
  if (index === -1) return null;
  const line = body.split('\n')[index];
  const noCr = line.endsWith('\r') ? line.slice(0, -1) : line;
  return noCr.trim().slice(2).trim();
}

/** Wikilink targets in the body, deduplicated preserving first-seen order
 * (parity with `extract_outgoing_links` in parse.rs). */
function extractOutgoingLinks(body: string): string[] {
  const seen = new Set<string>();
  return wikilinkTargets(body).filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
}

/** Strip list markers, emphasis chars, and unwrap wikilinks to display text
 * (parity with `strip_inline_markdown` in parse.rs). */
function stripInlineMarkdown(line: string): string {
  let rest = line.replace(/^[-*+>]+/, '').replace(/^\s+/, '');
  let out = '';
  for (;;) {
    const start = rest.indexOf('[[');
    if (start === -1) break;
    out += rest.slice(0, start);
    const innerStart = start + 2;
    const endRel = rest.indexOf(']]', innerStart);
    if (endRel === -1) {
      out += rest.slice(start);
      rest = '';
      break;
    }
    const inner = rest.slice(innerStart, endRel);
    const segments = inner.split('|');
    out += segments[segments.length - 1] ?? inner;
    rest = rest.slice(endRel + 2);
  }
  out += rest;
  return out.replace(/[*_`]/g, '');
}

/**
 * First 160 chars of the body with markdown roughly stripped. Content inside
 * ``` fenced code blocks is excluded, as are heading/`---` lines and lines
 * that are empty after stripping (e.g. `***` thematic breaks) — parity with
 * `extract_snippet` in parse.rs.
 */
function makeSnippet(body: string): string {
  let inFence = false;
  const parts: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === '' || line.startsWith('#') || line.startsWith('---')) continue;
    const stripped = stripInlineMarkdown(line);
    if (stripped.trim() !== '') parts.push(stripped);
  }
  return [...parts.join(' ').trim()].slice(0, 160).join('');
}

export function parseNote(path: string, raw: string, createdAt: string, modifiedAt: string): Entry {
  const filename = path.split('/').pop() ?? path;
  const stem = filename.replace(/\.md$/, '');
  const { yaml, body } = splitFrontmatter(raw);
  const { mapping, error: parseError } =
    yaml !== null ? parseFrontmatterBlock(yaml) : { mapping: {}, error: null };

  const properties: Record<string, Scalar | Scalar[]> = {};
  const relationships: Record<string, string[]> = {};
  let entryType: string | null = null;
  for (const [key, value] of Object.entries(mapping)) {
    if (key === 'type') {
      // Non-string `type` values are dropped entirely (parity with entry.rs).
      if (typeof value === 'string') entryType = value;
      continue;
    }
    const links = extractWikilinks(value);
    if (links !== null) {
      relationships[key] = links;
    } else {
      // Nested YAML (e.g. a space's `statuses` list) passes through unchanged
      // so the schema layer sees the same shape the Rust scanner produces
      // (serde_json::Value); the Scalar typing is advisory here.
      properties[key] = value as Scalar | Scalar[];
    }
  }

  const h1 = extractH1Title(body);
  return {
    path,
    filename,
    // Containment (`project`) is a whole-vault property — the scanner's
    // post-pass (assignProjects in mockIpc / scan.rs) fills it in.
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    project: null,
    title: h1 !== null ? h1 : humanize(stem),
    type: entryType,
    properties,
    relationships,
    outgoingLinks: extractOutgoingLinks(body),
    snippet: makeSnippet(body),
    createdAt,
    modifiedAt,
    parseError,
  };
}
