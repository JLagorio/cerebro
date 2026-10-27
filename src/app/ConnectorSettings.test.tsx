import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    readConnectors: vi.fn(async () => ''),
    saveConnectors: vi.fn(async () => undefined),
    connectorStatus: vi.fn(async () => []),
  };
});

import { ConnectorSettings } from './ConnectorSettings';
import {
  approvalKey,
  parseConnectors,
  type ConnectorSpec,
  type ConnectorStatusRow,
} from '@/engine/connectors';
import { connectorFocus } from '@/agent/elements/connectorRow';
import * as ipc from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { chooseOption, optionLabels } from '@/test/chooseOption';

describe('ConnectorSettings approval surface', () => {
  beforeEach(() => {
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ stdioApprovals: {} });
    vi.mocked(ipc.connectorStatus).mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.mocked(ipc.readConnectors).mockReset();
    vi.mocked(ipc.connectorStatus).mockReset();
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

  it('an http entry from the file is not approved here until a person approves it (M54.9)', async () => {
    // A run is granted an http connector's tools by name, and the file
    // travels with the vault — so a hand-edited or downloaded entry waits
    // for an Approve that covers its URL AND its headers, both on the row.
    const file = JSON.stringify({
      servers: {
        jira: {
          transport: 'http',
          url: 'https://jira/mcp',
          headers: { 'X-Team': 'core', Authorization: 'Bearer sekrit' },
          enabled: true,
        },
      },
    });
    vi.mocked(ipc.readConnectors).mockResolvedValue(file);
    render(<ConnectorSettings />);
    expect(
      await screen.findByText('https://jira/mcp · Authorization: Bearer sekrit · X-Team: core'),
    ).toBeTruthy();
    expect(screen.getByText('not approved on this machine')).toBeTruthy();
    fireEvent.click(screen.getByText('Approve'));
    const ledger = useUiStore.getState().stdioApprovals['/vault'];
    expect(ledger).toEqual([approvalKey(parseConnectors(file)[0])]);
    expect(JSON.stringify(useUiStore.getState().stdioApprovals)).not.toContain('sekrit');
    expect(screen.queryByText('not approved on this machine')).toBeNull();
    expect(screen.queryByText('Approve')).toBeNull();
  });

  it('a header the fingerprint cannot cover can never be approved', async () => {
    vi.mocked(ipc.readConnectors).mockResolvedValue(
      JSON.stringify({
        servers: {
          jira: {
            transport: 'http',
            url: 'https://jira/mcp',
            headers: { 'X-Retries': 3 },
            enabled: true,
          },
        },
      }),
    );
    render(<ConnectorSettings />);
    expect(await screen.findByText('malformed headers')).toBeTruthy();
    expect(screen.queryByText('Approve')).toBeNull();
  });

  it('adding a connector approves what was added, and removing it revokes it', async () => {
    // Typing the URL or the command here IS the approval; a later hand-edit
    // to the file has to be approved again, and a removed entry leaves no
    // approval behind for a file that brings it back.
    vi.mocked(ipc.readConnectors).mockResolvedValue('');
    render(<ConnectorSettings />);
    fireEvent.change(await screen.findByPlaceholderText('Name'), { target: { value: 'jira' } });
    fireEvent.change(screen.getByPlaceholderText('https://…/mcp'), {
      target: { value: 'https://jira/mcp' },
    });
    fireEvent.click(screen.getByText('Add'));
    const added: ConnectorSpec = {
      name: 'jira',
      transport: 'http',
      url: 'https://jira/mcp',
      command: '',
      args: [],
      enabled: true,
      extra: {},
    };
    expect(useUiStore.getState().stdioApprovals['/vault']).toEqual([approvalKey(added)]);
    expect(await screen.findByText('https://jira/mcp')).toBeTruthy();
    expect(screen.queryByText('not approved on this machine')).toBeNull();
    expect(vi.mocked(ipc.saveConnectors)).toHaveBeenCalled();
    // Rust decides from the saved list which names can be granted, so each
    // save is followed by a fresh status read (M54.11).
    await waitFor(() => expect(vi.mocked(ipc.connectorStatus)).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByLabelText('Remove jira'));
    expect(useUiStore.getState().stdioApprovals['/vault']).toEqual([]);
    await waitFor(() => expect(vi.mocked(ipc.connectorStatus)).toHaveBeenCalledTimes(3));
  });

  it('the transport picker makes the target a command, and a stdio add approves exactly it', async () => {
    vi.mocked(ipc.readConnectors).mockResolvedValue('');
    render(<ConnectorSettings />);
    fireEvent.change(await screen.findByPlaceholderText('Name'), { target: { value: 'files' } });
    const transport = screen.getByRole('button', { name: 'Connector transport' });
    expect(transport.getAttribute('data-value')).toBe('http');
    expect(optionLabels(transport)).toEqual(['http', 'stdio']);
    chooseOption(transport, 'stdio');
    expect(transport.getAttribute('data-value')).toBe('stdio');
    fireEvent.change(screen.getByPlaceholderText('npx -y @some/mcp'), {
      target: { value: 'npx -y @acme/files-mcp' },
    });
    fireEvent.click(screen.getByText('Add'));
    const added: ConnectorSpec = {
      name: 'files',
      transport: 'stdio',
      url: '',
      command: 'npx',
      args: ['-y', '@acme/files-mcp'],
      enabled: true,
      extra: {},
    };
    expect(useUiStore.getState().stdioApprovals['/vault']).toEqual([approvalKey(added)]);
  });

  it('says legacy mode loads your global config but grants none of its tools', async () => {
    vi.mocked(ipc.readConnectors).mockResolvedValue('');
    render(<ConnectorSettings />);
    const note = (await screen.findByTestId('connector-settings-note')).textContent ?? '';
    expect(note).toContain('Cerebro grants none of its tools');
    expect(note).not.toContain('inherit your global MCP config');
    // A turn that names a connector is pinned instead (M54.9): no deny or
    // narrowing could bind a server only your global config names.
    expect(note).toContain('A turn whose agent or skill names a connector loads none of it');
    expect(note).toContain('While access for other apps is on, runs use only this explicit list');
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

describe('ConnectorSettings status (M54.11)', () => {
  const GMAIL = JSON.stringify({
    servers: {
      Gmail: { transport: 'http', url: 'https://gmail.example.test/mcp', enabled: true },
    },
  });

  function row(over: Partial<ConnectorStatusRow>): ConnectorStatusRow {
    return {
      connector: 'Gmail',
      cli_name: 'Gmail',
      refused: null,
      state: null,
      signal: null,
      seen_at: null,
      run_id: null,
      ...over,
    };
  }

  /** The vault's list, every entry approved on this machine. */
  function listed(file: string) {
    vi.mocked(ipc.readConnectors).mockResolvedValue(file);
    useUiStore.setState({
      stdioApprovals: {
        '/vault': parseConnectors(file).flatMap((spec) => approvalKey(spec) ?? []),
      },
    });
  }

  function stubClipboard(writeText: (text: string) => Promise<void>) {
    const spy = vi.fn(writeText);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: spy },
      configurable: true,
    });
    return spy;
  }

  async function statusOf(name: string) {
    const all = await screen.findAllByTestId('connector-status');
    const found = all.find((el) => el.textContent?.startsWith(name));
    if (found === undefined) throw new Error(`no status row for ${name}`);
    return found;
  }

  beforeEach(() => {
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ stdioApprovals: {}, toasts: [] });
    vi.mocked(ipc.connectorStatus).mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.mocked(ipc.readConnectors).mockReset();
    vi.mocked(ipc.connectorStatus).mockReset();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('Gmail — needs sign-in, with the command to copy: Copied only once the write resolves', async () => {
    listed(GMAIL);
    vi.mocked(ipc.connectorStatus).mockResolvedValue([
      row({
        state: 'needs_sign_in',
        signal: 'init',
        seen_at: '2026-07-28T11:00:00.000Z',
        run_id: 'run-1',
      }),
    ]);
    let finish: () => void = () => {};
    const writeText = stubClipboard(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ConnectorSettings />);
    await waitFor(async () =>
      expect((await statusOf('Gmail')).textContent).toBe('Gmail — needs sign-in'),
    );
    expect((await statusOf('Gmail')).getAttribute('data-state')).toBe('needs_sign_in');
    expect(screen.getByTestId('connector-sign-in-command').textContent).toBe(
      'claude mcp add --transport http Gmail https://gmail.example.test/mcp',
    );
    expect(screen.getByTestId('connector-sign-in').textContent).toContain(
      'Then run claude, type /mcp, and sign in to Gmail. The sign-in stays in Claude Code; Cerebro never holds the token.',
    );
    expect(screen.getByTestId('connector-seen').getAttribute('title')).toBe(
      '2026-07-28T11:00:00.000Z',
    );
    expect(screen.getByTestId('connector-seen').textContent).toMatch(/^seen /);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(
      'claude mcp add --transport http Gmail https://gmail.example.test/mcp',
    );
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    await act(async () => finish());
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('a clipboard that refuses the write toasts, and the button never says Copied', async () => {
    listed(GMAIL);
    vi.mocked(ipc.connectorStatus).mockResolvedValue([row({ state: 'needs_sign_in' })]);
    stubClipboard(() => Promise.reject(new Error('denied')));
    render(<ConnectorSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
        'Couldn’t copy the command — select it and copy it yourself.',
      ]),
    );
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('an entry the command cannot carry shows what to fix, never a command to copy', async () => {
    // The URL is the vault file's, not the person's: pasted, its ETX could
    // abort the line and its CR run what follows, quoted or not.
    listed(
      JSON.stringify({
        servers: {
          Gmail: {
            transport: 'http',
            url: 'https://gmail.example.test/mcp#\u0003open -a Calculator\r',
            enabled: true,
          },
          'toy.v2': { transport: 'http', url: 'https://toy.example.test/mcp', enabled: true },
        },
      }),
    );
    vi.mocked(ipc.connectorStatus).mockResolvedValue([
      row({ state: 'needs_sign_in' }),
      row({ connector: 'toy.v2', cli_name: 'toy.v2', state: 'needs_sign_in' }),
    ]);
    render(<ConnectorSettings />);
    await waitFor(async () =>
      expect((await statusOf('Gmail')).textContent).toBe('Gmail — needs sign-in'),
    );
    expect((await statusOf('toy.v2')).textContent).toBe('toy.v2 — needs sign-in');
    expect(screen.queryByTestId('connector-sign-in-command')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.getAllByTestId('connector-sign-in').map((el) => el.textContent)).toEqual([
      'Its URL or one of its headers holds a character other than printable ASCII, which a pasted command must not carry, so fix this entry in .cerebro/connectors.json, then sign in. The sign-in stays in Claude Code; Cerebro never holds the token.',
      'Claude Code adds a connector only under a name of letters, digits, - and _, so rename toy.v2 here, then sign in. The sign-in stays in Claude Code; Cerebro never holds the token.',
    ]);
  });

  it('a connector no run has seen reads not observed yet', async () => {
    listed(GMAIL);
    render(<ConnectorSettings />);
    await waitFor(async () =>
      expect((await statusOf('Gmail')).textContent).toBe('Gmail — not observed yet'),
    );
    expect((await statusOf('Gmail')).getAttribute('data-state')).toBe('not_observed');
    expect(screen.queryByTestId('connector-seen')).toBeNull();
    expect(screen.queryByTestId('connector-sign-in')).toBeNull();
  });

  it('a read that fails says so once for the list, and no row claims a state', async () => {
    listed(
      JSON.stringify({
        servers: {
          Gmail: { transport: 'http', url: 'https://gmail.example.test/mcp', enabled: true },
          jira: { transport: 'http', url: 'https://jira/mcp', enabled: true },
        },
      }),
    );
    vi.mocked(ipc.connectorStatus).mockRejectedValue(new Error('no runtime database'));
    render(<ConnectorSettings />);
    expect(await screen.findByTestId('section-unavailable')).toBeTruthy();
    expect(screen.getAllByTestId('section-unavailable')).toHaveLength(1);
    const rows = screen.getAllByTestId('connector-status');
    expect(rows.map((el) => el.textContent)).toEqual(['Gmail', 'jira']);
    expect(rows.map((el) => el.getAttribute('data-state'))).toEqual(['unavailable', 'unavailable']);
    const text = screen.getByTestId('connector-settings').textContent ?? '';
    for (const words of [
      'not observed yet',
      'working',
      'needs sign-in',
      'failed',
      'not approved',
    ]) {
      expect(text).not.toContain(words);
    }
  });

  it('while the read is in flight it says Reading status… and no state words', async () => {
    listed(GMAIL);
    vi.mocked(ipc.connectorStatus).mockReturnValue(new Promise(() => {}));
    render(<ConnectorSettings />);
    expect(await screen.findByTestId('connector-status-loading')).toBeTruthy();
    expect(screen.getByText('Reading status…')).toBeTruthy();
    expect((await statusOf('Gmail')).textContent).toBe('Gmail');
    expect(screen.queryByText(/not observed yet/)).toBeNull();
  });

  it('a switched-off entry reads off, whatever a run saw', async () => {
    listed(
      JSON.stringify({
        servers: {
          Gmail: { transport: 'http', url: 'https://gmail.example.test/mcp', enabled: false },
        },
      }),
    );
    vi.mocked(ipc.connectorStatus).mockResolvedValue([row({ state: 'working' })]);
    render(<ConnectorSettings />);
    await waitFor(async () => expect((await statusOf('Gmail')).textContent).toBe('Gmail — off'));
    expect((await statusOf('Gmail')).getAttribute('data-state')).toBe('off');
  });

  it('a name Rust refuses says why, and offers no Approve', async () => {
    // Not approved here either: the refusal outranks the approval, since no
    // approval could let that name be granted.
    vi.mocked(ipc.readConnectors).mockResolvedValue(
      JSON.stringify({
        servers: { a__b: { transport: 'http', url: 'https://ab/mcp', enabled: true } },
      }),
    );
    vi.mocked(ipc.connectorStatus).mockResolvedValue([
      row({
        connector: 'a__b',
        cli_name: 'a__b',
        refused: "its name holds __, which the CLI reads as the end of a server's name",
      }),
    ]);
    render(<ConnectorSettings />);
    await waitFor(async () =>
      expect((await statusOf('a__b')).textContent).toBe(
        "a__b — can’t be granted: its name holds __, which the CLI reads as the end of a server's name",
      ),
    );
    expect(screen.queryByText('Approve')).toBeNull();
  });

  it('failed and not approved each get a one-line hint', async () => {
    listed(
      JSON.stringify({
        servers: {
          Gmail: { transport: 'http', url: 'https://gmail.example.test/mcp', enabled: true },
          jira: { transport: 'http', url: 'https://jira/mcp', enabled: true },
          slack: { transport: 'http', url: 'https://slack/mcp', enabled: true },
        },
      }),
    );
    vi.mocked(ipc.connectorStatus).mockResolvedValue([
      row({ state: 'failed', signal: 'init', seen_at: '2026-07-28T11:00:00.000Z' }),
      row({
        connector: 'jira',
        cli_name: 'jira',
        state: 'not_approved',
        signal: 'permission_denial',
      }),
      row({ connector: 'slack', cli_name: 'slack', state: 'working', signal: 'tool_result' }),
    ]);
    render(<ConnectorSettings />);
    await waitFor(async () => expect((await statusOf('Gmail')).textContent).toBe('Gmail — failed'));
    expect((await statusOf('jira')).textContent).toBe('jira — not approved');
    expect((await statusOf('slack')).textContent).toBe('slack — working');
    expect(screen.getAllByTestId('connector-hint').map((el) => el.textContent)).toEqual([
      'The last run that used it got no answer from it — check that the server is up and its URL is right.',
      'Your own Claude Code permission rules stopped its tools in the last run — allow them with /permissions in claude.',
    ]);
  });

  it('reads the status again when the window regains focus', async () => {
    // A sign-in finishes in a terminal, so coming back to the app is when
    // the answer may have changed.
    listed(GMAIL);
    vi.mocked(ipc.connectorStatus).mockResolvedValue([row({ state: 'needs_sign_in' })]);
    render(<ConnectorSettings />);
    await waitFor(async () =>
      expect((await statusOf('Gmail')).textContent).toBe('Gmail — needs sign-in'),
    );
    expect(vi.mocked(ipc.connectorStatus)).toHaveBeenCalledTimes(1);
    vi.mocked(ipc.connectorStatus).mockResolvedValue([row({ state: 'working' })]);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(async () =>
      expect((await statusOf('Gmail')).textContent).toBe('Gmail — working'),
    );
    expect(vi.mocked(ipc.connectorStatus)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ipc.connectorStatus)).toHaveBeenLastCalledWith('/vault');
  });

  it('never says nothing connected, nor registered', async () => {
    listed(GMAIL);
    for (const status of [[], [row({ state: 'needs_sign_in' })]] as ConnectorStatusRow[][]) {
      vi.mocked(ipc.connectorStatus).mockResolvedValue(status);
      const { unmount } = render(<ConnectorSettings />);
      await statusOf('Gmail');
      const text = (screen.getByTestId('connector-settings').textContent ?? '').toLowerCase();
      expect(text).not.toContain('nothing connected');
      expect(text).not.toContain('registered');
      unmount();
    }
  });
});

describe('ConnectorSettings presets (M69.1)', () => {
  beforeEach(() => {
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ stdioApprovals: {}, toasts: [] });
    vi.mocked(ipc.connectorStatus).mockResolvedValue([]);
    vi.mocked(ipc.saveConnectors).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.mocked(ipc.readConnectors).mockReset();
    vi.mocked(ipc.connectorStatus).mockReset();
  });

  /** What the last save wrote, parsed. */
  function lastSaved(): { servers: Record<string, unknown> } {
    const calls = vi.mocked(ipc.saveConnectors).mock.calls;
    return JSON.parse(calls[calls.length - 1][1]) as { servers: Record<string, unknown> };
  }

  it('Add Linear saves the preset with its scopes and approves its key', async () => {
    vi.mocked(ipc.readConnectors).mockResolvedValue('');
    render(<ConnectorSettings />);
    expect(await screen.findByText('Add a connector:')).toBeTruthy();
    const button = screen.getByTestId('connector-preset-linear');
    expect(button.textContent).toBe('Add Linear');
    expect(button.getAttribute('title')).toBe('Issues and projects');
    fireEvent.click(button);
    expect(lastSaved().servers.linear).toEqual({
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      oauth: { scopes: 'read write' },
      enabled: true,
    });
    const linear = parseConnectors(JSON.stringify(lastSaved()))[0];
    expect(useUiStore.getState().stdioApprovals['/vault']).toEqual([approvalKey(linear)]);
    expect(
      await screen.findByText('https://mcp.linear.app/mcp · oauth scopes: read write'),
    ).toBeTruthy();
    expect((screen.getByTestId('connector-preset-linear') as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Not observed yet, and a preset: its sign-in shows before any run.
    await waitFor(() =>
      expect(screen.getByTestId('connector-sign-in-command').textContent).toBe(
        `claude mcp add-json linear '{"type":"http","url":"https://mcp.linear.app/mcp","oauth":{"scopes":"read write"}}'`,
      ),
    );
    expect(screen.getByTestId('connector-signin-linear').textContent).toBe('Copy');
  });

  it('a preset listed under another name is disabled with its title', async () => {
    vi.mocked(ipc.readConnectors).mockResolvedValue(
      JSON.stringify({
        servers: {
          docs: { transport: 'http', url: 'https://MCP.Notion.com/mcp/', enabled: true },
        },
      }),
    );
    render(<ConnectorSettings />);
    const notion = (await screen.findByTestId('connector-preset-notion')) as HTMLButtonElement;
    expect(notion.disabled).toBe(true);
    expect(notion.getAttribute('title')).toBe('Already listed as docs');
    const linear = screen.getByTestId('connector-preset-linear') as HTMLButtonElement;
    expect(linear.disabled).toBe(false);
    fireEvent.click(notion);
    expect(vi.mocked(ipc.saveConnectors)).not.toHaveBeenCalled();
  });

  it('removing an http entry toasts the removal note, and removing a stdio entry does not', async () => {
    vi.mocked(ipc.readConnectors).mockResolvedValue(
      JSON.stringify({
        servers: {
          linear: { transport: 'http', url: 'https://mcp.linear.app/mcp', enabled: true },
          toy: { transport: 'stdio', command: 'toy', enabled: true },
        },
      }),
    );
    render(<ConnectorSettings />);
    fireEvent.click(await screen.findByLabelText('Remove toy'));
    expect(useUiStore.getState().toasts).toEqual([]);
    fireEvent.click(screen.getByLabelText('Remove linear'));
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
      'Removed linear. Claude Code keeps the sign-in it stored for linear in your keychain; Cerebro never held it. To sign out, run claude, type /mcp, pick linear and clear its authentication.',
    ]);
    // Each save reads the status again; let both land inside the test.
    await waitFor(() => expect(vi.mocked(ipc.connectorStatus)).toHaveBeenCalledTimes(3));
    expect(await screen.findByTestId('connector-presets')).toBeTruthy();
  });

  it('an http row with malformed oauth says so and offers no Approve', async () => {
    vi.mocked(ipc.readConnectors).mockResolvedValue(
      JSON.stringify({
        servers: {
          toy: {
            transport: 'http',
            url: 'https://toy.example.test/mcp',
            oauth: { scopes: ['read', 'write'] },
            enabled: true,
          },
          late: {
            transport: 'http',
            url: 'https://late.example.test/mcp',
            timeout: 999,
            enabled: true,
          },
        },
      }),
    );
    render(<ConnectorSettings />);
    expect(await screen.findByText('oauth Claude Code would refuse')).toBeTruthy();
    expect(screen.getByText('timeout Claude Code would refuse')).toBeTruthy();
    expect(screen.queryByText('Approve')).toBeNull();
  });
});

// M92.9: the conversation rail's Sign in… opens Settings at the connector's
// row: once the section shows and the list has loaded, it scrolls there and
// forgets the ask.
describe('ConnectorSettings and the rail’s Sign in… (M92.9)', () => {
  const LIST = JSON.stringify({
    servers: {
      jira: { transport: 'http', url: 'https://jira/mcp', enabled: true },
      Gmail: { transport: 'http', url: 'https://gmail.example.test/mcp', enabled: true },
    },
  });
  const scrolled = vi.fn();
  const original = Element.prototype.scrollIntoView;

  beforeEach(() => {
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ stdioApprovals: {}, settingsFocus: null });
    vi.mocked(ipc.readConnectors).mockResolvedValue(LIST);
    vi.mocked(ipc.connectorStatus).mockResolvedValue([]);
    scrolled.mockClear();
    Element.prototype.scrollIntoView = scrolled;
  });

  afterEach(() => {
    cleanup();
    Element.prototype.scrollIntoView = original;
    vi.mocked(ipc.readConnectors).mockReset();
    vi.mocked(ipc.connectorStatus).mockReset();
    useUiStore.setState({ settingsFocus: null });
  });

  const row = (name: string) =>
    screen
      .getAllByTestId('connector-status')
      .find((el) => el.textContent?.startsWith(name))
      ?.closest('.rounded-lg');

  it('scrolls to the named connector once, then clears the ask', async () => {
    useUiStore.setState({ settingsFocus: connectorFocus('Gmail') });
    render(<ConnectorSettings />);
    await waitFor(() => expect(useUiStore.getState().settingsFocus).toBeNull());
    expect(scrolled).toHaveBeenCalledOnce();
    expect(scrolled.mock.contexts[0]).toBe(row('Gmail'));
    expect(scrolled.mock.calls[0]).toEqual([{ block: 'center' }]);
  });

  it('waits for its section to show before it takes the ask', async () => {
    useUiStore.setState({ settingsFocus: connectorFocus('Gmail') });
    const view = render(<ConnectorSettings active={false} />);
    await screen.findAllByTestId('connector-status');
    expect(useUiStore.getState().settingsFocus).toBe(connectorFocus('Gmail'));
    expect(scrolled).not.toHaveBeenCalled();
    view.rerender(<ConnectorSettings active />);
    await waitFor(() => expect(useUiStore.getState().settingsFocus).toBeNull());
    expect(scrolled.mock.contexts[0]).toBe(row('Gmail'));
  });

  it('leaves every other Settings ask alone', async () => {
    useUiStore.setState({ settingsFocus: 'claude-code' });
    render(<ConnectorSettings />);
    await screen.findAllByTestId('connector-status');
    expect(useUiStore.getState().settingsFocus).toBe('claude-code');
    expect(scrolled).not.toHaveBeenCalled();
  });
});

describe('M96.4a Settings ownership admission', () => {
  const markedEntries = (): Record<string, Record<string, unknown>> => ({
    'managed-http': {
      transport: 'http',
      url: 'https://m96-route.example.test/mcp',
      enabled: true,
      headers: { Authorization: 'm96-header-sentinel' },
      oauth: { scopes: 'read write' },
      executionOwner: 'cerebro',
      secretRef: { opaque: 'm96-reference-sentinel' },
      custom: { nested: [null, 3, 'kept'] },
    },
    'managed-stdio': {
      transport: 'stdio',
      command: 'm96-unexecuted-command',
      args: ['m96-arg-sentinel'],
      env: { TOKEN: 'm96-env-sentinel' },
      executionOwner: 'cerebro',
      enabled: false,
    },
    'invalid-http': {
      transport: 'http',
      url: 'https://m96-route.example.test/mcp',
      enabled: true,
      executionOwner: { malformed: true },
      secretRef: null,
      unknown: ['kept'],
    },
    'orphan-stdio': {
      transport: 'stdio',
      command: 'm96-unexecuted-command',
      enabled: true,
      executionOwner: 'cli',
      secretRef: null,
    },
  });

  function listedWithLegacyApprovals(servers: Record<string, Record<string, unknown>>) {
    const raw = JSON.stringify({ servers });
    vi.mocked(ipc.readConnectors).mockResolvedValue(raw);
    const legacyServers = Object.fromEntries(
      Object.entries(servers).map(([name, entry]) => [
        name,
        Object.fromEntries(
          Object.entries(entry).filter(([key]) => key !== 'executionOwner' && key !== 'secretRef'),
        ),
      ]),
    );
    const approvals = parseConnectors(JSON.stringify({ servers: legacyServers })).flatMap(
      (spec) => approvalKey(spec) ?? [],
    );
    expect(approvals).toHaveLength(Object.keys(servers).length);
    useUiStore.setState({ stdioApprovals: { '/vault': approvals } });
    return approvals;
  }

  function historical(servers: Record<string, unknown>, state: 'working' | 'needs_sign_in') {
    return Object.keys(servers).map((connector): ConnectorStatusRow => ({
      connector,
      cli_name: connector,
      refused: null,
      state,
      signal: 'init',
      seen_at: '2026-10-13T10:00:00.000Z',
      run_id: 'historical-run',
    }));
  }

  function assertReadOnlyMarkedRows() {
    for (const name of Object.keys(markedEntries())) {
      expect(screen.queryByLabelText('Enable ' + name)).toBeNull();
      expect(screen.queryByLabelText('Remove ' + name)).toBeNull();
    }
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByTestId('connector-sign-in')).toBeNull();
    expect(screen.queryByTestId('connector-sign-in-command')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.queryByTestId('connector-seen')).toBeNull();
    const rows = screen.getAllByTestId('connector-status');
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const words = row.textContent ?? '';
      if (words.startsWith('managed-')) expect(words).toMatch(/managed.*unavailable/i);
      else {
        expect(words).toMatch(/ownership/i);
        expect(words).toMatch(/file|correct/i);
      }
      expect(words).not.toMatch(/working|needs sign-in|not observed yet/i);
    }
    const shown = screen.getByTestId('connector-settings').innerHTML;
    for (const payload of [
      'https://m96-route.example.test/mcp',
      'm96-header-sentinel',
      'm96-unexecuted-command',
      'm96-arg-sentinel',
      'm96-env-sentinel',
      'm96-reference-sentinel',
    ])
      expect(shown).not.toContain(payload);
  }

  beforeEach(() => {
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ stdioApprovals: {}, toasts: [], settingsFocus: null });
    vi.mocked(ipc.saveConnectors).mockReset().mockResolvedValue(undefined);
    vi.mocked(ipc.connectorStatus).mockReset().mockResolvedValue([]);
    vi.mocked(ipc.readConnectors).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.mocked(ipc.readConnectors).mockReset();
    vi.mocked(ipc.connectorStatus).mockReset();
    vi.mocked(ipc.saveConnectors).mockReset();
  });

  it.each(['working', 'needs_sign_in', 'loading', 'unavailable'] as const)(
    'm96_owner_settings_non_cli_rows_are_honest_and_read_only_during_%s',
    async (read) => {
      const servers = markedEntries();
      const approvals = listedWithLegacyApprovals(servers);
      if (read === 'loading') {
        vi.mocked(ipc.connectorStatus).mockReturnValue(new Promise(() => {}));
      } else if (read === 'unavailable') {
        vi.mocked(ipc.connectorStatus).mockRejectedValue(new Error('no runtime database'));
      } else {
        vi.mocked(ipc.connectorStatus).mockResolvedValue(historical(servers, read));
      }
      render(<ConnectorSettings />);
      await screen.findAllByTestId('connector-status');
      if (read === 'loading')
        expect(await screen.findByTestId('connector-status-loading')).toBeTruthy();
      else if (read === 'unavailable') {
        expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
          'no runtime database',
        );
      } else
        await waitFor(() => expect(screen.queryByTestId('connector-status-loading')).toBeNull());
      assertReadOnlyMarkedRows();
      expect(vi.mocked(ipc.saveConnectors)).not.toHaveBeenCalled();
      expect(useUiStore.getState().stdioApprovals['/vault']).toEqual(approvals);
    },
  );

  it('m96_owner_sibling_edit_retains_marked_configuration_after_completed_save', async () => {
    const marked = markedEntries();
    const sibling = { transport: 'http', url: 'https://sibling.example.test/mcp', enabled: true };
    const servers = { ...marked, sibling };
    const approvals = listedWithLegacyApprovals(servers);
    render(<ConnectorSettings />);
    const toggle = await screen.findByRole('switch', { name: 'Enable sibling' });
    expect(screen.queryByLabelText('Remove sibling')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(vi.mocked(ipc.saveConnectors)).toHaveBeenCalledTimes(1));
    const [vault, saved] = vi.mocked(ipc.saveConnectors).mock.calls[0];
    expect(vault).toBe('/vault');
    expect(JSON.parse(saved)).toEqual({
      servers: { ...marked, sibling: { ...sibling, enabled: false } },
    });
    await waitFor(() => expect(vi.mocked(ipc.connectorStatus)).toHaveBeenCalledTimes(2));
    expect(useUiStore.getState().stdioApprovals['/vault']).toEqual(approvals);
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('m96_owner_failed_config_stays_blocked_and_retry_keeps_managed_rows_visible', async () => {
    vi.mocked(ipc.readConnectors).mockRejectedValue(
      new Error('synthetic unreadable connector list'),
    );
    render(<ConnectorSettings />);
    expect((await screen.findByTestId('connector-settings-blocked')).textContent).toContain(
      'synthetic unreadable connector list',
    );
    expect(screen.queryByTestId('connector-settings')).toBeNull();
    expect(screen.queryByText('Add')).toBeNull();
    listedWithLegacyApprovals(markedEntries());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findAllByTestId('connector-status');
    expect(screen.queryByTestId('connector-settings-blocked')).toBeNull();
    assertReadOnlyMarkedRows();
    expect(vi.mocked(ipc.saveConnectors)).not.toHaveBeenCalled();
  });

  it('m96_owner_explicit_cli_keeps_existing_raw_controls_and_signin', async () => {
    const sibling = {
      transport: 'http',
      url: 'https://sibling.example.test/mcp',
      enabled: true,
      executionOwner: 'cli',
    };
    listedWithLegacyApprovals({ sibling });
    vi.mocked(ipc.connectorStatus).mockResolvedValue(historical({ sibling }, 'needs_sign_in'));
    render(<ConnectorSettings />);
    expect(await screen.findByRole('switch', { name: 'Enable sibling' })).toBeTruthy();
    expect(screen.getByLabelText('Remove sibling')).toBeTruthy();
    expect((await screen.findByTestId('connector-sign-in-command')).textContent).toBe(
      'claude mcp add --transport http sibling https://sibling.example.test/mcp',
    );
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(screen.queryByText('Approve')).toBeNull();
  });
});

describe('M96.4a unreadable configuration bytes', () => {
  beforeEach(() => {
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ stdioApprovals: {}, toasts: [], settingsFocus: null });
    vi.mocked(ipc.readConnectors).mockReset();
    vi.mocked(ipc.connectorStatus).mockReset().mockResolvedValue([]);
    vi.mocked(ipc.saveConnectors).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.mocked(ipc.readConnectors).mockReset();
    vi.mocked(ipc.connectorStatus).mockReset();
    vi.mocked(ipc.saveConnectors).mockReset();
  });

  it('m96_owner_malformed_config_bytes_stay_blocked_and_retry_preserves_absent_list', async () => {
    vi.mocked(ipc.readConnectors).mockResolvedValue('{not json');
    render(<ConnectorSettings />);
    expect((await screen.findByTestId('connector-settings-blocked')).textContent).toContain(
      'connector list cannot be read',
    );
    expect(screen.queryByTestId('connector-settings')).toBeNull();
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(vi.mocked(ipc.saveConnectors)).not.toHaveBeenCalled();

    // Retry reads absent bytes as the existing legacy state, not an invalid list.
    vi.mocked(ipc.readConnectors).mockResolvedValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const note = await screen.findByTestId('connector-settings-note');
    expect(note.textContent).toContain('loads your global MCP config');
    expect(screen.queryByTestId('connector-settings-blocked')).toBeNull();
    expect(screen.queryAllByTestId('connector-status')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
    expect(vi.mocked(ipc.saveConnectors)).not.toHaveBeenCalled();
  });
});
