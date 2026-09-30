import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConceptBody } from './ConceptBody';

vi.mock('@/mermaid/render', () => ({
  renderMermaid: vi.fn().mockResolvedValue({ ok: true, svg: '<svg data-fake="k"></svg>' }),
}));

describe('ConceptBody', () => {
  it('renders mermaid fences as diagrams, other fences as code', async () => {
    const markdown = [
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');
    render(<ConceptBody markdown={markdown} sources={[]} fromPath="knowledge/x.md" />);
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-diagram').innerHTML).toContain('data-fake="k"'),
    );
    expect(screen.getByText('const x = 1;')).toBeTruthy();
  });

  // M33a.4 — the anchor syntax was the one thing on a concept page you could
  // not click, which made `about:` a field only the sidebar could read.
  it('renders a wikilink as a link on its raw target', () => {
    const opened: string[] = [];
    render(
      <ConceptBody
        markdown="See [[ims-7]] for scope."
        sources={[]}
        fromPath="knowledge/x.md"
        onOpenWikilink={(t) => opened.push(t)}
      />,
    );
    const link = screen.getByTestId('concept-wikilink');
    expect(link.textContent).toBe('ims-7');
    link.click();
    expect(opened).toEqual(['ims-7']);
  });

  it('shows a wikilink alias and still opens the target behind it', () => {
    const opened: string[] = [];
    render(
      <ConceptBody
        markdown="See [[gcs-5-client-architecture|the client]]."
        sources={[]}
        fromPath="knowledge/x.md"
        onOpenWikilink={(t) => opened.push(t)}
      />,
    );
    const link = screen.getByTestId('concept-wikilink');
    expect(link.textContent).toBe('the client');
    link.click();
    expect(opened).toEqual(['gcs-5-client-architecture']);
  });

  it('drops the brackets when nothing can follow the link', () => {
    render(<ConceptBody markdown="See [[ims-7]] for scope." sources={[]} fromPath="k/x.md" />);
    expect(screen.queryByTestId('concept-wikilink')).toBeNull();
    // The brackets are syntax, not content — a reader never has to read them.
    expect(screen.getByTestId('concept-body').textContent).toBe('See ims-7 for scope.');
  });

  // M52.3 — the knowledge agent's charter (demo-vault/records/agents/
  // knowledge.md): every step wraps, and each wrapped line used to end the
  // list, so four steps rendered as four lists, each numbered 1.
  it('keeps wrapped lines inside their item, so a numbered charter is one list', () => {
    const markdown = [
      'Maintain the knowledge bundle.',
      '',
      '1. Read what changed — records, docs, and the cached copies under `sources/`.',
      '   Check `knowledge_about` before writing anything: the bundle may already',
      '   hold a concept your finding refines, supersedes, or contradicts.',
      '2. Record findings with `write_concept`, anchored `about` the records they',
      '   describe and citing the material that shows them.',
      '3. When a cached source you rely on is past its `stale_after`, refresh it',
      '   through `cache_source` before re-reading conclusions from the old copy.',
      '4. Never mark anything verified. Verification is the human’s stamp.',
      '',
      '`scope: []` above is deliberate, not a mistake.',
    ].join('\n');
    const { container } = render(
      <ConceptBody markdown={markdown} sources={[]} fromPath="records/agents/knowledge.md" />,
    );
    const lists = container.querySelectorAll('ol');
    expect(lists).toHaveLength(1);
    const items = lists[0].querySelectorAll(':scope > li');
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toBe(
      'Read what changed — records, docs, and the cached copies under sources/. Check knowledge_about before writing anything: the bundle may already hold a concept your finding refines, supersedes, or contradicts.',
    );
    expect(items[2].textContent).toContain('refresh it through cache_source before');
    // The paragraph after the blank line is not the list's.
    const paragraphs = [...container.querySelectorAll('p')].map((p) => p.textContent);
    expect(paragraphs).toEqual([
      'Maintain the knowledge bundle.',
      'scope: [] above is deliberate, not a mistake.',
    ]);
  });

  it('carries a list across a blank line only when what follows still belongs to it', () => {
    const markdown = [
      '- first',
      '',
      '  still the first, after a blank line',
      '',
      '- second',
      '',
      'A paragraph ends it.',
      '',
      '3. starts at three',
      '4. then four',
      '',
      '- a bullet is another list',
    ].join('\n');
    const { container } = render(
      <ConceptBody markdown={markdown} sources={[]} fromPath="knowledge/x.md" />,
    );
    const bullets = container.querySelectorAll('ul');
    expect(bullets).toHaveLength(2);
    expect([...bullets[0].querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'first still the first, after a blank line',
      'second',
    ]);
    // The author's number survives: a list that starts at 3 says 3.
    const ordered = container.querySelector('ol');
    expect(ordered?.getAttribute('start')).toBe('3');
    expect(ordered?.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('p')?.textContent).toBe('A paragraph ends it.');
  });

  // M52.4 — an indented quote under an item is a quote, not more of the
  // item's text: it used to be folded in, `>` and all.
  it('renders an indented quote under an item as a quote', () => {
    const { container } = render(
      <ConceptBody markdown={'- item\n  > quoted'} sources={[]} fromPath="knowledge/x.md" />,
    );
    expect(container.querySelector('blockquote')?.textContent).toContain('quoted');
    const item = container.querySelector('li');
    expect(item?.textContent).toBe('item');
    expect(item?.textContent).not.toContain('>');
  });

  it('leaves markdown links and citations alone', () => {
    const opened: string[] = [];
    render(
      <ConceptBody
        markdown="A [doc](./other.md) and a cite[^s1] and [[ims-7]]."
        sources={[
          {
            id: 's1',
            resource: 'inbox/a.md',
            title: null,
            author: null,
            usageCount: null,
            lastModified: null,
            usageWindow: null,
          },
        ]}
        fromPath="knowledge/x.md"
        onOpenConcept={(p) => opened.push(p)}
        onOpenWikilink={(t) => opened.push(t)}
      />,
    );
    expect(screen.getByText('doc')).toBeTruthy();
    expect(screen.getByTestId('concept-wikilink').textContent).toBe('ims-7');
    // The citation still resolved to its source's 1-based index, not to `?`.
    expect(screen.getByText('1')).toBeTruthy();
  });
});
