import { navSeed } from '@/test/navSeed';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { NotePathContext } from './notePath';
import { SubPageList } from './SubPageList';

const ROCKET = '\u{1F680}';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

const renderOn = (path: string | null) =>
  render(
    <NotePathContext.Provider value={path}>
      <SubPageList />
    </NotePathContext.Provider>,
  );

describe('SubPageList (M55.13)', () => {
  beforeEach(async () => {
    resetMockFs();
    fs().set('plan/plan.md', '# Plan\n');
    fs().set('plan/goals.md', `---\nicon: ${ROCKET}\n---\n# Goals\n`);
    fs().set('plan/rollout/rollout.md', '# Rollout\n');
    fs().set('plan/rollout/checklist.md', '# Checklist\n');
    fs().set('lonely.md', '# Lonely\n');
    await useVaultStore.getState().openVault('/demo-vault');
    useNavStore.setState({ selection: { kind: 'home' }, history: [navSeed({ kind: 'home' })] });
  });
  afterEach(cleanup);

  it('lists the page’s children with their icons, a grown child included', () => {
    renderOn('plan/plan.md');
    const rows = screen.getAllByTestId('sub-page-row');
    expect(rows.map((r) => r.textContent?.replace(ROCKET, ''))).toEqual(
      expect.arrayContaining(['Goals', 'Rollout']),
    );
    expect(rows).toHaveLength(2);
    const goals = rows.find((r) => r.textContent?.includes('Goals'))!;
    expect(within(goals).getByRole('img', { name: ROCKET })).toBeTruthy();
    // Read-only: the editor never takes it for text.
    expect(screen.getByTestId('sub-page-list').getAttribute('contenteditable')).toBe('false');
  });

  it('follows the store live', async () => {
    renderOn('plan/plan.md');
    fs().set('plan/later.md', '# Later\n');
    await act(() => useVaultStore.getState().rescan());
    expect(screen.getAllByTestId('sub-page-row').map((r) => r.textContent)).toContain('Later');
  });

  it('has an empty face, and a face for a page with no file', () => {
    renderOn('lonely.md');
    expect(screen.getByTestId('sub-page-list').textContent).toBe(
      'No sub-pages yet — add one from the page menu.',
    );
    cleanup();
    renderOn(null);
    expect(screen.getByTestId('sub-page-list').textContent).toBe('Sub-pages show on a saved page.');
  });

  it('opens a child through the app’s open rule', () => {
    renderOn('plan/plan.md');
    const rollout = screen.getAllByTestId('sub-page-row').find((r) => r.textContent === 'Rollout')!;
    fireEvent.click(rollout);
    expect(useNavStore.getState().selection).toEqual({
      kind: 'doc',
      path: 'plan/rollout/rollout.md',
    });
  });
});
