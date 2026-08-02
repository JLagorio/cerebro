import { describe, expect, it } from 'vitest';
import { extractWikilinks, humanize, parseNote, splitFrontmatter } from './mockParse';

// CROSS-LANGUAGE PARITY FIXTURES
// These three fixture strings are also asserted by the Rust parser tests in
// src-tauri/src/vault/entry.rs (Task 4). If a fixture or an expected value
// changes here it must change there too: the mock parser and the Rust scanner
// must produce the same Entry for the same file content.

const FIXTURE_ITEM = `---
type: Work item
key: FLD-7
status: progress
priority: urgent
project: "[[guided-onboarding-ga]]"
---

# Checklist stalls on step 3 offline

Steps to reproduce the stall, see [[offline-sync-hardening]].
`;

const FIXTURE_BAD_YAML = `---
type: [unclosed
status: todo
---

# Broken note
`;

const FIXTURE_PLAIN = `Just a plain paragraph that links to [[field-platform]].
`;

const T = '2026-07-24T00:00:00.000Z';

describe('parseNote parity fixtures', () => {
  it('parses frontmatter, title, relationships and body links (fixture 1)', () => {
    const e = parseNote('items/fld-7.md', FIXTURE_ITEM, T, T);
    expect(e.path).toBe('items/fld-7.md');
    expect(e.filename).toBe('fld-7.md');
    expect(e.title).toBe('Checklist stalls on step 3 offline');
    expect(e.type).toBe('Work item');
    expect(e.properties.key).toBe('FLD-7');
    expect(e.properties.status).toBe('progress');
    expect(e.properties.priority).toBe('urgent');
    expect(e.properties).not.toHaveProperty('project');
    expect(e.relationships.project).toEqual(['guided-onboarding-ga']);
    expect(e.outgoingLinks).toEqual(['offline-sync-hardening']);
    expect(e.snippet).toBe('Steps to reproduce the stall, see offline-sync-hardening.');
    expect(e.parseError).toBeNull();
  });

  it('keeps a malformed-YAML file as an entry with parseError set (fixture 2)', () => {
    const e = parseNote('items/broken.md', FIXTURE_BAD_YAML, T, T);
    expect(e.parseError).not.toBeNull();
    expect(e.properties).toEqual({});
    expect(e.relationships).toEqual({});
    expect(e.type).toBeNull();
    expect(e.title).toBe('Broken note');
  });

  it('handles no frontmatter and no H1 (fixture 3)', () => {
    const e = parseNote('notes/meeting-notes.md', FIXTURE_PLAIN, T, T);
    expect(e.title).toBe('Meeting notes');
    expect(e.type).toBeNull();
    expect(e.properties).toEqual({});
    expect(e.outgoingLinks).toEqual(['field-platform']);
    expect(e.snippet).toBe('Just a plain paragraph that links to field-platform.');
    expect(e.parseError).toBeNull();
  });
});

describe('helpers', () => {
  it('extractWikilinks pulls targets from strings and string arrays', () => {
    expect(extractWikilinks('[[a]]')).toEqual(['a']);
    expect(extractWikilinks('before [[a]] and [[b]]')).toEqual(['a', 'b']);
    expect(extractWikilinks(['[[a]]', '[[b]]'])).toEqual(['a', 'b']);
    expect(extractWikilinks('plain text')).toBeNull();
    expect(extractWikilinks(7)).toBeNull();
    expect(extractWikilinks(null)).toBeNull();
  });

  it('humanize turns a filename stem into a title', () => {
    expect(humanize('fld-7')).toBe('Fld 7');
    expect(humanize('meeting-notes')).toBe('Meeting notes');
  });

  it('splitFrontmatter returns null yaml when there is no fence', () => {
    expect(splitFrontmatter('hello')).toEqual({ yaml: null, body: 'hello' });
  });
});

// POST-PLAN PARITY ADDITIONS
// Everything below mirrors Rust parser behavior that landed after the plan was
// written (parser hardening in commit 8db3664 plus Task 4 implementation
// details in src-tauri/src/vault/parse.rs / entry.rs). These tests are not in
// the plan's Task 10 spec; they pin the mock parser to the current parse.rs.

describe('post-plan parity: fence-aware titles', () => {
  it('takes the first H1 anywhere in the body', () => {
    expect(parseNote('a.md', 'intro\n\n# Later heading\n', T, T).title).toBe('Later heading');
  });

  it('ignores H1-looking lines inside ``` code fences', () => {
    const body = 'intro\n\n```bash\n# a comment in code\necho hi\n```\n\n# Real title\n';
    expect(parseNote('a.md', body, T, T).title).toBe('Real title');
    // A fence-only body with no real H1 falls back to the humanized stem.
    expect(parseNote('only-code.md', '```\n# only in code\n```\n', T, T).title).toBe('Only code');
  });

  it('ignores indented code lines (>= 4 leading spaces)', () => {
    const body = 'intro\n\n    # indented code comment\n\n# Real title\n';
    expect(parseNote('a.md', body, T, T).title).toBe('Real title');
    expect(parseNote('indented.md', '    # only indented code\n', T, T).title).toBe('Indented');
  });
});

describe('post-plan parity: frontmatter fences', () => {
  it('strips a leading BOM before fence detection', () => {
    const e = parseNote('a.md', '\ufeff---\ntype: Work item\n---\nBody.\n', T, T);
    expect(e.type).toBe('Work item');
    expect(e.snippet).toBe('Body.');
    expect(e.parseError).toBeNull();
    expect(splitFrontmatter('\ufeffhello')).toEqual({ yaml: null, body: 'hello' });
  });

  it('tolerates CRLF line endings, including empty frontmatter', () => {
    const content =
      '---\r\ntype: Work item\r\nstatus: todo\r\n---\r\n\r\n# CRLF title\r\n\r\nBody line with [[atlas]].\r\n';
    const e = parseNote('items/crlf.md', content, T, T);
    expect(e.type).toBe('Work item');
    expect(e.properties.status).toBe('todo');
    expect(e.title).toBe('CRLF title');
    expect(e.outgoingLinks).toEqual(['atlas']);
    expect(e.parseError).toBeNull();
    // Empty CRLF frontmatter fast path.
    expect(splitFrontmatter('---\r\n---\r\n# Title\r\n')).toEqual({
      yaml: '',
      body: '# Title\r\n',
    });
  });

  it('allows trailing spaces or tabs on the closing --- fence', () => {
    expect(splitFrontmatter('---\ntype: Work item\n--- \nBody.\n')).toEqual({
      yaml: 'type: Work item',
      body: 'Body.\n',
    });
    expect(splitFrontmatter('---\ntype: Work item\n---\t\nBody.\n')).toEqual({
      yaml: 'type: Work item',
      body: 'Body.\n',
    });
  });

  it('rejects frontmatter over 64 KB with parseError instead of parsing', () => {
    const raw = `---\nkey: ${'x'.repeat(65 * 1024)}\n---\n\n# Big\n`;
    const e = parseNote('big.md', raw, T, T);
    expect(e.parseError).toMatch(/frontmatter too large/);
    expect(e.properties).toEqual({});
    expect(e.title).toBe('Big');
  });

  it('caps frontmatter at the same byte boundary as Rust (block incl. trailing newline)', () => {
    // Rust measures the raw block INCLUDING the trailing newline that
    // splitFrontmatter strips: 'key: ' (5) + N x's + '\n' (1) = N + 6 bytes.
    const over = `---\nkey: ${'x'.repeat(65531)}\n---\n\n# Big\n`; // 65537-byte block
    const eOver = parseNote('big.md', over, T, T);
    expect(eOver.parseError).toBe('frontmatter too large (65537 bytes, max 65536)');
    const at = `---\nkey: ${'x'.repeat(65530)}\n---\n\n# Ok\n`; // exactly 65536 → parses
    expect(parseNote('ok.md', at, T, T).parseError).toBeNull();
  });

  it('sets parseError for non-mapping frontmatter', () => {
    const e = parseNote('list.md', '---\n- just\n- a list\n---\n\n# List front\n', T, T);
    expect(e.parseError).toBe('frontmatter is not a mapping');
    expect(e.properties).toEqual({});
  });
});

describe('post-plan parity: snippets and links', () => {
  it('excludes fenced code content from the snippet', () => {
    const body = 'intro\n\n```\n# comment in code\ncode line\n```\n\noutro\n';
    expect(parseNote('a.md', body, T, T).snippet).toBe('intro outro');
  });

  it('drops lines that are empty after markdown stripping (no double spaces)', () => {
    expect(parseNote('a.md', 'alpha\n***\nbeta\n', T, T).snippet).toBe('alpha beta');
  });

  it('strips list markers and skips --- thematic breaks in the snippet', () => {
    expect(parseNote('a.md', '- item one\n\n---\n\n- item two\n', T, T).snippet).toBe(
      'item one item two',
    );
  });

  it('uses display text for piped wikilinks in the snippet, target elsewhere', () => {
    const body = '# Heading\n\nSome **bold** text with a [[target|nice link]].\n';
    const e = parseNote('a.md', body, T, T);
    expect(e.snippet).toBe('Some bold text with a nice link.');
    expect(e.outgoingLinks).toEqual(['target']);
    expect(extractWikilinks('[[maya-chen|Maya]]')).toEqual(['maya-chen']);
  });

  it('truncates the snippet to 160 characters', () => {
    const e = parseNote('a.md', `# H\n\n${'x'.repeat(400)}`, T, T);
    expect(e.snippet.length).toBe(160);
  });

  it('dedupes outgoing links preserving first-seen order', () => {
    const e = parseNote('a.md', 'Link [[b]] then [[a]] then [[b]] again.', T, T);
    expect(e.outgoingLinks).toEqual(['b', 'a']);
  });
});
