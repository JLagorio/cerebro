// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageAttribution } from '@/engine/attribution';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';
import { LastChange } from './LastChange';

const pageAttribution = vi.fn<(vault: string, path: string) => Promise<PageAttribution>>();

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return {
    ...actual,
    pageAttribution: (vault: string, path: string) => pageAttribution(vault, path),
  };
});

const scout = makeEntry({
  path: 'records/agents/release-scout.md',
  title: 'Release scout',
  type: 'Agent',
  properties: { description: 'Watches releases.', tools: 'safe' },
});
const page = makeEntry({ path: 'records/risks/a.md', title: 'A', hash: 'a'.repeat(64) });
const at = () => new Date(Date.now() - 2 * 3_600_000).toISOString();

afterEach(cleanup);

beforeEach(() => {
  pageAttribution.mockReset();
  useVaultStore.setState({ vaultPath: '/vault', entries: [scout, page] });
});

async function line(): Promise<HTMLElement> {
  return screen.findByTestId('last-change-line');
}

describe('LastChange (M58.1b)', () => {
  // The Info section's "Changed by" value: who and when; the sentence it
  // stands for is its tooltip.
  it('names you for your own save', async () => {
    pageAttribution.mockResolvedValue({
      state: 'recorded',
      kind: 'vault.write',
      actor: 'human:me',
      run_id: null,
      approved_by: null,
      at: at(),
    });
    render(<LastChange entry={page} />);
    const el = await line();
    expect(el.textContent).toBe('You · 2 hours ago');
    expect(el.title).toBe('Last changed by You · 2 hours ago');
    expect(pageAttribution).toHaveBeenCalledWith('/vault', 'records/risks/a.md');
  });

  it("names an agent's write, and that you allowed it", async () => {
    pageAttribution.mockResolvedValue({
      state: 'recorded',
      kind: 'vault.write',
      actor: 'process:release-scout',
      run_id: 'run-1',
      approved_by: 'human:me',
      at: at(),
    });
    render(<LastChange entry={page} />);
    const el = await line();
    expect(el.textContent).toBe('Release scout · 2 hours ago · you allowed it');
    expect(el.dataset.actor).toBe('process:release-scout');
  });

  it('says an outside change is unattributed', async () => {
    pageAttribution.mockResolvedValue({
      state: 'unattributed',
      kind: 'vault.write',
      actor: 'claude-code',
      run_id: 'run-2',
      approved_by: null,
      at: at(),
    });
    render(<LastChange entry={page} />);
    const el = await line();
    expect(el.dataset.state).toBe('unattributed');
    expect(el.textContent).toBe('Outside Cerebro · unattributed');
    expect(el.title).toBe(
      'Changed outside Cerebro since Assistant wrote it 2 hours ago — unattributed',
    );
  });

  it('says when nothing was recorded, and when Knowledge changed it', async () => {
    pageAttribution.mockResolvedValue({ state: 'not_recorded' });
    render(<LastChange entry={page} />);
    expect((await line()).textContent).toBe('Not recorded');
    expect((await line()).title).toBe('Who changed this page was not recorded');
    cleanup();
    pageAttribution.mockResolvedValue({ state: 'knowledge' });
    render(<LastChange entry={page} />);
    expect((await line()).textContent).toBe('Knowledge');
    expect((await line()).title).toBe('Changed through Knowledge');
  });

  it('reads again when the page bytes change', async () => {
    pageAttribution.mockResolvedValue({ state: 'not_recorded' });
    const { rerender } = render(<LastChange entry={page} />);
    await line();
    expect(pageAttribution).toHaveBeenCalledTimes(1);
    rerender(<LastChange entry={{ ...page, title: 'Renamed in place' }} />);
    expect(pageAttribution).toHaveBeenCalledTimes(1);
    pageAttribution.mockResolvedValue({
      state: 'recorded',
      kind: 'vault.write',
      actor: 'human:me',
      run_id: null,
      approved_by: null,
      at: at(),
    });
    rerender(<LastChange entry={{ ...page, hash: 'b'.repeat(64) }} />);
    await waitFor(() =>
      expect(screen.getByTestId('last-change-line').textContent).toBe('You · 2 hours ago'),
    );
    expect(pageAttribution).toHaveBeenCalledTimes(2);
  });

  it('a failed read is unavailable, never not recorded', async () => {
    pageAttribution.mockRejectedValue(new Error('no runtime database'));
    render(<LastChange entry={page} />);
    expect(await screen.findByTestId('section-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('last-change-line')).toBeNull();
    expect(screen.getByTestId('last-change').textContent).not.toContain('not recorded');
  });

  it('asks nothing without a vault', () => {
    useVaultStore.setState({ vaultPath: null });
    render(<LastChange entry={page} />);
    expect(pageAttribution).not.toHaveBeenCalled();
    expect(screen.queryByTestId('last-change')).toBeNull();
  });
});
