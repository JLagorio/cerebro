// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MentionResults } from './MentionResults';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/engine/testHelpers';
import { useNavStore } from '@/stores/navStore';
import { returnToSourceOrigin } from '@/app/sourceOpen';
import type { OccurrencePage } from '@/engine/sourceOccurrences';
const { find, open, flags } = vi.hoisted(() => ({
  find: vi.fn(),
  open: vi.fn(),
  flags: { realOpen: false },
}));
vi.mock('@/lib/ipc', () => ({
  findSourceOccurrences: find,
  resolveSource: async (_vault: string, locator: unknown) => ({ status: 'exact', locator }),
}));
vi.mock('@/app/sourceOpen', async (original) => {
  const actual = await original<typeof import('@/app/sourceOpen')>();
  return {
    ...actual,
    useSourceNavigation: () => {
      const navigation = actual.useSourceNavigation();
      return {
        ...navigation,
        openSource: (request: Parameters<typeof navigation.openSource>[0]) => {
          open(request);
          return flags.realOpen
            ? navigation.openSource(request)
            : Promise.resolve({ kind: 'unchanged', pane: 'p1' });
        },
      };
    },
  };
});
const location = {
  version: 1 as const,
  vaultId: 'vault',
  path: 'source.md',
  sourceHash: 'a'.repeat(64),
  kind: 'body' as const,
  bodyUtf8Range: { start: 0, end: 10 },
  quote: '[[target]]',
  prefix: 'Before ',
  suffix: ' after.',
};
const ready = (rows = true, nextCursor: string | null = null): OccurrencePage => ({
  status: 'ready',
  snapshotId: 'snapshot',
  rows: rows ? [{ id: 'one', location, targetPath: 'target.md', via: 'body' }] : [],
  nextCursor,
  truncated: nextCursor !== null,
  counts: {
    shownOccurrences: rows ? 1 : 0,
    shownPages: rows ? 1 : 0,
    examinedSources: 1,
    cappedSources: 0,
    unavailableSources: 0,
    unsupportedSources: 0,
  },
});
beforeEach(() => {
  useVaultStore.setState({
    vaultPath: '/vault',
    entriesVault: '/vault',
    entries: [makeEntry({ path: 'target.md' }), makeEntry({ path: 'source.md', title: 'Source' })],
  });
  useNavStore.getState().reset();
  useNavStore.getState().navigate({ kind: 'doc', path: 'target.md' });
  find.mockReset().mockResolvedValue(ready());
  open.mockReset();
  flags.realOpen = false;
});
describe('contextual source occurrences', () => {
  it('Search mentions is explicit and opens the recorded occurrence', async () => {
    render(<MentionResults targetPath="target.md" mode="mention" />);
    expect(find).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Search mentions' }));
    fireEvent.click(await screen.findByRole('button', { name: /Before.*target.*after/ }));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        locator: location,
        origin: expect.objectContaining({ kind: 'Visit', vaultId: 'vault' }),
      }),
    );
    expect(screen.getByText('1 occurrence on 1 page')).not.toBeNull();
  });
  it('backlinks read once on opening and never read while inactive', async () => {
    const view = render(<MentionResults targetPath="target.md" mode="linked" active={false} />);
    expect(find).not.toHaveBeenCalled();
    view.rerender(<MentionResults targetPath="target.md" mode="linked" active />);
    await screen.findByText('1 occurrence on 1 page');
    expect(find).toHaveBeenCalledTimes(1);
  });
  it('corpus invalidation immediately drops all retained excerpts and requires Refresh', async () => {
    render(<MentionResults targetPath="target.md" mode="linked" />);
    await screen.findByText('1 occurrence on 1 page');
    act(() => useVaultStore.setState({ entries: [...useVaultStore.getState().entries] }));
    expect(screen.queryByText(/Before/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeNull();
    expect(find).toHaveBeenCalledTimes(1);
  });
  it('a zero-row bounded page offers continuation instead of claiming no matches', async () => {
    find.mockResolvedValue(ready(false, 'cursor'));
    render(<MentionResults targetPath="target.md" mode="linked" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue search' }));
    await waitFor(() =>
      expect(find).toHaveBeenLastCalledWith('/vault', 'target.md', 'linked', 'cursor'),
    );
    expect(screen.queryByText('No linked occurrences found.')).toBeNull();
    expect(screen.getByText(/Search is incomplete/)).not.toBeNull();
  });
  it('changed snapshot clears prior excerpts and a failed read is unavailable', async () => {
    find
      .mockResolvedValueOnce(ready(true, 'cursor'))
      .mockResolvedValueOnce({ status: 'changedSnapshot', reason: 'Changed.' });
    render(<MentionResults targetPath="target.md" mode="linked" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue search' }));
    await screen.findByText('Changed.');
    expect(screen.queryByText(/Before/)).toBeNull();
    find.mockRejectedValueOnce(new Error('read failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
      'Source discovery is unavailable.',
    );
  });
  it('returns to the actual originating visit with its explicit mention results intact', async () => {
    flags.realOpen = true;
    const view = render(<MentionResults targetPath="target.md" mode="mention" />);
    fireEvent.click(screen.getByRole('button', { name: 'Search mentions' }));
    fireEvent.click(await screen.findByTestId('source-occurrence-row'));
    await waitFor(() =>
      expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'source.md' }),
    );
    const request = open.mock.calls[0][0] as { requestId: string };
    view.unmount();
    await act(async () => {
      expect(await returnToSourceOrigin(request.requestId)).toBe('restored');
    });
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'target.md' });
    render(<MentionResults targetPath="target.md" mode="mention" />);
    expect(screen.queryByText('1 occurrence on 1 page')).not.toBeNull();
    expect(find).toHaveBeenCalledTimes(1);
  });
  it('revocation while the originating visit is unmounted removes cached text before return', async () => {
    const view = render(<MentionResults targetPath="target.md" mode="mention" />);
    fireEvent.click(screen.getByRole('button', { name: 'Search mentions' }));
    await screen.findByTestId('source-occurrence-row');
    view.unmount();
    act(() =>
      useVaultStore.setState({
        entries: useVaultStore.getState().entries.filter((entry) => entry.path !== 'source.md'),
      }),
    );
    render(<MentionResults targetPath="target.md" mode="mention" />);
    expect(screen.queryByText(/Before/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeNull();
    expect(find).toHaveBeenCalledTimes(1);
  });
  it('a late query cannot write its result into another visit held by the same component', async () => {
    let resolve!: (result: OccurrencePage) => void;
    find.mockImplementationOnce(
      () =>
        new Promise<OccurrencePage>((answer) => {
          resolve = answer;
        }),
    );
    render(<MentionResults targetPath="target.md" mode="mention" />);
    fireEvent.click(screen.getByRole('button', { name: 'Search mentions' }));
    act(() => {
      useNavStore.getState().navigate({ kind: 'doc', path: 'other.md' });
    });
    await act(async () => resolve(ready()));
    expect(screen.queryByText(/Before/)).toBeNull();
    const slot = useNavStore.getState().history.at(-1);
    expect(JSON.stringify(slot?.state) ?? '').not.toContain('[[target]]');
  });
  it('a late response after a same-path navigation roundtrip requires an explicit refresh', async () => {
    let resolve!: (result: OccurrencePage) => void;
    find.mockImplementationOnce(
      () =>
        new Promise<OccurrencePage>((answer) => {
          resolve = answer;
        }),
    );
    render(<MentionResults targetPath="target.md" mode="mention" />);
    fireEvent.click(screen.getByRole('button', { name: 'Search mentions' }));
    act(() => {
      useNavStore.getState().navigate({ kind: 'doc', path: 'other.md' });
      useNavStore.getState().back();
    });
    await act(async () => resolve(ready()));
    expect(screen.queryByText(/Before/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeNull();
  });
});

it('initial linked discovery survives StrictMode effect replay', async () => {
  render(
    <StrictMode>
      <MentionResults targetPath="target.md" mode="linked" />
    </StrictMode>,
  );
  expect(await screen.findByText('1 occurrence on 1 page')).not.toBeNull();
  expect(screen.queryByText('Search was interrupted. Refresh to search again.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
});

it('a real unmount interrupts an unfinished read and never revives its excerpts', async () => {
  let resolve!: (result: OccurrencePage) => void;
  find.mockImplementationOnce(
    () =>
      new Promise<OccurrencePage>((answer) => {
        resolve = answer;
      }),
  );
  const view = render(<MentionResults targetPath="target.md" mode="linked" />);
  await screen.findByRole('status');
  view.unmount();
  await act(async () => resolve(ready()));
  render(<MentionResults targetPath="target.md" mode="linked" />);
  expect(screen.queryByText(/Before/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeNull();
});

it('a same-turn real remount requires a fresh read and rejects the departing read', async () => {
  let finishDeparting!: (result: OccurrencePage) => void;
  find.mockImplementationOnce(
    () =>
      new Promise<OccurrencePage>((answer) => {
        finishDeparting = answer;
      }),
  );
  const departing = render(<MentionResults targetPath="target.md" mode="linked" />);
  await screen.findByRole('status');
  departing.unmount();
  render(<MentionResults targetPath="target.md" mode="linked" />);
  const refresh = await screen.findByRole('button', { name: 'Refresh' });
  const fresh = ready();
  if (fresh.status !== 'ready') throw new Error('fixture must be ready');
  fresh.rows[0] = {
    ...fresh.rows[0],
    location: { ...location, quote: 'fresh occurrence', prefix: '', suffix: '' },
  };
  find.mockResolvedValueOnce(fresh);
  fireEvent.click(refresh);
  await screen.findByText('fresh occurrence');
  await act(async () => finishDeparting(ready()));
  expect(screen.getByText('fresh occurrence')).not.toBeNull();
  expect(screen.queryByText(/Before/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
});
