import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HighlightedTextarea } from './HighlightedTextarea';

vi.mock('./highlight', () => ({
  loadMermaidHighlighter: vi.fn(),
}));
import { loadMermaidHighlighter } from './highlight';
const loadMock = vi.mocked(loadMermaidHighlighter);

describe('HighlightedTextarea', () => {
  it('is a working textarea even when no highlighter exists', async () => {
    loadMock.mockResolvedValue(null);
    const onChange = vi.fn();
    render(
      <HighlightedTextarea value="" onChange={onChange} ariaLabel="Mermaid source" rows={4} />,
    );
    await userEvent.type(screen.getByLabelText('Mermaid source'), 'g');
    expect(onChange).toHaveBeenCalledWith('g');
  });

  it('renders the highlight layer when the highlighter loads', async () => {
    loadMock.mockResolvedValue((code) => `<pre class="shiki">${code}</pre>`);
    render(
      <HighlightedTextarea
        value="graph TD"
        onChange={() => {}}
        ariaLabel="Mermaid source"
        rows={4}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-highlight-layer').innerHTML).toContain('shiki'),
    );
  });

  it('repaints the highlight layer when the theme flips', async () => {
    const originalTheme = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', 'light');
    loadMock.mockResolvedValue(
      (code) =>
        `<pre class="theme-${document.documentElement.getAttribute('data-theme')}">${code}</pre>`,
    );
    render(
      <HighlightedTextarea
        value="graph TD"
        onChange={() => {}}
        ariaLabel="Mermaid source"
        rows={4}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-highlight-layer').innerHTML).toContain('theme-light'),
    );

    document.documentElement.setAttribute('data-theme', 'dark');

    await waitFor(() =>
      expect(screen.getByTestId('mermaid-highlight-layer').innerHTML).toContain('theme-dark'),
    );

    if (originalTheme === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', originalTheme);
  });
});
