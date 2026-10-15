import { afterEach, describe, expect, it } from 'vitest';
import { askRename, useRenamePromptStore, type RenamePrompt } from './renamePromptStore';

const prompt: RenamePrompt = {
  vault: '/vault',
  from: 'Before',
  to: 'After',
  pages: [],
  anchors: [],
  refused: [],
  sources: [],
};
afterEach(() => useRenamePromptStore.getState().cancel());

describe('rename prompt', () => {
  it('waits for the answer and clears the prompt exactly once', async () => {
    const result = askRename(prompt);
    expect(useRenamePromptStore.getState().pending).toMatchObject(prompt);
    useRenamePromptStore.getState().answer(true);
    expect(await result).toBe(true);
    expect(useRenamePromptStore.getState().pending).toBeNull();
    useRenamePromptStore.getState().answer(false);
  });

  it('cancel settles the waiting rename without throwing', async () => {
    const result = askRename(prompt);
    useRenamePromptStore.getState().cancel();
    expect(await result).toBe(false);
  });

  it('a new request cancels the old request and ignores its stale answer', async () => {
    const first = askRename(prompt);
    const firstId = useRenamePromptStore.getState().pending!.id;
    const second = askRename({ ...prompt, to: 'Another' });
    expect(await first).toBe(false);
    useRenamePromptStore.getState().answer(true, firstId);
    expect(useRenamePromptStore.getState().pending?.to).toBe('Another');
    useRenamePromptStore.getState().answer(false);
    expect(await second).toBe(false);
  });
});
