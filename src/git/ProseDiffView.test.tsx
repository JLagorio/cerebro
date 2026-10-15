// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_BLOCKS, TOO_LARGE_TO_READ } from '@/engine/proseDiff';
import { ProseDiffView } from '@/git/ProseDiffView';

const paragraphs = (n: number) =>
  Array.from({ length: n }, (_, k) => `Paragraph number ${k} stays as it was.`);

describe('ProseDiffView', () => {
  afterEach(cleanup);

  it('marks the words a version took out and put in', () => {
    render(
      <ProseDiffView
        before={'# Plan\n\nWe ship on Thursdays.\n'}
        after={'# Plan\n\nWe ship on Fridays.\n'}
      />,
    );
    expect(screen.getByTestId('prose-summary').textContent).toBe('Changed 1 block.');
    expect(screen.getAllByTestId('prose-del').map((d) => d.textContent?.trim())).toEqual([
      'Thursdays.',
    ]);
    expect(screen.getAllByTestId('prose-ins').map((d) => d.textContent?.trim())).toEqual([
      'Fridays.',
    ]);
    const changed = screen.getAllByTestId('prose-block').find((b) => b.dataset.op === 'changed');
    expect(changed?.dataset.kind).toBe('paragraph');
  });

  it('keeps one block of context and folds a longer unchanged run', () => {
    const body = paragraphs(6);
    const after = [...body.slice(0, 5), 'The last paragraph, rewritten entirely.'];
    render(<ProseDiffView before={body.join('\n\n')} after={after.join('\n\n')} />);
    const shown = screen.getAllByTestId('prose-block');
    // Paragraph 4 is the context; 0 to 3 fold.
    expect(shown.map((b) => b.dataset.op)).toEqual(['same', 'removed', 'added']);
    const fold = screen.getByTestId('prose-unchanged');
    expect(fold.textContent).toBe('Show 4 unchanged blocks');
    fireEvent.click(fold);
    expect(screen.getAllByTestId('prose-block')).toHaveLength(7);
    expect(screen.queryByTestId('prose-unchanged')).toBeNull();
  });

  it('groups changed properties under their own heading', () => {
    render(
      <ProseDiffView
        before={'---\nstatus: todo\nowner: ana\n---\n\n# Plan\n'}
        after={'---\nstatus: done\nowner: ana\n---\n\n# Plan\n'}
      />,
    );
    const group = screen.getByTestId('prose-properties');
    expect(group.textContent).toContain('Properties');
    expect(group.querySelectorAll('[data-testid="prose-block"]')).toHaveLength(1);
    expect(screen.getByTestId('prose-summary').textContent).toBe('1 property changed.');
  });

  it('says a change too large to read as prose', () => {
    const many = paragraphs(MAX_BLOCKS + 1).join('\n\n');
    render(<ProseDiffView before="# Plan\n" after={many} />);
    expect(screen.getByTestId('prose-summary').textContent).toBe(TOO_LARGE_TO_READ);
    expect(screen.queryByTestId('prose-block')).toBeNull();
  });

  it('renders page text as text, never as markup', () => {
    render(<ProseDiffView before={null} after={'<img src=x onerror="boom()"> hello\n'} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByTestId('prose-summary').textContent).toBe('This version created the page.');
  });
});
