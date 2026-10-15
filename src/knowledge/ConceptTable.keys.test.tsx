import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { toConcept, reviewQueue } from '@/engine/okf';
import { makeEntry } from '@/engine/testHelpers';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import * as review from './ReviewQueue';
import { ConceptTable, ReviewQueueList } from './ConceptTable';

vi.mock('./ReviewQueue', { spy: true });
const concepts = ['a', 'b', 'c'].map((name) =>
  toConcept(makeEntry({ path: `knowledge/${name}/idea.md`, title: name }), '2026-10-15'),
);
const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
beforeEach(() => {
  vi.clearAllMocks();
  useVaultStore.setState({ entries: concepts.map((concept) => concept.entry) });
  useUiStore.setState({ collapsed: { 'knowledge:concepts': { a: true } } });
  useNavStore.setState({ selection: { kind: 'knowledge', nav: { tab: 'all' } } });
});
afterEach(cleanup);

it('skips collapsed bands and Enter runs the drawn concept row', () => {
  render(
    <ConceptTable
      sections={concepts.map((concept) => ({
        folder: concept.title,
        label: concept.title,
        concepts: [concept],
      }))}
      queue={[]}
    />,
  );
  expect(screen.getAllByTestId('concept-row')).toHaveLength(2);
  press('j');
  expect(document.activeElement?.getAttribute('data-path')).toBe(concepts[1].entry.path);
  press('j');
  expect(document.activeElement?.getAttribute('data-path')).toBe(concepts[2].entry.path);
  press('Enter');
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: concepts[2].entry.path });
  expect(review.startWholeQueueWalk).not.toHaveBeenCalled();
});

it('a queue row starts the review walk before opening its page', () => {
  const queue = reviewQueue(concepts);
  expect(queue.length).toBeGreaterThan(0);
  render(<ReviewQueueList queue={queue} />);
  press('j');
  press('Enter');
  expect(review.startWholeQueueWalk).toHaveBeenCalledOnce();
  expect(useNavStore.getState().selection).toEqual({
    kind: 'doc',
    path: queue[0].concept.entry.path,
  });
});
