// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentIpc from '@/agent/agentIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { isAiBlockRunning, setAiBlockRunning } from './aiBlockRuns';
import { AiBlockView } from './blocks';
import { MarkdownEditor, type CerebroEditor, type EditorReadyInfo } from './MarkdownEditor';

/**
 * The AI block's question and run (M91.14), through the editor that runs
 * it: a Prompt Input whose submit is the run button, drawn working — the
 * word under the AI light, the button and the question held — from the ask
 * until the answer lands, and only then. The run is held here, so the
 * working state can be seen; its carrier is MarkdownEditor.test.tsx's and
 * markdown.test.ts's, and is unchanged.
 */

const handlers: Array<(event: unknown) => void> = [];
vi.mock(import('@/agent/agentIpc'), async (original) => ({
  ...(await original()),
  runAgent: vi.fn(async () => ({ run: 7, durableId: null })),
  onAgentEvent: vi.fn((handler: (event: unknown) => void) => {
    handlers.push(handler);
    return () => {
      const at = handlers.indexOf(handler);
      if (at >= 0) handlers.splice(at, 1);
    };
  }) as never,
}));

const ASKED =
  ':::ai{prompt="What does this decide?" generated="2026-10-12"}\nThe old answer.\n:::\n';

async function editorOn(markdown: string, onChange = vi.fn()) {
  const onReady = vi.fn<(info: EditorReadyInfo) => void>();
  render(
    <MarkdownEditor markdown={markdown} onChange={onChange} onReady={onReady} debounceMs={20} />,
  );
  await waitFor(() => expect(onReady).toHaveBeenCalled());
  return { editor: onReady.mock.calls[0][0].editor as CerebroEditor, onChange };
}

const run = () => screen.getByTestId('ai-block-run') as HTMLButtonElement;
const block = () => screen.getByTestId('ai-block');
const emit = (event: unknown) =>
  act(() => {
    for (const handler of [...handlers]) handler(event);
  });

let vaultBefore: string | null;
beforeEach(() => {
  handlers.length = 0;
  vi.mocked(agentIpc.runAgent).mockClear();
  vaultBefore = useVaultStore.getState().vaultPath;
  useVaultStore.setState({ vaultPath: '/vault' });
});
afterEach(() => {
  cleanup();
  useVaultStore.setState({ vaultPath: vaultBefore });
});

describe('the AI block’s run', () => {
  it('is the Prompt Input’s submit, named by its word', async () => {
    await editorOn(ASKED);
    expect(run().dataset.slot).toBe('prompt-input-submit');
    expect(
      run().closest('[data-slot="prompt-input"]')?.contains(screen.getByTestId('ai-block-prompt')),
    ).toBe(true);
    expect(run().textContent).toBe('Recompute');
    expect(screen.getByRole('button', { name: 'Recompute' })).toBe(run());
    expect(run().disabled).toBe(false);
    expect(block().hasAttribute('aria-busy')).toBe(false);
    expect(block().querySelector('.cb-ai-shimmer')).toBeNull();
  });

  it('works under the AI light from the ask until the answer lands, and only then', async () => {
    const { editor, onChange } = await editorOn(ASKED);
    fireEvent.click(run());
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    expect(run().textContent).toBe('Working…');
    expect(run().querySelector('.cb-ai-shimmer')?.textContent).toBe('Working…');
    expect(run().disabled).toBe(true);
    expect(block().getAttribute('aria-busy')).toBe('true');
    // The question is held too: the answer lands with the question it was asked.
    expect((screen.getByTestId('ai-block-prompt') as HTMLButtonElement).disabled).toBe(true);
    expect(isAiBlockRunning(editor, editor.document[0].id)).toBe(true);

    // A second ask while it runs is refused.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('cerebro:ai-block-run', {
          detail: { id: editor.document[0].id, prompt: 'What does this decide?' },
        }),
      );
    });
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce();

    emit({ run: 7, kind: 'Result', text: 'Ship on Thursdays.' });
    expect(run().textContent).toBe('Working…');
    emit({ run: 7, kind: 'Done' });
    await waitFor(() => expect(run().textContent).toBe('Recompute'));
    expect(block().querySelector('.cb-ai-shimmer')).toBeNull();
    expect(run().disabled).toBe(false);
    expect(block().hasAttribute('aria-busy')).toBe(false);
    await waitFor(() => expect(onChange.mock.lastCall?.[0]).toContain('Ship on Thursdays.'));
    expect(onChange.mock.lastCall?.[0]).not.toContain('The old answer.');
  });

  it('stops working when the run fails, leaving the old answer', async () => {
    const { editor } = await editorOn(ASKED);
    fireEvent.click(run());
    await waitFor(() => expect(run().textContent).toBe('Working…'));
    emit({ run: 7, kind: 'Error', message: 'The CLI is not signed in.' });
    await waitFor(() => expect(run().textContent).toBe('Recompute'));
    expect(isAiBlockRunning(editor, editor.document[0].id)).toBe(false);
    expect(screen.getByText('The old answer.')).toBeTruthy();
  });

  it('stops working when the run never starts, or ends with no answer', async () => {
    const { editor } = await editorOn(ASKED);
    const id = editor.document[0].id;
    vi.mocked(agentIpc.runAgent).mockRejectedValueOnce(new Error('The CLI is missing.'));
    fireEvent.click(run());
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    await waitFor(() => expect(run().textContent).toBe('Recompute'));
    expect(isAiBlockRunning(editor, id)).toBe(false);

    fireEvent.click(run());
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(handlers).toHaveLength(1));
    expect(run().textContent).toBe('Working…');
    emit({ run: 7, kind: 'Done' });
    await waitFor(() => expect(run().textContent).toBe('Recompute'));
    expect(isAiBlockRunning(editor, id)).toBe(false);
    expect(screen.getByText('The old answer.')).toBeTruthy();
  });

  it('draws whatever the editor marks, and nothing else', async () => {
    const { editor } = await editorOn(ASKED);
    const id = editor.document[0].id;
    act(() => setAiBlockRunning(editor, id, true));
    expect(run().textContent).toBe('Working…');
    // Another editor's run is not this block's.
    act(() => setAiBlockRunning({}, id, false));
    expect(run().textContent).toBe('Working…');
    act(() => setAiBlockRunning(editor, id, false));
    expect(run().textContent).toBe('Recompute');
  });
});

describe('the AI block’s question', () => {
  it('is a Prompt Input field that keeps one line', async () => {
    const asked = vi.fn();
    const listen = (event: Event) => asked((event as CustomEvent<{ prompt: string }>).detail);
    window.addEventListener('cerebro:ai-block-run', listen);
    try {
      const { editor } = await editorOn(':::ai\n:::\n');
      const field = (await screen.findByTestId('ai-block-prompt-input')) as HTMLTextAreaElement;
      expect(field.tagName).toBe('TEXTAREA');
      expect(field.dataset.slot).toBe('prompt-input-textarea');
      expect(field.getAttribute('aria-label')).toBe('What should this block answer?');
      expect(run().textContent).toBe('Answer');
      expect(run().disabled).toBe(true);
      // A pasted line break is a space, and Shift+Enter neither breaks nor asks.
      fireEvent.change(field, { target: { value: 'The open\nquestions' } });
      expect(field.value).toBe('The open questions');
      expect(editor.document[0].props).toMatchObject({ prompt: 'The open questions' });
      expect(fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })).toBe(false);
      expect(asked).not.toHaveBeenCalled();
      expect(run().disabled).toBe(false);
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(asked).toHaveBeenCalledExactlyOnceWith({
        id: editor.document[0].id,
        prompt: 'The open questions',
      });
    } finally {
      window.removeEventListener('cerebro:ai-block-run', listen);
    }
  });

  /* A textarea takes the caret at its start where the input it replaced put
     it at the end, and on a Mac End moves no caret in a field: opened from a
     click, the question puts the caret after its last word. */
  it('opens with the caret after the question’s last word', async () => {
    await editorOn(ASKED);
    fireEvent.click(screen.getByTestId('ai-block-prompt'));
    const field = (await screen.findByTestId('ai-block-prompt-input')) as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.value).toBe('What does this decide?');
    expect([field.selectionStart, field.selectionEnd]).toEqual([22, 22]);
  });

  it('adds no document keydown listener: its keys are its own field’s', () => {
    const listen = vi.spyOn(document, 'addEventListener');
    const onRun = vi.fn();
    render(
      <AiBlockView
        prompt=""
        generated=""
        running={false}
        onEditPrompt={() => undefined}
        onRun={onRun}
      />,
    );
    const field = screen.getByTestId('ai-block-prompt-input');
    fireEvent.change(field, { target: { value: 'Q' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.change(field, { target: { value: 'Q' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onRun).toHaveBeenCalledOnce();
    expect(listen.mock.calls.filter(([kind]) => kind === 'keydown')).toEqual([]);
    listen.mockRestore();
  });
});
