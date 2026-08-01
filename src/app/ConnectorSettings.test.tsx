import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

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
});
