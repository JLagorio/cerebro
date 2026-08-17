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
