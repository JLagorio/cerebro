import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { readCanvas } from '@/engine/scene/jsonCanvas';
import { newBoardFile } from './newBoardFile';
import { ConvertBoardDialog } from './ConvertBoardDialog';
vi.mock('./newBoardFile', () => ({ newBoardFile: vi.fn() }));
const code =
  'flowchart LR\n%% cerebro:layout manual\n%% cerebro:pos A 100,100 B 400,100\nA{Choice} -->|go| B[End]\nA ~~~ B\nclassDef hot fill:red';
beforeEach(() => {
  vi.mocked(newBoardFile).mockReset().mockResolvedValue('diagrams/plan-2.canvas');
  useVaultStore.setState({ vaultPath: '/v', entries: [] });
  useUiStore.setState({ toasts: [] });
});
afterEach(cleanup);
const mount = (props: Partial<React.ComponentProps<typeof ConvertBoardDialog>> = {}) => {
  const close = vi.fn(),
    converted = vi.fn();
  const view = render(
    <ConvertBoardDialog
      path="diagrams/plan.mmd"
      code={code}
      container={null}
      onClose={close}
      onConverted={converted}
      {...props}
    />,
  );
  return { ...view, close, converted };
};
it('shows the target and actual losses before writing, then opens the one deduped result', async () => {
  const { close, converted } = mount();
  expect(screen.getByTestId('convert-board-dialog').textContent).toContain('diagrams/plan.canvas');
  expect(screen.getByTestId('convert-board-dialog').textContent).toContain('diamond ×1');
  expect(screen.getByTestId('convert-board-dialog').textContent).toContain('1 invisible link');
  expect(screen.getByTestId('convert-board-dialog').textContent).toContain('classDef hot fill:red');
  expect(newBoardFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
  fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
  await waitFor(() => expect(converted).toHaveBeenCalledExactlyOnceWith('diagrams/plan-2.canvas'));
  expect(newBoardFile).toHaveBeenCalledTimes(1);
  const [vault, path, raw] = vi.mocked(newBoardFile).mock.calls[0];
  expect([vault, path]).toEqual(['/v', 'diagrams/plan.canvas']);
  const read = readCanvas(raw!);
  expect(read.ok).toBe(true);
  if (read.ok) expect(read.board.nodes.get('A')).toMatchObject({ shape: 'diamond' });
  expect(close).toHaveBeenCalledTimes(1);
  expect(useUiStore.getState().toasts.at(-1)?.message).toBe(
    'Made plan-2.canvas. plan.mmd is unchanged.',
  );
});
it('Cancel writes nothing', () => {
  const { close } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(newBoardFile).not.toHaveBeenCalled();
});
it('an ineligible diagram disables conversion and a refused write leaves the report open', async () => {
  const view = mount({ code: 'flowchart TD\nA --> B' });
  expect(screen.getByRole('button', { name: 'Convert' })).toHaveProperty('disabled', true);
  expect(newBoardFile).not.toHaveBeenCalled();
  view.unmount();
  vi.mocked(newBoardFile).mockRejectedValue(new Error('Knowledge boards are read-only here.'));
  const { close, converted } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
  await waitFor(() =>
    expect(useUiStore.getState().toasts.at(-1)?.message).toContain(
      'Knowledge boards are read-only here.',
    ),
  );
  expect(close).not.toHaveBeenCalled();
  expect(converted).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Convert' })).toHaveProperty('disabled', false);
});
it.each(['switch', 'roundtrip', 'unmount', 'source'] as const)(
  'a late result cannot repoint a tab after %s',
  async (end) => {
    let resolve!: (path: string) => void;
    vi.mocked(newBoardFile).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    act(() => {
      if (end === 'unmount') view.unmount();
      else if (end === 'source')
        view.rerender(
          <ConvertBoardDialog
            path="diagrams/other.mmd"
            code={code}
            container={null}
            onClose={view.close}
            onConverted={view.converted}
          />,
        );
      else {
        useVaultStore.setState({ vaultPath: '/other' });
        if (end === 'roundtrip') useVaultStore.setState({ vaultPath: '/v' });
      }
    });
    await act(async () => resolve('diagrams/plan.canvas'));
    expect(view.close).not.toHaveBeenCalled();
    expect(view.converted).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts).toEqual([]);
    if (end === 'roundtrip' || end === 'source')
      expect(screen.getByRole('button', { name: 'Convert' })).toHaveProperty('disabled', false);
  },
);
