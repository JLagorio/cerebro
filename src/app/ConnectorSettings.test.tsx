import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    readConnectors: vi.fn(async () => ''),
    saveConnectors: vi.fn(async () => undefined),
  };
});

import { ConnectorSettings } from './ConnectorSettings';
import * as ipc from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

describe('ConnectorSettings stdio approval surface', () => {
  beforeEach(() => {
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ stdioApprovals: {} });
  });

  afterEach(() => {
    cleanup();
    vi.mocked(ipc.readConnectors).mockReset();
  });

  it('shows the env pairs beside the command — approving means approving BOTH', async () => {
    // What Approve covers is name+command+args+env (the fingerprint); an env
    // value the user cannot see would make that consent hollow (PR #5
    // security review).
    vi.mocked(ipc.readConnectors).mockResolvedValue(
      JSON.stringify({
        servers: {
          linear: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@linear/mcp'],
            env: { API_KEY: 'sekrit' },
            enabled: true,
          },
        },
      }),
    );
    render(<ConnectorSettings />);
    expect(await screen.findByText('API_KEY=sekrit npx -y @linear/mcp')).toBeTruthy();
    expect(screen.getByText('runs a local command')).toBeTruthy();
    expect(screen.getByText('Approve')).toBeTruthy();
  });

  it('approving stores a digest — the secret never reaches the ledger', async () => {
    // The ledger persists to localStorage, so what Approve records must be
    // the approval KEY, not the env-bearing fingerprint (PR #5 security
    // review round 7).
    vi.mocked(ipc.readConnectors).mockResolvedValue(
      JSON.stringify({
        servers: {
          linear: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@linear/mcp'],
            env: { API_KEY: 'sekrit' },
            enabled: true,
          },
        },
      }),
    );
    render(<ConnectorSettings />);
    fireEvent.click(await screen.findByText('Approve'));
    const ledger = useUiStore.getState().stdioApprovals['/vault'];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(useUiStore.getState().stdioApprovals)).not.toContain('sekrit');
  });

  it('an http connector still shows its url', async () => {
    vi.mocked(ipc.readConnectors).mockResolvedValue(
      JSON.stringify({
        servers: { jira: { transport: 'http', url: 'https://jira/mcp', enabled: true } },
      }),
    );
    render(<ConnectorSettings />);
    expect(await screen.findByText('https://jira/mcp')).toBeTruthy();
    expect(screen.queryByText('Approve')).toBeNull();
  });

  it('a blocked read says BLOCKED — never "no explicit list"', async () => {
    // read_connectors rejects when the file exists but cannot be read — a
    // symlinked .cerebro the backend refuses, permissions (PR #5 review).
    // Runs fail closed on that config, so rendering the editable empty
    // state here would claim legacy open mode while runs are pinned to
    // zero connectors.
    vi.mocked(ipc.readConnectors).mockRejectedValue(
      new Error('.cerebro is a symlink; cerebro refuses to follow it outside the vault'),
    );
    render(<ConnectorSettings />);
    expect(await screen.findByTestId('connector-settings-blocked')).toBeTruthy();
    expect(screen.getByText(/refuses to follow it outside the vault/)).toBeTruthy();
    // The editable surface must not render: adding a row would write
    // through the very path the backend just refused to read.
    expect(screen.queryByTestId('connector-settings')).toBeNull();
    expect(screen.queryByText('Add')).toBeNull();

    // Retry re-reads; a now-healthy config swaps the warning for the list.
    vi.mocked(ipc.readConnectors).mockResolvedValue(
      JSON.stringify({
        servers: { jira: { transport: 'http', url: 'https://jira/mcp', enabled: true } },
      }),
    );
    fireEvent.click(screen.getByText('Retry'));
    expect(await screen.findByText('https://jira/mcp')).toBeTruthy();
    expect(screen.queryByTestId('connector-settings-blocked')).toBeNull();
  });
});
