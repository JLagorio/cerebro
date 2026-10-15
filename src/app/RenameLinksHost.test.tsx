import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { askRename, useRenamePromptStore, type RenamePrompt } from '@/stores/renamePromptStore';
import { useVaultStore } from '@/stores/vaultStore';
import { RenameLinksHost } from './RenameLinksHost';

const prompt: RenamePrompt = {
  vault: '/vault',
  from: 'Before',
  to: 'After',
  pages: [],
  anchors: [],
  refused: [],
  sources: [],
};
beforeEach(() => useVaultStore.setState({ vaultPath: '/vault' }));
afterEach(() => {
  cleanup();
  useRenamePromptStore.getState().cancel();
});

function ask(overrides: Partial<RenamePrompt> = {}): Promise<boolean> {
  let result!: Promise<boolean>;
  act(() => {
    result = askRename({ ...prompt, ...overrides });
  });
  return result;
}

describe('RenameLinksHost', () => {
  it('shows the exact update counts and confirms the pending rename', async () => {
    render(<RenameLinksHost />);
    const result = ask({
      pages: [
        { path: 'a.md', title: 'A', count: 2 },
        { path: 'b.md', title: 'B', count: 1 },
      ],
    });
    expect(screen.getByRole('dialog', { name: 'Rename “Before” to “After”?' })).toBeTruthy();
    expect(screen.getByText('Updates 3 links in 2 pages.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rename and update' }));
    expect(await result).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uses singular words and states the separate knowledge edit', () => {
    render(<RenameLinksHost />);
    void ask({
      pages: [{ path: 'a.md', title: 'A', count: 1 }],
      anchors: [{ path: 'knowledge/a.md', title: 'Concept' }],
    });
    expect(screen.getByText('Updates 1 link in 1 page.')).toBeTruthy();
    expect(
      screen.getByText(
        'Points 1 knowledge concept at the new name. Knowledge records it as your edit.',
      ),
    ).toBeTruthy();
  });

  it('lists at most eight page titles and states the remainder', () => {
    render(<RenameLinksHost />);
    void ask({
      pages: Array.from({ length: 10 }, (_, index) => ({
        path: `${index}.md`,
        title: `Page ${index}`,
        count: 1,
      })),
    });
    expect(screen.getByText('Page 7')).toBeTruthy();
    expect(screen.queryByText('Page 8')).toBeNull();
    expect(screen.getByText('and 2 more')).toBeTruthy();
  });

  it('names refused text and source pointers, and offers Rename anyway when nothing updates', async () => {
    render(<RenameLinksHost />);
    const result = ask({
      refused: [
        { path: 'knowledge/a.md', title: 'Concept', count: 1 },
        { path: 'knowledge/b.md', title: 'Other', count: 2 },
      ],
      sources: [{ path: 'knowledge/a.md', title: 'Concept', resource: 'notes/before.md' }],
    });
    expect(screen.queryByTestId('rename-links-summary')).toBeNull();
    expect(screen.getByText('Concept — 1 link in its text')).toBeTruthy();
    expect(screen.getByText('Other — 2 links in its text')).toBeTruthy();
    expect(screen.getByText('Concept — its source still names notes/before.md')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rename anyway' }));
    expect(await result).toBe(true);
  });

  it('Escape cancels through the dialog layer', async () => {
    render(<RenameLinksHost />);
    const result = ask();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await result).toBe(false);
  });

  it('a vault change cancels the pending request and hides the prompt', async () => {
    render(<RenameLinksHost />);
    const result = ask();
    act(() => useVaultStore.setState({ vaultPath: '/other' }));
    expect(await result).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('unmounting settles a pending request as cancelled', async () => {
    const { unmount } = render(<RenameLinksHost />);
    const result = ask();
    unmount();
    expect(await result).toBe(false);
  });
});

it.each([1, 2])(
  'names %i whiteboards and every filename without counting duplicate cards twice',
  (count) => {
    render(<RenameLinksHost />);
    const sources = Array.from({ length: count }, (_, i) => ({
      path: `boards/${i}.canvas`,
      title: `Board ${i}`,
      resource: 'old',
      board: true as const,
    }));
    void ask({ fromPath: 'notes/old.md', sources: [...sources, sources[0]] });
    expect(screen.getByTestId('rename-links-boards').textContent).toContain(
      `${count} ${count === 1 ? 'whiteboard keeps' : 'whiteboards keep'} cards pointing at notes/old.md.`,
    );
    for (const source of sources) expect(screen.getByText(source.path)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rename anyway' })).toBeTruthy();
  },
);
