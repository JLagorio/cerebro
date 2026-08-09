import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '@/stores/uiStore';
import { MermaidLightbox } from './MermaidLightbox';

vi.mock('./export', () => ({
  copySvg: vi.fn().mockResolvedValue(undefined),
  copyPng: vi.fn().mockResolvedValue(undefined),
  savePng: vi.fn().mockResolvedValue('/tmp/x.png'),
}));

import { copySvg, savePng } from './export';

describe('MermaidLightbox', () => {
  const svg = '<svg data-fake="z"></svg>';

  beforeEach(() => {
    useUiStore.setState({ toasts: [] });
  });

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

  it('toasts a specific failure when copy SVG rejects', async () => {
    vi.mocked(copySvg).mockRejectedValueOnce(new Error('denied'));
    render(<MermaidLightbox open svg={svg} title="Diagram" onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
    await waitFor(() => expect(useUiStore.getState().toasts.length).toBe(1));
    expect(useUiStore.getState().toasts[0].message).toBe('Copy SVG failed');
  });

  it('does not toast success when save PNG resolves null (cancelled)', async () => {
    vi.mocked(savePng).mockResolvedValueOnce(null);
    render(<MermaidLightbox open svg={svg} title="Diagram" onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save PNG…' }));
    // Give the resolved promise's .then a turn to run, then confirm nothing toasted.
    await waitFor(() => expect(vi.mocked(savePng)).toHaveBeenCalled());
    expect(useUiStore.getState().toasts).toEqual([]);
  });
});
