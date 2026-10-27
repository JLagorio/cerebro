// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { AgentProperties } from './AgentProperties';

const agent = makeEntry({
  path: 'agents/scout.md',
  type: 'Agent',
  title: 'Scout',
  properties: {
    connectors: ['kept'],
    'allowed-tools': ['search_notes', 'mcp__unknown__kept'],
  } as never,
});
const configuration = (name: string) =>
  JSON.stringify({
    servers: { [name]: { transport: 'http', url: 'https://example.test/mcp', enabled: true } },
  });
const patch = vi.fn(async () => true);

function open(key: string) {
  fireEvent.click(within(screen.getByTestId(`agent-prop-${key}`)).getByTestId('agent-prop-open'));
  return screen.getByTestId(`agent-editor-${key}`);
}

beforeEach(() => {
  patch.mockClear();
  useVaultStore.setState({ vaultPath: '/one', entries: [agent], patchFrontmatter: patch });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Agent connector inventory', () => {
  it('agent_connector_read_failure_is_unavailable', async () => {
    vi.spyOn(ipc, 'readConnectors').mockRejectedValue(new Error('read failed'));
    render(<AgentProperties entry={agent} />);
    const editor = open('connectors');
    await waitFor(() =>
      expect(screen.getByTestId('agent-connector-inventory').textContent).toContain('unavailable'),
    );
    expect(within(editor).queryByText(/This vault has no connectors enabled/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry connectors' })).toBeTruthy();
    expect(within(editor).getByText('kept')).toBeTruthy();
    expect(within(editor).queryByText(/not something this vault has/)).toBeNull();
    expect(within(editor).getByTestId('picker-chip').title).not.toContain('will do nothing');
    expect(patch).not.toHaveBeenCalled();
  });

  it('agent_connector_retry_preserves_grant_draft', async () => {
    vi.spyOn(ipc, 'readConnectors')
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(configuration('available'));
    render(<AgentProperties entry={agent} />);
    const editor = open('tools');
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove search_notes' }));
    const retry = await screen.findByRole('button', { name: 'Retry connectors' });
    expect(within(editor).queryByText(/not something this vault has/)).toBeNull();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Retry connectors' })).toBeNull(),
    );
    expect(screen.getByTestId('agent-editor-tools')).toBe(editor);
    expect(within(editor).queryByRole('button', { name: 'Remove search_notes' })).toBeNull();
    expect(within(editor).getByRole('button', { name: 'Remove mcp__unknown__kept' })).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(within(editor).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(agent.path, { 'allowed-tools': ['mcp__unknown__kept'] }),
    );
  });

  it('distinguishes malformed configuration from a failed read without exposing bytes', async () => {
    vi.spyOn(ipc, 'readConnectors').mockResolvedValue('{private-token');
    render(<AgentProperties entry={agent} />);
    expect(await screen.findByText(/configuration could not be parsed/)).toBeTruthy();
    expect(screen.queryByText(/private-token/)).toBeNull();
  });

  it('agent_connector_response_cannot_cross_vault', async () => {
    let finishOld!: (raw: string) => void;
    vi.spyOn(ipc, 'readConnectors')
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValue(configuration('new-vault'));
    render(<AgentProperties entry={agent} />);
    open('connectors');
    act(() => useVaultStore.setState({ vaultPath: '/two' }));
    await waitFor(() => expect(ipc.readConnectors).toHaveBeenCalledWith('/two'));
    await act(async () => finishOld(configuration('old-vault')));
    fireEvent.click(within(screen.getByTestId('agent-connectors')).getByTestId('picker-add'));
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId('picker-option')
          .some((row) => row.textContent?.includes('new-vault')),
      ).toBe(true),
    );
    expect(screen.queryByText('old-vault')).toBeNull();
  });
});
