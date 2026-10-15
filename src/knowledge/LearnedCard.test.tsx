import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { LearnedCard } from './LearnedCard';
import { useDoneMarksStore } from '@/stores/doneMarksStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { resetMockFs } from '@/lib/mockIpc';
vi.mock('@/pages/HomePage', () => ({ SECTION_HEADING: '' }));
vi.mock('@/stores/ledgerStore', () => ({ useLedgerReview: () => ({}), useQuarantine: () => ({}) }));
vi.mock('@/engine/okf', () => ({
  listConcepts: () => [
    {
      entry: { path: 'knowledge/concept.md' },
      title: 'Useful idea',
      description: null,
      review: 'unreviewed',
    },
  ],
  recentlyLearned: (concepts: unknown[]) => concepts,
}));
beforeEach(() => {
  localStorage.clear();
  resetMockFs();
  useUiStore.setState({ dismissedInsights: [] });
  useVaultStore.setState({ vaultPath: '/learned', entriesVault: '/learned', entries: [] });
  useDoneMarksStore.getState().reset('/learned');
});
it('renders nothing while loading and holds back cards on a failed read', () => {
  useVaultStore.setState({ entriesVault: '/old' });
  useDoneMarksStore.setState({ status: 'loading' });
  const view = render(<LearnedCard />);
  expect(screen.queryByTestId('learned-card')).toBeNull();
  act(() => useDoneMarksStore.setState({ status: 'error' }));
  view.rerender(<LearnedCard />);
  expect(screen.getByTestId('section-unavailable').textContent).toContain(
    'What you dismissed here could not be read, so these are held back.',
  );
  expect(screen.queryByText('Useful idea')).toBeNull();
});
it('dismisses forever in the durable store and keeps it after hydration', async () => {
  useDoneMarksStore.setState({ status: 'ready' });
  const view = render(<LearnedCard />);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss Useful idea' }));
  await waitFor(() => expect(screen.queryByText('Useful idea')).toBeNull());
  expect(useDoneMarksStore.getState().isDone('insight', 'knowledge/concept.md')).toBe(true);
  view.unmount();
  useDoneMarksStore.getState().reset('/learned');
  render(<LearnedCard />);
  await waitFor(() => expect(useDoneMarksStore.getState().status).toBe('ready'));
  expect(screen.queryByText('Useful idea')).toBeNull();
});
