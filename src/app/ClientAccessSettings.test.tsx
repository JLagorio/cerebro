import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
vi.mock('@/lib/ipc', { spy: true });
import * as ipc from '@/lib/ipc';
import { resetMockFs, __seedClientTokens } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { useClientAccessStore } from '@/stores/clientAccessStore';
import { ClientAccessSettings } from './ClientAccessSettings';
const vault = '/demo-vault';
const request = { name: 'Reader', toolsets: ['read'], readScope: null, writeScope: [] };
beforeEach(async () => {
  vi.restoreAllMocks();
  resetMockFs();
  localStorage.clear();
  useUiStore.setState({ toasts: [] });
  await useVaultStore.getState().openVault(vault);
  useClientAccessStore.getState().reset(vault);
});
afterEach(cleanup);
const ready = async () => {
  render(<ClientAccessSettings />);
  await screen.findByText('No app has a token yet.');
};
async function make(name = 'Claude Code') {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Make a token' }));
  await user.type(screen.getByRole('textbox', { name: 'Token name' }), name);
  await user.click(screen.getByRole('button', { name: 'Make token' }));
  return screen.findByRole('dialog', { name: 'Your token' });
}
describe('Other apps settings', () => {
  it('shows a secret once, copies both snippets, and never persists it', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(ipc, 'writeClipboard').mockResolvedValue();
    await ready();
    await user.click(screen.getByRole('switch', { name: 'Let other apps connect' }));
    await screen.findByText('Listening at http://127.0.0.1:37421/mcp.');
    expect(screen.getAllByTestId('client-snippet')[0].textContent).toContain('<your token>');
    const dialog = await make();
    const secret = within(dialog).getByTestId('client-token-secret').textContent!;
    expect(secret).toMatch(/^cbr_[0-9a-f]{64}$/);
    for (const label of ['Claude Code', 'Cursor and other apps']) {
      await user.click(within(dialog).getByRole('button', { name: `Copy ${label}` }));
      expect(copy.mock.calls.at(-1)?.[0]).toContain(secret);
    }
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    expect(copy).toHaveBeenLastCalledWith(secret);
    expect(JSON.stringify(localStorage)).not.toContain(secret);
    expect(JSON.stringify(useClientAccessStore.getState())).not.toContain(secret);
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(document.body.textContent).not.toContain(secret);
    expect(screen.getAllByTestId('client-snippet')[0].textContent).toContain('<your token>');
    expect(screen.getByTestId('client-token').textContent).toContain('Reads the whole vault');
  });
  it('requires write folders and preserves read-by-default', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Make a token' }));
    await user.type(screen.getByRole('textbox', { name: 'Token name' }), 'Writer');
    await user.click(screen.getByRole('checkbox', { name: /Write to the vault/ }));
    await user.click(screen.getByRole('button', { name: 'Make token' }));
    expect(screen.getByRole('alert').textContent).toBe('Choose from 1 to 20 write folders.');
    await user.click(screen.getByRole('button', { name: 'Choose write folders' }));
    const options = screen.getAllByTestId('picker-option');
    expect(options.some((o) => o.textContent === 'knowledge')).toBe(false);
    await user.click(options.find((o) => o.textContent === 'records')!);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Make token' }));
    await screen.findByRole('dialog', { name: 'Your token' });
    expect((await ipc.clientTokens(vault))[0]).toMatchObject({
      writeScope: ['records'],
      readScope: null,
    });
  });
  it('asks before revoking and names another vault', async () => {
    await ipc.createClientToken('/another', request);
    const user = userEvent.setup();
    render(<ClientAccessSettings />);
    expect(await screen.findByText('For another vault: /another')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByRole('dialog', { name: 'Revoke Reader?' }).textContent).toContain(
      'Any app using it stops working at once.',
    );
    expect(await ipc.clientTokens(vault)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await ipc.clientTokens(vault)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Revoke token' }));
    await screen.findByText('No app has a token yet.');
  });
  it('shows the cap and disables creation at twenty', async () => {
    __seedClientTokens(20);
    render(<ClientAccessSettings />);
    await screen.findByText('You have 20 tokens. Revoke one to make another.');
    expect(
      (screen.getByRole('button', { name: 'Make a token' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it('shows loading and failed reads without claiming empty', async () => {
    let reject!: (reason: unknown) => void;
    vi.spyOn(ipc, 'clientTokens').mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    render(<ClientAccessSettings />);
    expect(screen.getByText('Reading tokens…')).toBeTruthy();
    reject(Error('disk'));
    await screen.findByTestId('section-unavailable');
    expect(screen.queryByText('No app has a token yet.')).toBeNull();
  });
  it('reports invalid ports, bind failures and unavailable status separately', async () => {
    const user = userEvent.setup();
    await ready();
    expect(screen.getByText("Off. Other apps can't connect.")).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Client port' }), {
      target: { value: '80' },
    });
    await user.click(screen.getByRole('button', { name: 'Save port' }));
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe('Choose a port from 1024 to 65535.');
    vi.spyOn(ipc, 'setClientAccess').mockResolvedValueOnce({
      enabled: true,
      port: 37421,
      url: null,
      error: 'address in use',
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Client port' }), {
      target: { value: '37421' },
    });
    await user.click(screen.getByRole('switch', { name: 'Let other apps connect' }));
    await screen.findByText("Couldn't listen on port 37421: address in use");
    cleanup();
    useClientAccessStore.getState().reset(vault);
    vi.spyOn(ipc, 'clientAccessStatus').mockRejectedValueOnce(Error('unavailable'));
    render(<ClientAccessSettings />);
    await screen.findByText("Couldn't read whether other apps can connect.");
  });
  it('clears the shown-once view and drafts when the vault changes', async () => {
    await ready();
    const dialog = await make();
    const secret = within(dialog).getByTestId('client-token-secret').textContent!;
    act(() => useVaultStore.setState({ vaultPath: '/other' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain(secret);
  });
  it('reports refused clipboard writes without losing the shown-once view', async () => {
    const user = userEvent.setup();
    vi.spyOn(ipc, 'writeClipboard').mockRejectedValueOnce(Error('denied'));
    await ready();
    const dialog = await make();
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    expect(useUiStore.getState().toasts.at(-1)?.message).toContain('denied');
    expect(screen.getByTestId('client-token-secret')).toBeTruthy();
  });
});
