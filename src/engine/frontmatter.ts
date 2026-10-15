import { stringify } from 'yaml';

/** Compose a new note from data, never by interpolating YAML scalars (M61.5). */
export function composeNote(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter)}---\n\n${body}`;
}

/**
 * The frontmatter split and the fallback title (M53.20): the two parser rules
 * the app shares with the mock backend's parser. They moved here from
 * lib/mockParse.ts so app code reads them from the engine rather than from
 * the mock. Both mirror parse.rs, and the scan golden in conformance/scan
 * holds them to it through the mock's parser.
 */

/** 'meeting-notes' -> 'Meeting notes' (parity with `humanize_stem` in parse.rs). */
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

/**
 * Index (into `body.split('\n')`) of the line the parser reads the title
 * from: the first H1 (`# ...`) line with non-empty text, skipping lines
 * inside ``` fenced code blocks and indented code lines (>= 4 leading
 * spaces; up to 3 are allowed). -1 when the body has no real H1. Parity
 * with `first_h1_line_start` in parse.rs; shared with title writes so reading
 * and rewriting the title always agree on which line is the H1. Rust's
 * conformance/scan/entries.json holds the title parity (frontmatter.test.ts).
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

/** Replace only the parser's H1 line, or prepend one when absent (M60.11).
 * Mirrors vault/write.rs `replace_h1`: every other byte, including CRLF
 * terminators, stays. A final bare CR is part of the replaced line. */
export function replaceH1(body: string, title: string): string {
  const at = firstH1LineIndex(body);
  if (at < 0) return `# ${title}\n\n${body}`;
  const lines = body.split('\n');
  const cr = at < lines.length - 1 && lines[at].endsWith('\r') ? '\r' : '';
  lines[at] = `# ${title}${cr}`;
  return lines.join('\n');
}
