// Minimal TS re-implementation of the Rust note parser. Only the mock IPC
// backend (mockIpc.ts: browser dev, vitest, Playwright) reads it, and lint
// keeps every other importer out (the mockParse rail in eslint.config.js). The
// Rust scanner in src-tauri/src/vault/parse.rs is the source of truth inside
// Tauri.
//
// PARITY: the wikilink scanning, title and snippet rules below intentionally
// mirror parse.rs / entry.rs — including the post-plan hardening from commit
// 8db3664 (fence-aware H1 titles, 64 KB frontmatter cap, fence-aware
// snippets). The frontmatter split (BOM strip, CRLF tolerance, trailing
// whitespace on the closing fence) and the humanize rule live in
// engine/frontmatter.ts, where the app reads them too. The scan golden in
// conformance/scan holds all of it to parse.rs: Rust writes the golden,
// scanGolden.test.ts replays it through this parser, and a divergence moves
// this side.
import YAML from 'yaml';
import { isWhiteboardPath } from '@/engine/fileKinds';
import { fileLinkTarget, fileRefsOf, readCanvas, searchTextOf } from '@/engine/scene/jsonCanvas';
import { CANVAS_FORMAT } from '@/engine/scene/format';
import { utf8Length } from '@/engine/scene/json';
import { firstH1LineIndex, humanize, splitFrontmatter } from '@/engine/frontmatter';
import { isKnowledgePath } from '@/engine/okf';
import type { Entry, Scalar } from '@/engine/types';
import { firstMeaningfulLine } from '@/mermaid/detect';
import { sha256Hex } from './sha256';

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
 * `**Wiki Home**` → `Wiki Home`, `[[target|alias]]` → `alias`: derived
 * titles never show inline markdown (M2.x docs polish). Only `*` and
 * backticks are stripped — underscores stay, they are common in literal
 * names. Parity with `strip_title_markdown` in parse.rs.
 */
function stripTitleMarkdown(raw: string): string {
  let out = '';
  let rest = raw;
  for (;;) {
    const start = rest.indexOf('[[');
    if (start === -1) break;
    out += rest.slice(0, start);
    const endRel = rest.indexOf(']]', start + 2);
    if (endRel === -1) {
      out += rest.slice(start);
      rest = '';
      break;
    }
    const inner = rest.slice(start + 2, endRel);
    const segments = inner.split('|');
    out += segments[segments.length - 1] ?? inner;
    rest = rest.slice(endRel + 2);
  }
  out += rest;
  return out.replace(/[*`]/g, '').trim();
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
  return stripTitleMarkdown(noCr.trim().slice(2).trim());
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

/** Canonical visible bytes are body, including a leading YAML-looking block. */
export function canonicalBodyFacts(path: string, body: string) {
  const filename = path.split('/').at(-1) ?? path;
  const display = body.replace(/^\uFEFF/, '');
  return {
    title: extractH1Title(display) ?? humanize(filename.replace(/\.md$/, '')),
    outgoingLinks: extractOutgoingLinks(display),
    snippet: makeSnippet(display),
  };
}

export function parseNote(path: string, raw: string, createdAt: string, modifiedAt: string): Entry {
  const filename = path.split('/').pop() ?? path;
  if (isWhiteboardPath(path)) {
    const tooLarge = utf8Length(raw) > CANVAS_FORMAT.limits.max_bytes;
    const read = readCanvas(raw);
    const text = read.ok ? searchTextOf(read.board) : '';
    return {
      path,
      filename,
      folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
      project: null,
      title: humanize(filename.slice(0, filename.lastIndexOf('.'))),
      type: null,
      properties: {},
      relationships: {},
      outgoingLinks: read.ok
        ? [
            ...new Set([
              ...extractOutgoingLinks(text),
              ...fileRefsOf(read.board).map(({ file, subpath }) => fileLinkTarget(file, subpath)),
            ]),
          ]
        : [],
      snippet: makeSnippet(text),
      createdAt,
      modifiedAt,
      parseError: read.ok ? null : `${tooLarge ? 'unreadable: ' : ''}${read.message}`,
      hash: tooLarge ? null : sha256Hex(raw),
    };
  }

  // M29.20: a .mmd file is RAW mermaid source — its `---` header is diagram
  // syntax, never note frontmatter (parity with the .mmd branch in entry.rs).
  // Title from the filename stem, snippet from the first meaningful line.
  if (path.endsWith('.mmd')) {
    return {
      path,
      filename,
      folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
      project: null,
      title: humanize(filename.replace(/\.mmd$/, '')),
      type: null,
      properties: {},
      relationships: {},
      outgoingLinks: [],
      snippet: [...firstMeaningfulLine(raw)].slice(0, 160).join(''),
      createdAt,
      modifiedAt,
      parseError: null,
      hash: sha256Hex(raw),
    };
  }
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

  // OKF (M50.1): a knowledge file's title is its frontmatter `title` —
  // parity with entry.rs.
  const okfTitle =
    isKnowledgePath(path) && typeof mapping.title === 'string' && mapping.title.trim() !== ''
      ? mapping.title.trim()
      : null;
  const h1 = okfTitle ?? extractH1Title(body);
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
    // The bytes' SHA-256, the identity a trigger compares (M55.2; parity
    // with entry.rs, held by the scan golden).
    hash: sha256Hex(raw),
  };
}
