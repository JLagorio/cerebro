// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockFs, writeTextFile } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { DiagramPage } from './DiagramPage';

// Same stub the MermaidBlockView tests use: the page's panes (structural
// editor, live preview) all render through the shared core, and jsdom has no
// real mermaid.
vi.mock('@/mermaid/render', () => ({ renderMermaid: vi.fn() }));
import { renderMermaid } from '@/mermaid/render';
const renderMock = vi.mocked(renderMermaid);

const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

/** The seeded demo-vault flowchart, mermaid config header included. */
const PIPELINE = 'diagrams/pipeline.mmd';

describe('DiagramPage', () => {
  beforeEach(async () => {
    resetMockFs();
    window.localStorage.clear();
    useUiStore.setState({ toasts: [] });
    useNavStore.setState({
      selection: { kind: 'diagram', path: PIPELINE },
      history: [{ kind: 'diagram', path: PIPELINE }],
      historyIndex: 0,
    });
    renderMock.mockResolvedValue({ ok: true, svg: '<svg data-fake="page"></svg>' });
    await useVaultStore.getState().openVault('/demo-vault');
  });
  afterEach(cleanup);

  it('loads a flowchart .mmd and opens in the structural editor', async () => {
    render(<DiagramPage selection={{ kind: 'diagram', path: PIPELINE }} />);
    expect(await screen.findByTestId('structural-host')).toBeTruthy();
    // Title from the filename stem (the scanner's), type from the source.
    expect(screen.getByTestId('diagram-title').textContent).toBe('Pipeline');
    expect(screen.getByText('Flowchart')).toBeTruthy();
    expect(screen.queryByTestId('diagram-code-pane')).toBeNull();
  });

  it('opens a non-flowchart .mmd in code mode with the source verbatim', async () => {
    const raw = 'sequenceDiagram\n  Alice->>Bob: hello\n';
    await writeTextFile('/demo-vault', 'diagrams/handshake.mmd', raw);
    await useVaultStore.getState().rescan();
    render(<DiagramPage selection={{ kind: 'diagram', path: 'diagrams/handshake.mmd' }} />);
    expect(await screen.findByTestId('diagram-code-pane')).toBeTruthy();
    expect((screen.getByLabelText('Mermaid source') as HTMLTextAreaElement).value).toBe(raw);
    expect(screen.queryByTestId('structural-host')).toBeNull();
    expect(screen.getByText('Sequence')).toBeTruthy();
  });

  it('shows the whole file in code mode — the mermaid header is source, not frontmatter', async () => {
    render(<DiagramPage selection={{ kind: 'diagram', path: PIPELINE }} />);
    await screen.findByTestId('structural-host');
    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
    const textarea = (await screen.findByLabelText('Mermaid source')) as HTMLTextAreaElement;
    expect(textarea.value.startsWith('---\n')).toBe(true);
    expect(textarea.value).toContain('layout: elk');
  });

  it('debounce-saves edits raw, preserving the leading config header', async () => {
    render(<DiagramPage selection={{ kind: 'diagram', path: PIPELINE }} />);
    await screen.findByTestId('structural-host');
    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
    const textarea = (await screen.findByLabelText('Mermaid source')) as HTMLTextAreaElement;
    const edited = `${textarea.value}  D --> E[Ship]\n`;
    fireEvent.change(textarea, { target: { value: edited } });
    // Dirty immediately; on disk only after the 500ms debounce settles.
    expect(screen.getByTestId('diagram-save-state').textContent).toBe('Unsaved');
    await waitFor(() => expect(fs().get(PIPELINE)).toContain('E[Ship]'), { timeout: 3000 });
    const raw = fs().get(PIPELINE)!;
    // The raw round-trip: the header survived the save byte-for-byte.
    expect(raw.startsWith('---\nconfig:\n  layout: elk\n---\n')).toBe(true);
    expect(raw).toBe(edited);
    await waitFor(() => expect(screen.getByTestId('diagram-save-state').textContent).toBe('Saved'));
  });

  it('shows the empty state when the file is gone from the vault', () => {
    render(<DiagramPage selection={{ kind: 'diagram', path: 'diagrams/gone.mmd' }} />);
    expect(screen.getByText('This diagram no longer exists')).toBeTruthy();
  });
});
