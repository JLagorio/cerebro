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
});
