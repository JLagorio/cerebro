import { navSeed } from '@/test/navSeed';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { StudioPage } from './StudioPage';
import { calculateSheets } from '@/lib/ipc';
import * as ipc from '@/lib/ipc';
import { resetSheetCache } from '@/sheet/useSheetWorkbook';

vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  calculateSheets: vi.fn(),
}));

const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

describe('StudioPage', () => {
  beforeEach(async () => {
    resetSheetCache();
    vi.mocked(calculateSheets).mockReset();
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    useNavStore.setState({
      selection: { kind: 'studio' },
      history: [navSeed({ kind: 'studio' })],
      historyIndex: 0,
    });
    useUiStore.setState({ aiPanelOpen: false, handoffs: [] });
  });
  afterEach(cleanup);

  it('starts empty with an explanation, and creating a prototype lands inside it', async () => {
    render(<StudioPage selection={{ kind: 'studio' }} />);
    expect(screen.getByText('Nothing on the bench')).toBeTruthy();

    fireEvent.click(screen.getByTestId('studio-new'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Prototype name' }), {
      target: { value: 'Pricing page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    // The folder-with-index shape lands on disk and the selection opens it.
    await waitFor(() =>
      expect(useNavStore.getState().selection).toEqual({ kind: 'studio', project: 'pricing-page' }),
    );
    expect(fs().get('studio/pricing-page/index.md')).toContain('# Pricing page');
  });

  it('previews the main page and re-renders it as a live body', async () => {
    fs().set('studio/landing/index.md', '# Landing\n\nHero copy here.\n');
    await useVaultStore.getState().rescan();
    render(<StudioPage selection={{ kind: 'studio', project: 'landing' }} />);
    // The preview is the RENDERED body, via the read-only renderer.
    await waitFor(() => expect(screen.getByText('Hero copy here.')).toBeTruthy());
  });

  it('shows calculated source fences without changing the prototype bytes', async () => {
    const path = 'studio/budget/index.md';
    const source = '# Budget\n\n```cerebro-sheet\n=SUM(1,2)\n```\n';
    fs().set(path, source);
    await useVaultStore.getState().rescan();
    vi.mocked(calculateSheets).mockResolvedValue([
      {
        ok: true,
        name: 'Sheet1',
        rows: 1,
        cols: 1,
        cells: [{ row: 1, col: 1, kind: 'number', display: '3' }],
      },
    ]);
    render(<StudioPage selection={{ kind: 'studio', project: 'budget' }} />);
    await waitFor(() => expect(screen.getByTestId('sheet-grid')).toBeTruthy());
    expect(screen.getAllByTestId('sheet-cell')[0].textContent).toBe('3');
    expect(fs().get(path)).toBe(source);
  });
  it('previews a board fence and a canvas file without reading the canvas as markdown', async () => {
    const path = 'studio/map/sketch.canvas';
    const source =
      '{"nodes":[{"id":"a","type":"text","text":"Board card","x":0,"y":0,"width":200,"height":100}]}';
    fs().set(
      'studio/map/index.md',
      '# Map\n\n```cerebro-whiteboard\nboard: studio/map/sketch.canvas\n```',
    );
    fs().set(path, source);
    await useVaultStore.getState().rescan();
    const read = vi.spyOn(ipc, 'readNote');
    const view = render(<StudioPage selection={{ kind: 'studio', project: 'map' }} />);
    expect(await screen.findByText('Board card')).toBeTruthy();
    expect(screen.queryByTestId('wb-input')).toBeNull();
    fireEvent.click(
      screen.getAllByTestId('studio-page-row').find((item) => item.textContent === 'Sketch')!,
    );
    await waitFor(() => expect(screen.getByTestId('wb-board').style.height).toBe('520px'));
    expect(read.mock.calls.every((call) => call[1] !== path)).toBe(true);
    fireEvent.click(screen.getByTestId('studio-edit-page'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'diagram', path });
    view.unmount();
    expect(fs().get(path)).toBe(source);
    read.mockRestore();
  });

  it('Build with the assistant seeds the panel at the prototype folder', async () => {
    fs().set('studio/landing/index.md', '# Landing\n\nHero.\n');
    await useVaultStore.getState().rescan();
    render(<StudioPage selection={{ kind: 'studio', project: 'landing' }} />);
    fireEvent.click(await screen.findByTestId('studio-build'));
    const ui = useUiStore.getState();
    // The chat rail IS the assistant panel — opened, aimed at the folder.
    expect(ui.aiPanelOpen).toBe(true);
    expect(ui.handoffs.at(-1)?.text).toContain('studio/landing/');
    expect(ui.handoffs.at(-1)?.subject).toBe('studio/landing/index.md');
    // The bubble names the act and the prototype, not the prompt (M52.4).
    expect(ui.handoffs.at(-1)?.label).toBe('Build with the assistant · Landing');
  });

  it('says plainly when a deep-linked prototype no longer exists', async () => {
    render(<StudioPage selection={{ kind: 'studio', project: 'gone' }} />);
    // Absent said as absent — never a blank preview of nothing.
    expect(screen.getByText('This prototype no longer exists')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All prototypes' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'studio' });
  });

  it('a failed page read says could-not-read, never an empty preview', async () => {
    fs().set('studio/landing/index.md', '# Landing\n\nHero.\n');
    await useVaultStore.getState().rescan();
    // The entry survives the scan but the body read will miss: simulate a
    // file that vanished between scan and read.
    fs().delete('studio/landing/index.md');
    render(<StudioPage selection={{ kind: 'studio', project: 'landing' }} />);
    await waitFor(() => expect(screen.getByTestId('studio-preview-unavailable')).toBeTruthy());
  });
});
