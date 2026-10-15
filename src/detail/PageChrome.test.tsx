import { seedBytes, reset as resetBytes } from '@/lib/mockBytes';
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetLayers } from '@/components/ui/layers';
import { __resetOpenPages, registerFlush } from '@/editor/openPages';
import { makeEntry } from '@/engine/testHelpers';
import type { Entry } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { PageCoverBand, PageIconHeader } from './PageChrome';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ipc = vi.hoisted(() => ({
  canPickFiles: vi.fn(() => true),
  pickFiles: vi.fn(async () => [] as string[]),
  importAttachment: vi.fn(async (_v: string, source: string) => {
    return { path: `attachments/${source.split('/').pop() ?? 'file'}`, reused: false };
  }),
}));

vi.mock('@/lib/ipc', () => ipc);

const ROCKET = '\u{1F680}';
const page = (properties: Record<string, unknown> = {}, path = 'notes/plan.md'): Entry =>
  makeEntry({ path, folder: path.split('/')[0], properties: properties as never });

let patchFrontmatter: ReturnType<typeof vi.fn>;
let order: string[];

beforeEach(() => {
  resetLayers();
  resetBytes();
  __resetOpenPages();
  order = [];
  patchFrontmatter = vi.fn(async () => {
    order.push('patch');
    return true;
  });
  useUiStore.setState({ toasts: [] });
  useVaultStore.setState({ vaultPath: '/vault', patchFrontmatter });
  ipc.importAttachment
    .mockReset()
    .mockImplementation(async (_v, source) => ({ path: `attachments/${source.split('/').pop() ?? 'file'}`, reused: false }));
  ipc.canPickFiles.mockReturnValue(true);
  ipc.pickFiles.mockResolvedValue([]);
});
afterEach(cleanup);

const renderChrome = (entry: Entry, editable = true) =>
  render(
    <>
      <PageCoverBand entry={entry} editable={editable} />
      <PageIconHeader entry={entry} editable={editable} />
    </>,
  );

describe('PageIconHeader', () => {
  it('a page with nothing set draws no icon or cover, and writes nothing', () => {
    renderChrome(page());
    expect(screen.queryByTestId('page-icon')).toBeNull();
    expect(screen.queryByTestId('page-cover')).toBeNull();
    expect(screen.getByTestId('page-add-icon')).toBeTruthy();
    expect(screen.getByTestId('page-add-cover')).toBeTruthy();
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  it('a page that cannot be edited and has nothing set draws nothing at all', () => {
    const { container } = renderChrome(page(), false);
    expect(container.innerHTML).toBe('');
  });

  it('Add icon, then the grid, writes the emoji', async () => {
    const user = userEvent.setup();
    renderChrome(page());
    await user.click(screen.getByTestId('page-add-icon'));
    await user.click(screen.getByRole('button', { name: ROCKET }));
    await waitFor(() =>
      expect(patchFrontmatter).toHaveBeenCalledWith('notes/plan.md', { icon: ROCKET }),
    );
    expect(screen.queryByTestId('page-icon-picker')).toBeNull();
  });

  it('the Emoji field takes one emoji on Enter', async () => {
    const user = userEvent.setup();
    renderChrome(page());
    await user.click(screen.getByTestId('page-add-icon'));
    await user.type(screen.getByLabelText('Emoji'), `${ROCKET}{Enter}`);
    await waitFor(() =>
      expect(patchFrontmatter).toHaveBeenCalledWith('notes/plan.md', { icon: ROCKET }),
    );
  });

  it('two emoji write nothing and show the hint', async () => {
    const user = userEvent.setup();
    renderChrome(page());
    await user.click(screen.getByTestId('page-add-icon'));
    await user.type(screen.getByLabelText('Emoji'), `${ROCKET}${ROCKET}{Enter}`);
    expect(screen.getByTestId('page-emoji-hint').textContent).toMatch(/One emoji only/);
    expect(screen.getByTestId('page-emoji-hint').textContent).toMatch(/⌃⌘Space/);
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  it('Escape closes the picker and writes nothing', async () => {
    const user = userEvent.setup();
    renderChrome(page());
    await user.click(screen.getByTestId('page-add-icon'));
    expect(screen.getByTestId('page-icon-picker')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('page-icon-picker')).toBeNull();
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  it('a set icon is the button that opens its picker, and Remove writes null', async () => {
    const user = userEvent.setup();
    renderChrome(page({ icon: ROCKET }));
    expect(screen.queryByTestId('page-add-icon')).toBeNull();
    await user.click(screen.getByTestId('page-icon'));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(patchFrontmatter).toHaveBeenCalledWith('notes/plan.md', { icon: null }),
    );
  });

  it('lands every pending save before the patch', async () => {
    const user = userEvent.setup();
    registerFlush(async () => {
      await Promise.resolve();
      order.push('flush');
    });
    renderChrome(page());
    await user.click(screen.getByTestId('page-add-icon'));
    await user.click(screen.getByRole('button', { name: ROCKET }));
    await waitFor(() => expect(order).toEqual(['flush', 'patch']));
  });

  it.each(['vault round trip', 'another record', 'unmount'])(
    'does not patch after a flush outlives %s',
    async (change) => {
      const user = userEvent.setup();
      const flushed = deferred<void>();
      registerFlush(() => flushed.promise);
      const view = render(<PageIconHeader entry={page()} editable />);
      await user.click(screen.getByTestId('page-add-icon'));
      await user.click(screen.getByRole('button', { name: ROCKET }));
      if (change === 'unmount') view.unmount();
      else if (change === 'another record')
        view.rerender(<PageIconHeader entry={page({}, 'notes/other.md')} editable />);
      else
        act(() => {
          useVaultStore.setState({ vaultPath: '/other' });
          useVaultStore.setState({ vaultPath: '/vault' });
        });
      await act(async () => flushed.resolve());
      expect(patchFrontmatter).not.toHaveBeenCalled();
    },
  );

  it('does not import after its native picker closes with a vault switch', async () => {
    const user = userEvent.setup();
    const picked = deferred<string[]>();
    ipc.pickFiles.mockReturnValue(picked.promise);
    renderChrome(page());
    await user.click(screen.getByTestId('page-add-cover'));
    await user.click(screen.getByRole('button', { name: 'Choose an image…' }));
    act(() => useVaultStore.setState({ vaultPath: '/other' }));
    await act(async () => picked.resolve(['/a/new.png']));
    expect(ipc.importAttachment).not.toHaveBeenCalled();
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(screen.queryByTestId('page-cover-picker')).toBeNull();
  });

  it('does not patch a different record when an image copy finishes', async () => {
    const user = userEvent.setup();
    const copied = deferred<{ path: string; reused: boolean }>();
    ipc.pickFiles.mockResolvedValue(['/a/new.png']);
    ipc.importAttachment.mockReturnValue(copied.promise);
    const view = render(<PageIconHeader entry={page()} editable />);
    await user.click(screen.getByTestId('page-add-cover'));
    await user.click(screen.getByRole('button', { name: 'Choose an image…' }));
    await waitFor(() => expect(ipc.importAttachment).toHaveBeenCalledTimes(1));
    view.rerender(<PageIconHeader entry={page({}, 'notes/other.md')} editable />);
    await act(async () => copied.resolve({ path: 'attachments/new.png', reused: false }));
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  it('under knowledge/ an icon shows but there is no Add row and no button', () => {
    renderChrome(page({ icon: ROCKET }, 'knowledge/concepts/x.md'));
    expect(screen.getByTestId('page-icon').tagName).toBe('SPAN');
    expect(screen.queryByTestId('page-chrome-add')).toBeNull();
    expect(screen.queryByTestId('page-add-cover')).toBeNull();
  });

  it('any other icon value is still the picker button, and Remove deletes it', async () => {
    const user = userEvent.setup();
    renderChrome(page({ icon: 'rocket', color: 'blue' }));
    expect(screen.getByTestId('page-icon').tagName).toBe('BUTTON');
    expect(screen.queryByTestId('page-add-icon')).toBeNull();
    await user.click(screen.getByTestId('page-icon'));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(patchFrontmatter).toHaveBeenCalledWith('notes/plan.md', { icon: null }),
    );
  });

  it('a stray icon string is replaced by the emoji the picker writes', async () => {
    const user = userEvent.setup();
    renderChrome(page({ icon: 'LiRocket' }));
    await user.click(screen.getByTestId('page-icon'));
    await user.click(screen.getByRole('button', { name: ROCKET }));
    await waitFor(() =>
      expect(patchFrontmatter).toHaveBeenCalledWith('notes/plan.md', { icon: ROCKET }),
    );
  });

  it('the Upload tab offers Choose an image only when a native picker exists', async () => {
    const user = userEvent.setup();
    ipc.canPickFiles.mockReturnValue(false);
    renderChrome(page());
    await user.click(screen.getByTestId('page-add-icon'));
    await user.click(screen.getByRole('tab', { name: 'Upload' }));
    expect(screen.queryByRole('button', { name: 'Choose an image…' })).toBeNull();
    expect(screen.getByLabelText('Vault path')).toBeTruthy();
  });

  it('Choose an image copies the file in and writes the path it landed at', async () => {
    const user = userEvent.setup();
    ipc.pickFiles.mockResolvedValue(['/Users/me/Pictures/logo.png']);
    renderChrome(page());
    await user.click(screen.getByTestId('page-add-icon'));
    await user.click(screen.getByRole('tab', { name: 'Upload' }));
    await user.click(screen.getByRole('button', { name: 'Choose an image…' }));
    await waitFor(() =>
      expect(patchFrontmatter).toHaveBeenCalledWith('notes/plan.md', {
        icon: 'attachments/logo.png',
      }),
    );
  });

  it('a picked file that is not an image toasts and writes nothing', async () => {
    const user = userEvent.setup();
    ipc.pickFiles.mockResolvedValue(['/Users/me/report.pdf']);
    renderChrome(page());
    await user.click(screen.getByTestId('page-add-icon'));
    await user.click(screen.getByRole('tab', { name: 'Upload' }));
    await user.click(screen.getByRole('button', { name: 'Choose an image…' }));
    await waitFor(() => expect(useUiStore.getState().toasts).toHaveLength(1));
    expect(ipc.importAttachment).not.toHaveBeenCalled();
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  it.each(['../a.png', '/a.png', 'notes/a.md'])(
    'the vault path field refuses %s',
    async (typed) => {
      const user = userEvent.setup();
      renderChrome(page());
      await user.click(screen.getByTestId('page-add-icon'));
      await user.click(screen.getByRole('tab', { name: 'Upload' }));
      await user.type(screen.getByLabelText('Vault path'), `${typed}{Enter}`);
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(patchFrontmatter).not.toHaveBeenCalled();
    },
  );

  it('the vault path field takes a relative image path', async () => {
    const user = userEvent.setup();
    renderChrome(page());
    await user.click(screen.getByTestId('page-add-icon'));
    await user.click(screen.getByRole('tab', { name: 'Upload' }));
    await user.type(screen.getByLabelText('Vault path'), 'attachments/i.png{Enter}');
    await waitFor(() =>
      expect(patchFrontmatter).toHaveBeenCalledWith('notes/plan.md', { icon: 'attachments/i.png' }),
    );
  });
});

describe('PageCoverBand', () => {
  it('Add cover, then a swatch, writes the colour name', async () => {
    const user = userEvent.setup();
    renderChrome(page());
    await user.click(screen.getByTestId('page-add-cover'));
    await user.click(screen.getByRole('button', { name: 'Blue' }));
    await waitFor(() =>
      expect(patchFrontmatter).toHaveBeenCalledWith('notes/plan.md', { cover: 'blue' }),
    );
  });

  it('a colour cover draws the band in that colour; a set cover hides Add cover', () => {
    renderChrome(page({ cover: 'blue' }));
    expect(screen.getByTestId('page-cover').style.background).toBe('var(--opt-blue)');
    expect(screen.queryByTestId('page-add-cover')).toBeNull();
  });

  it('a file cover draws contained bytes without changing the page', async () => {
    seedBytes('0', 'attachments/c.png', { bytes: [1, 2] });
    renderChrome(page({ cover: 'attachments/c.png' }));
    const image = await screen.findByRole('img', { name: 'c.png' });
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AQI=');
    expect(image.style.objectFit).toBe('cover');
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });
  it('a missing or remote cover keeps its named fallback', async () => {
    const { rerender, container } = render(
      <PageCoverBand entry={page({ cover: 'attachments/missing.png' })} editable={false} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('page-cover').textContent).toContain('attachments/missing.png'),
    );
    rerender(
      <PageCoverBand entry={page({ cover: 'https://example.com/c.png' })} editable={false} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('page-cover').textContent).toContain('https://example.com/c.png');
  });

  it('a cover that is no colour takes the neutral swatch', () => {
    renderChrome(page({ cover: 'expression(alert(1))' }));
    expect(screen.getByTestId('page-cover').style.background).toBe('var(--n-300)');
  });

  it('the band opens its picker, and Remove writes null', async () => {
    const user = userEvent.setup();
    renderChrome(page({ cover: 'red' }));
    await user.click(screen.getByTestId('page-cover'));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(patchFrontmatter).toHaveBeenCalledWith('notes/plan.md', { cover: null }),
    );
  });
});
