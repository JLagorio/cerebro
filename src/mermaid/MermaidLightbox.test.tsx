import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MermaidLightbox } from './MermaidLightbox';

vi.mock('./export', () => ({
  copySvg: vi.fn().mockResolvedValue(undefined),
  copyPng: vi.fn().mockResolvedValue(undefined),
  savePng: vi.fn().mockResolvedValue('/tmp/x.png'),
}));

import { copySvg } from './export';

describe('MermaidLightbox', () => {
  const svg = '<svg data-fake="z"></svg>';

  it('renders the svg and a 100% zoom readout', () => {
    render(<MermaidLightbox open svg={svg} title="Diagram" onClose={() => {}} />);
    expect(screen.getByTestId('lightbox-canvas').innerHTML).toContain('data-fake="z"');
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toContain('100%');
  });

  it('zoom buttons change the scale readout', async () => {
    render(<MermaidLightbox open svg={svg} title="Diagram" onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toContain('110%');
    await userEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toContain('100%');
  });

  it('wheel zooms the canvas', () => {
    render(<MermaidLightbox open svg={svg} title="Diagram" onClose={() => {}} />);
    fireEvent.wheel(screen.getByTestId('lightbox-viewport'), { deltaY: -1 });
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toContain('110%');
  });

  it('copy SVG goes through the export module', async () => {
    render(<MermaidLightbox open svg={svg} title="Diagram" onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
    expect(vi.mocked(copySvg)).toHaveBeenCalledWith(svg);
  });
});
