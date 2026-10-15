// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const { getFilePatch } = vi.hoisted(() => ({
  getFilePatch: vi.fn(async () => ({
    text: 'diff --git a/notes/a.md b/notes/a.md\n@@ -1 +1,2 @@\n # A\n+More.\n',
    truncated: false,
    binary: false,
  })),
}));
vi.mock('@/lib/gitIpc', () => ({ getFilePatch }));

import { TurnChangeset } from './TurnChangeset';
import type { RunChangeset } from '@/engine/changeset';
import { useVaultStore } from '@/stores/vaultStore';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

const committed: RunChangeset = {
  state: 'committed',
  run_id: 'run-1',
  commit: COMMIT,
  files: [
    {
      path: 'notes/a.md',
      previous_path: null,
      kind: 'modified',
      additions: 2,
      deletions: 1,
      also_by: ['human:me'],
    },
    {
      path: 'notes/b.md',
      previous_path: null,
      kind: 'added',
      additions: 1,
      deletions: 0,
      also_by: [],
    },
  ],
  additions: 3,
  deletions: 1,
  binary: 0,
  shell_unrecorded: false,
};

beforeEach(() => {
  getFilePatch.mockClear();
  useVaultStore.setState({ vaultPath: '/v', entries: [] });
});
afterEach(cleanup);

const fileRow = (path: string) =>
  screen.getAllByTestId('turn-changeset-file').find((row) => row.textContent?.includes(path)) as
    HTMLElement | undefined;

describe('TurnChangeset (M58.3)', () => {
  it('reads the commit as files and line counts, and names who else edited', () => {
    render(<TurnChangeset changesets={[committed]} />);
    const footer = screen.getByTestId('turn-changeset');
    expect(footer?.textContent).toContain('Changed 2 files · +3 −1');
    expect(footer?.textContent).toContain('0123456');
    expect(screen.getAllByTestId('turn-changeset-file')).toHaveLength(2);
    expect(fileRow('notes/a.md')?.textContent).toContain('+2 −1');
    expect(fileRow('notes/a.md')?.textContent).toContain('also edited by you');
    expect(fileRow('notes/b.md')?.textContent).not.toContain('also edited');
  });

  it('fetches nothing until a file is expanded, then exactly once', async () => {
    render(<TurnChangeset changesets={[committed]} />);
    expect(getFilePatch).not.toHaveBeenCalled();
    const toggle = within(fileRow('notes/a.md') as HTMLElement).getByRole('button', {
      name: /notes\/a\.md/,
    });
    fireEvent.click(toggle);
    expect((await screen.findByTestId('turn-changeset-patch')).textContent).toContain('+More.');
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(getFilePatch).toHaveBeenCalledExactlyOnceWith('/v', 'notes/a.md', COMMIT);
  });

  it('says when a patch was cut at 2 MB', async () => {
    getFilePatch.mockResolvedValueOnce({
      text: '@@ -1 +1 @@\n+x\n',
      truncated: true,
      binary: false,
    });
    render(<TurnChangeset changesets={[committed]} />);
    fireEvent.click(
      within(fileRow('notes/a.md') as HTMLElement).getByRole('button', { name: /notes\/a\.md/ }),
    );
    expect(await screen.findByText('Showing the first 2 MB.')).toBeTruthy();
  });

  it('reads a failed load as unavailable, never as an empty patch', async () => {
    getFilePatch.mockRejectedValueOnce(new Error('bad revision'));
    render(<TurnChangeset changesets={[committed]} />);
    fireEvent.click(
      within(fileRow('notes/a.md') as HTMLElement).getByRole('button', { name: /notes\/a\.md/ }),
    );
    expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
      "This file's changes could not be read.",
    );
    expect(screen.queryByTestId('turn-changeset-patch')).toBeNull();
  });

  it('opens View diff on the run’s commit', () => {
    const onViewDiff = vi.fn();
    render(<TurnChangeset changesets={[committed]} onViewDiff={onViewDiff} />);
    fireEvent.click(screen.getByTestId('turn-changeset-view-diff'));
    expect(onViewDiff).toHaveBeenCalledWith('notes/a.md', COMMIT);
    fireEvent.click(screen.getByRole('button', { name: 'View diff of notes/b.md' }));
    expect(onViewDiff).toHaveBeenLastCalledWith('notes/b.md', COMMIT);
  });

  it('reads a binary file as binary, with nothing to expand', () => {
    render(
      <TurnChangeset
        changesets={[
          {
            ...committed,
            files: [{ ...committed.files[0], path: 'logo.png', additions: null, deletions: null }],
            additions: null,
            deletions: null,
            binary: 1,
          } as RunChangeset,
        ]}
      />,
    );
    expect(screen.getByTestId('turn-changeset')?.textContent).toContain(
      'Changed 1 file · 1 binary',
    );
    const row = fileRow('logo.png') as HTMLElement;
    expect(row?.textContent).toContain('binary');
    expect(within(row).queryByRole('button', { expanded: false })).toBeNull();
  });

  it('words a turn whose changes were not recorded, had no history, or failed', () => {
    const { rerender } = render(
      <TurnChangeset
        changesets={[{ state: 'not_recorded', run_id: null, reason: 'no id', files: [] }]}
      />,
    );
    expect(screen.getByTestId('turn-changeset')?.textContent).toContain(
      'Changes not recorded for this turn.',
    );
    rerender(
      <TurnChangeset
        onViewDiff={vi.fn()}
        changesets={[
          { state: 'not_a_repo', run_id: 'r', files: ['notes/a.md'], shell_unrecorded: false },
        ]}
      />,
    );
    const footer = screen.getByTestId('turn-changeset');
    expect(footer?.textContent).toContain('Changed 1 file');
    expect(footer?.textContent).toContain('Line counts and diffs need History for this vault.');
    expect(screen.queryByTestId('turn-changeset-view-diff')).toBeNull();
    rerender(
      <TurnChangeset
        changesets={[
          {
            state: 'unavailable',
            run_id: 'r',
            reason: 'History was busy',
            files: ['notes/a.md'],
            shell_unrecorded: false,
          },
        ]}
      />,
    );
    expect(screen.getByTestId('turn-changeset')?.textContent).toContain(
      "Couldn't commit this turn's changes: History was busy.",
    );
    expect(fileRow('notes/a.md')).toBeDefined();
  });

  it('says shell changes are not recorded, and says nothing for a run that changed nothing', () => {
    const { rerender } = render(
      <TurnChangeset changesets={[{ ...committed, shell_unrecorded: true } as RunChangeset]} />,
    );
    expect(screen.getByTestId('turn-changeset')?.textContent).toContain(
      "Shell commands this run ran may have changed other files; those aren't recorded here.",
    );
    rerender(
      <TurnChangeset changesets={[{ state: 'nothing', run_id: 'r', shell_unrecorded: true }]} />,
    );
    expect(screen.getByTestId('turn-changeset')?.textContent).toContain('Shell commands');
    rerender(
      <TurnChangeset changesets={[{ state: 'nothing', run_id: 'r', shell_unrecorded: false }]} />,
    );
    expect(screen.queryByTestId('turn-changeset')).toBeNull();
  });
});
