import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import golden from '../../conformance/scan/entries.json';
import { firstH1LineIndex, humanize, replaceH1, splitFrontmatter } from './frontmatter';

describe('the H1 shared by reading and title writes (M60.11)', () => {
  it('selects and replaces the title lines held by the Rust scan golden', () => {
    const pages = [
      ...golden.demo_vault
        // Knowledge titles have their own frontmatter authority and are
        // deliberately outside the ordinary page-title write door.
        .filter((entry) => entry.path.endsWith('.md') && !entry.path.startsWith('knowledge/'))
        .map((entry) => ({
          path: entry.path,
          title: entry.title,
          content: readFileSync(join(__dirname, '../../demo-vault', entry.path), 'utf8'),
        })),
      ...golden.fixtures.map(({ path, content, entry }) => ({ path, content, title: entry.title })),
    ];
    expect(pages.length).toBeGreaterThan(100);
    for (const page of pages) {
      const { body } = splitFrontmatter(page.content);
      const index = firstH1LineIndex(body);
      if (index < 0) {
        expect(humanize(page.path.split('/').at(-1)!.replace(/\.md$/, ''))).toBe(page.title);
      } else {
        expect(body.split('\n')[index].trim().slice(2).trim(), page.path).toBe(page.title);
      }
      const replaced = replaceH1(body, 'Renamed title');
      const nextIndex = firstH1LineIndex(replaced);
      expect(nextIndex, page.path).toBe(index < 0 ? 0 : index);
      expect(replaced.split('\n')[nextIndex].trim(), page.path).toBe('# Renamed title');
    }
  });

  it('finds only a nonempty H1 outside backtick fences and indented code', () => {
    const body = '```md\n# Example\n```\n    # Indented\n# \n## Detail\n  # Real\n';
    expect(firstH1LineIndex(body)).toBe(6);
    expect(replaceH1(body, 'Next')).toBe(
      '```md\n# Example\n```\n    # Indented\n# \n## Detail\n# Next\n',
    );
  });

  it('keeps every other byte and the H1’s CRLF terminator', () => {
    const body = 'Before\r\n  # Old\r\n\r\nBody [[Old]]\r\n# Later\r\n';
    expect(replaceH1(body, 'Books: 2026')).toBe(
      'Before\r\n# Books: 2026\r\n\r\nBody [[Old]]\r\n# Later\r\n',
    );
  });

  it('prepends a heading and blank line when no H1 exists', () => {
    for (const body of ['', 'Body\n', '```\n# Example\n```\n', '    # Code\n']) {
      expect(firstH1LineIndex(body)).toBe(-1);
      expect(replaceH1(body, 'Next')).toBe(`# Next\n\n${body}`);
    }
  });

  it('does not add a newline to an existing final H1', () => {
    expect(replaceH1('# Old', 'Next')).toBe('# Next');
    expect(replaceH1('# Old\r', 'Next')).toBe('# Next');
  });
});
