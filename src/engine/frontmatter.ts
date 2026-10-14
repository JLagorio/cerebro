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
