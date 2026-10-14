import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/agent/agentIpc', () => ({
  agentWorkspace: vi.fn(),
  purgeAgentWorkspace: vi.fn(),
}));

import * as agentIpc from '@/agent/agentIpc';
import type { CliWorkspace } from '@/agent/types';
import { CliWorkspaceRow } from './CliWorkspaceRow';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

/**
 * M56.11 — the row names the folder Claude Code keeps for this vault, counts
 * every session file in it, says when that count is only a floor, and never
 * offers to clear a folder every project shares.
 */
const PATH = '/home/me/.claude/projects/-vault';

const workspace = (over: Partial<CliWorkspace> = {}): CliWorkspace => ({
  path: PATH,
  exists: true,
  sessions: 2,
  sessionFiles: 7,
  bytes: 2_400_000,
  memoryFiles: 0,
  unreadable: 0,
  shared: false,
  ...over,
});

const read = vi.mocked(agentIpc.agentWorkspace);
const purge = vi.mocked(agentIpc.purgeAgentWorkspace);
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);

describe('CliWorkspaceRow', () => {
  beforeEach(() => {
    read.mockReset();
    purge.mockReset();
    useVaultStore.setState({ vaultPath: '/vault', status: 'ready', error: null });
    useUiStore.setState({ toasts: [] });
  });

  it('counts sessions, their files and their size, and shows the path', async () => {
    read.mockResolvedValue(workspace());
    render(<CliWorkspaceRow />);
    expect((await screen.findByTestId('cli-workspace-counts')).textContent).toBe(
      '2 sessions in 7 files, 2.4 MB',
    );
    expect(screen.getByTestId('cli-workspace-path').textContent).toBe(PATH);
    expect(screen.getByTestId('cli-workspace').textContent).toContain(
      "With each session it also keeps its subagents' transcripts",
    );
    expect(read).toHaveBeenCalledWith('/vault');
  });

  it('says one session in one file in the singular', async () => {
    read.mockResolvedValue(workspace({ sessions: 1, sessionFiles: 1, bytes: 3_000 }));
    render(<CliWorkspaceRow />);
    expect((await screen.findByTestId('cli-workspace-counts')).textContent).toBe(
      '1 session in 1 file, 3 KB',
    );
  });

  it('names the memory files when there are any', async () => {
    read.mockResolvedValue(workspace({ memoryFiles: 2 }));
    render(<CliWorkspaceRow />);
    await screen.findByTestId('cli-workspace-counts');
    expect(screen.getByTestId('cli-workspace').textContent).toContain(', plus 2 memory files');
  });

  it('leaves out the memory phrase when there are none', async () => {
    read.mockResolvedValue(workspace());
    render(<CliWorkspaceRow />);
    await screen.findByTestId('cli-workspace-counts');
    expect(screen.getByTestId('cli-workspace').textContent).not.toContain('memory file');
  });

  it('says the counts are a floor only when something could not be read', async () => {
    read.mockResolvedValue(workspace({ unreadable: 3 }));
    render(<CliWorkspaceRow />);
    expect((await screen.findByTestId('cli-workspace-floor')).textContent).toBe(
      '3 items could not be read, so these counts are a floor.',
    );
    cleanup();
    read.mockResolvedValue(workspace());
    render(<CliWorkspaceRow />);
    await screen.findByTestId('cli-workspace-counts');
    expect(screen.queryByTestId('cli-workspace-floor')).toBeNull();
  });

  it('offers no clear for a folder every project shares', async () => {
    read.mockResolvedValue(workspace({ shared: true }));
    render(<CliWorkspaceRow />);
    expect((await screen.findByTestId('cli-workspace-shared')).textContent).toContain(
      "so Cerebro won't clear it.",
    );
    expect(screen.queryByRole('button', { name: 'Clear history' })).toBeNull();
  });

  it('renders nothing when the folder does not exist', async () => {
    read.mockResolvedValue(workspace({ exists: false }));
    const { container } = render(<CliWorkspaceRow />);
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('clears on confirmation, toasts the count and refreshes', async () => {
    read.mockResolvedValueOnce(workspace()).mockResolvedValue(workspace({ exists: false }));
    purge.mockResolvedValue(9);
    render(<CliWorkspaceRow />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear it' }));
    await waitFor(() => expect(toasts()).toContain('Cleared 9 file(s)'));
    expect(purge).toHaveBeenCalledWith('/vault');
    await waitFor(() => expect(screen.queryByTestId('cli-workspace')).toBeNull());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('after a failed clear, toasts and shows what is left', async () => {
    read
      .mockResolvedValueOnce(workspace())
      .mockResolvedValue(workspace({ sessions: 1, sessionFiles: 3 }));
    purge.mockRejectedValue(new Error('Permission denied'));
    render(<CliWorkspaceRow />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear it' }));
    await waitFor(() =>
      expect(toasts()).toContain("Couldn't clear the assistant's stored history"),
    );
    await waitFor(() =>
      expect(screen.getByTestId('cli-workspace-counts').textContent).toBe(
        '1 session in 3 files, 2.4 MB',
      ),
    );
    expect(read).toHaveBeenCalledTimes(2);
  });
});
