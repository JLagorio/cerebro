import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileProbe } from '@/engine/fileBytes';
import { fileRefusal } from '@/engine/fileBytes';
import { KINDS } from '@/engine/fileKinds';
import type { ReactNode } from 'react';
import { useKeyScope } from '@/lib/keys/useKeys';
import { useUiStore } from '@/stores/uiStore';
import { viewerFor } from './registry';
import { ImageViewer } from './ImageViewer';
import { MediaViewer } from './MediaViewer';
import { TableViewer } from './TableViewer';
import { FileActions } from './FileActions';
import { UnknownViewer } from './UnknownViewer';

const ipc = vi.hoisted(() => ({
  fileUrl: vi.fn(),
  desktopFileActions: vi.fn(),
  openFileOutside: vi.fn(),
  revealFile: vi.fn(),
  quickLookFile: vi.fn(),
  saveFileCopy: vi.fn(),
}));
vi.mock('@/lib/rootsIpc', () => ipc);
function Scope({ children }: { children: ReactNode }) {
  const scope = useKeyScope('file-viewer');
  return (
    <scope.Provider>
      <section {...scope.props}>{children}</section>
    </scope.Provider>
  );
}
const probe: FileProbe = {
  size: 16,
  mime: 'image/png',
  kind: 'image',
  door: 'scheme',
  sniff: 'binary',
  open: 'allow',
};
beforeEach(() => {
  vi.resetAllMocks();
  ipc.fileUrl.mockResolvedValue('data:image/png;base64,AQI=');
  ipc.desktopFileActions.mockReturnValue(false);
  useUiStore.setState({ toasts: [] });
});

describe('viewer selection', () => {
  it('maps every table viewer and respects an unknown file’s sniff and open verdict', () => {
    const expected = {
      doc: 'doc',
      code: 'code',
      image: 'image',
      media: 'media',
      table: 'table',
      pdf: 'pdf',
      none: 'unknown',
    };
    for (const row of KINDS.kinds)
      expect(viewerFor(`file.${row.ext}`, probe)).toBe(expected[row.viewer]);
    expect(viewerFor('Dockerfile.dev', { ...probe, sniff: 'text' })).toBe('code');
    expect(viewerFor('bin/tool', probe)).toBe('unknown');
    expect(viewerFor('bin/tool', { ...probe, sniff: 'text', open: 'deny' })).toBe('unknown');
  });
});
describe('images and media', () => {
  it('starts fit, allows actual size, and refuses an oversized image before reading', async () => {
    const view = render(<ImageViewer rootId="r" path="logo.png" probe={probe} />, {
      wrapper: Scope,
    });
    expect((await screen.findByRole('img')).getAttribute('draggable')).toBe('false');
    expect(screen.getByTestId('image-viewer').getAttribute('data-fit')).toBe('fit');
    fireEvent.click(screen.getByRole('button', { name: '100%' }));
    expect(screen.getByTestId('image-viewer').getAttribute('data-fit')).toBe('actual');
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(screen.getByTestId('image-viewer').getAttribute('data-fit')).toBe('fit');
    view.unmount();
    ipc.fileUrl.mockClear();
    render(
      <ImageViewer rootId="r" path="huge.png" probe={{ ...probe, size: 64 * 1024 * 1024 + 1 }} />,
      { wrapper: Scope },
    );
    expect(screen.getByTestId('viewer-too-large')).toBeTruthy();
    expect(ipc.fileUrl).not.toHaveBeenCalled();
  });
  it.each(['audio', 'video'] as const)(
    'offers native %s controls without autoplay and explains decoding failure',
    async (kind) => {
      const view = render(<MediaViewer rootId="r" path="clip.mp4" probe={{ ...probe, kind }} />);
      await waitFor(() => expect(view.container.querySelector(kind)).not.toBeNull());
      const media = view.container.querySelector(kind)!;
      expect(media.controls).toBe(true);
      expect(media.autoplay).toBe(false);
      expect(media.preload).toBe('metadata');
      Object.defineProperty(media, 'error', { value: { code: 3 } });
      fireEvent.error(media);
      expect(screen.getByRole('status').textContent).toContain('could not be decoded');
    },
  );
  it('renders byte refusals as unavailable, not an empty player', async () => {
    ipc.fileUrl.mockResolvedValue(fileRefusal('outside'));
    render(<MediaViewer rootId="r" path="a.mp3" probe={{ ...probe, kind: 'audio' }} />);
    expect((await screen.findByRole('status')).textContent).toContain(
      fileRefusal('outside').message,
    );
  });
});
describe('read-only tables', () => {
  it('keeps quoted newlines and formula-looking cells as text, and can show the source', () => {
    const raw = 'Title,Notes\nDune,"desert\nplanet"\nFormula,=SUM(A1)';
    render(<TableViewer path="books.csv" content={raw} />);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('cell', { name: /desert\s+planet/ }).textContent).toContain(
      'desert\nplanet',
    );
    expect(screen.getByRole('cell', { name: '=SUM(A1)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View as text' }));
    expect(screen.getByTestId('code-viewer').textContent).toContain('=SUM(A1)');
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('splits TSV on tabs and keeps the first record when Header row is off', () => {
    render(<TableViewer path="books.tsv" content={'Name\tValue\nA,B\t2'} />);
    expect(screen.getByRole('cell', { name: 'A,B' })).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Header row' }));
    expect(screen.getByRole('columnheader', { name: 'Column 1' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'Name' })).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
  it('bounds the rendered rows but retains their measured count', () => {
    render(
      <TableViewer
        path="many.csv"
        content={'Name\n' + Array.from({ length: 1001 }, (_, i) => `row ${i}`).join('\n')}
      />,
    );
    expect(screen.getByText('Showing the first 1,000 of 1,001 rows.')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(1001);
    expect(screen.queryByText('row 1000')).toBeNull();
  });
  it.each(['a\n"never closed', Array(101).fill('a').join(',') + '\nx'])(
    'falls back to readable source for malformed input',
    (content) => {
      render(<TableViewer path="bad.csv" content={content} />);
      expect(screen.getByRole('status').textContent).not.toBe('');
      expect(screen.getByTestId('code-viewer')).toBeTruthy();
      expect(screen.queryByRole('table')).toBeNull();
    },
  );
});
describe('desktop file actions', () => {
  it.each(['allow', 'confirm', 'deny'] as const)(
    'renders the %s verdict and marks browser-only limitations',
    (open) => {
      render(
        <>
          <FileActions rootId="r" path="file" probe={{ ...probe, open }} />
          <UnknownViewer path="file" probe={{ ...probe, open }} />
        </>,
      );
      const actions = within(screen.getByTestId('file-actions'));
      expect(actions.getAllByRole('button')).toHaveLength(open === 'deny' ? 3 : 4);
      for (const button of actions.getAllByRole('button'))
        expect(button.hasAttribute('disabled')).toBe(true);
      if (open === 'deny') {
        expect(actions.queryByRole('button', { name: /^Open/ })).toBeNull();
        expect(screen.getByText(/looks like a program/)).toBeTruthy();
      } else
        expect(
          actions.getByRole('button', { name: open === 'confirm' ? 'Open…' : 'Open' }),
        ).toBeTruthy();
      expect(screen.getByText('Desktop app only')).toBeTruthy();
    },
  );
  it('contains transport failures, reports a saved copy and stays silent on cancellation', async () => {
    ipc.desktopFileActions.mockReturnValue(true);
    ipc.openFileOutside.mockRejectedValue(new Error('IPC disconnected'));
    ipc.saveFileCopy.mockResolvedValue({ state: 'saved', destination: '/tmp/copy.png' });
    ipc.quickLookFile.mockResolvedValue({ state: 'cancelled' });
    render(<FileActions rootId="r" path="logo.png" probe={probe} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.at(-1)?.message).toBe(
        "Couldn't complete this file action",
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save a copy…' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save a copy…' }));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.at(-1)?.message).toBe('Saved a copy to /tmp/copy.png'),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Quick Look' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    const count = useUiStore.getState().toasts.length;
    fireEvent.click(screen.getByRole('button', { name: 'Quick Look' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Quick Look' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    expect(useUiStore.getState().toasts).toHaveLength(count);
    expect(ipc.saveFileCopy).toHaveBeenCalledWith('r', 'logo.png');
  });
});
