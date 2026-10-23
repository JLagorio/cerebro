// @vitest-environment jsdom
import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorStatusRow } from '@/engine/connectors';

const reads = vi.hoisted(() => ({
  readConnectors: vi.fn<(vault: string) => Promise<string>>(),
  connectorStatus: vi.fn<(vault: string) => Promise<ConnectorStatusRow[]>>(),
}));

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    readConnectors: (vault: string) => reads.readConnectors(vault),
    connectorStatus: (vault: string) => reads.connectorStatus(vault),
    saveConnectors: vi.fn(async () => undefined),
  };
});

import { connectorFocus } from '@/agent/elements/connectorRow';
import { RAIL_CONNECTORS_WORDS } from '@/agent/elements/railConnectors';
import type { RunReach } from '@/agent/types';
import { ConnectorSettings } from '@/app/ConnectorSettings';
import { approvalKey, parseConnectors } from '@/engine/connectors';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { ConnectorsCard, type ConnectorsCardProps } from './ConnectorsCard';

/**
 * The rail's Connectors card (M92.9): the vault's list in the words Settings
 * says each entry in, joined with what the conversation's latest run said it
 * reaches. It reads as it is shown and when a turn ends, never on a streamed
 * word and never while folded; it signs in to nothing, and its Sign in…
 * floats the conversation before it opens Settings at the connector.
 */

const VAULT = '/vault';

const LIST = JSON.stringify({
  servers: {
    Gmail: { transport: 'http', url: 'https://gmail.example.test/mcp', enabled: true },
    jira: { transport: 'http', url: 'https://jira.example.test/mcp', enabled: true },
    linear: {
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      oauth: { scopes: 'read write' },
      enabled: true,
    },
    slack: { transport: 'http', url: 'https://slack.example.test/mcp', enabled: false },
    a__b: { transport: 'http', url: 'https://ab.example.test/mcp', enabled: true },
    files: { transport: 'stdio', command: 'npx', args: ['-y', '@acme/files'], enabled: true },
  },
});

const row = (connector: string, over: Partial<ConnectorStatusRow> = {}): ConnectorStatusRow => ({
  connector,
  cli_name: connector,
  refused: null,
  state: null,
  signal: null,
  seen_at: null,
  run_id: null,
  ...over,
});

/** What the newest runs saw: Gmail works, jira needs a sign-in, a__b's name
 *  can never be granted; linear is a preset no run has used yet. */
const STATUS: ConnectorStatusRow[] = [
  row('Gmail', { state: 'working', seen_at: '2026-07-28T11:00:00.000Z' }),
  row('jira', { state: 'needs_sign_in' }),
  row('a__b', { refused: "its name holds __, which the CLI reads as the end of a server's name" }),
];

/** This machine approved every entry but `files`. */
const APPROVALS = parseConnectors(LIST)
  .filter((spec) => spec.name !== 'files')
  .flatMap((spec) => approvalKey(spec) ?? []);

const REACH: RunReach = {
  connectors: [
    { name: 'Gmail', status: 'connected' },
    { name: 'jira', status: 'needs-auth' },
  ],
  missing: [{ name: 'notion', reason: "not in this vault's connector list" }],
  missing_more: 0,
  inherits: false,
  permission_mode: 'acceptEdits',
  cerebro: true,
  families: {},
};

function Card(props: Partial<ConnectorsCardProps>) {
  return <ConnectorsCard vault={VAULT} reach={REACH} streaming={false} folded={false} {...props} />;
}

const card = () => screen.getByTestId('rail-connectors');
const line = (name: string) =>
  within(card())
    .getAllByTestId('rail-connector')
    .find((el) => el.dataset.name === name) as HTMLElement;

/** Let every read a render started land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const realNavigate = useNavStore.getState().navigate;

beforeEach(() => {
  reads.readConnectors.mockReset().mockResolvedValue(LIST);
  reads.connectorStatus.mockReset().mockResolvedValue(STATUS);
  useVaultStore.setState({ vaultPath: VAULT });
  useUiStore.setState({
    agentConnectors: true,
    stdioApprovals: { [VAULT]: APPROVALS },
    settingsFocus: null,
    aiPanelPresentation: 'canvas',
    aiPanelMinimized: false,
  });
});

afterEach(() => {
  cleanup();
  useNavStore.setState({ navigate: realNavigate } as never);
  useUiStore.setState({ agentConnectors: false, stdioApprovals: {}, settingsFocus: null });
});

describe('what the card says', () => {
  it('says each connector in the words Settings says it in', async () => {
    render(
      <>
        <ConnectorSettings />
        <Card />
      </>,
    );
    await settle();
    const settings = screen.getAllByTestId('connector-status').map((el) => {
      const [name, words = null] = (el.textContent ?? '').split(' — ');
      return [name, el.getAttribute('data-state'), words];
    });
    const rail = within(card())
      .getAllByTestId('rail-connector')
      .filter((el) => el.dataset.status !== 'unlisted')
      .map((el) => [
        el.dataset.name,
        el.dataset.status,
        el.querySelector('[data-testid="rail-connector-status"]')?.textContent ?? null,
      ]);
    expect(rail).toEqual(settings);
    expect(rail).toEqual([
      ['Gmail', 'working', 'working'],
      ['jira', 'needs_sign_in', 'needs sign-in'],
      ['linear', 'not_observed', 'not observed yet'],
      ['slack', 'off', 'off'],
      ['a__b', 'refused', expect.stringContaining('can’t be granted: its name holds __')],
      ['files', 'unapproved', 'runs a local command'],
    ]);
    // Settings offers a sign-in where the rail offers Sign in…, and nowhere else.
    const signIns = within(card())
      .getAllByTestId('rail-connector-sign-in')
      .map((el) => el.closest<HTMLElement>('[data-testid="rail-connector"]')?.dataset.name);
    expect(signIns).toEqual(['jira', 'linear']);
    expect(screen.getAllByTestId('connector-sign-in')).toHaveLength(2);
  });

  it('joins what the run loaded and what it did not get, Rust’s reason verbatim', async () => {
    render(<Card />);
    await settle();
    expect(card().dataset.state).toBe('ready');
    expect(within(card()).getByRole('heading', { level: 3 }).textContent).toBe(
      'Connectors2 loaded',
    );
    expect(line('Gmail').dataset.run).toBe('loaded');
    expect(line('Gmail').textContent).toContain(RAIL_CONNECTORS_WORDS.loaded);
    expect(line('slack').dataset.run).toBe('not-loaded');
    expect(line('notion').dataset.status).toBe('unlisted');
    expect(within(line('notion')).getByTestId('rail-connector-run').textContent).toBe(
      "Not loaded: not in this vault's connector list",
    );
    expect(screen.getByTestId('rail-connectors-mail').textContent).toBe(
      'Mail is drafted, never sent: Cerebro blocks the known send tools by name.',
    );
    expect(screen.queryByTestId('rail-connectors-inherited')).toBeNull();
  });

  it('offers no Authenticate button, no href, and makes every control a tab stop', async () => {
    render(<Card />);
    await settle();
    expect(within(card()).queryByRole('button', { name: /authenticate/i })).toBeNull();
    expect(card().querySelector('a[href]')).toBeNull();
    const buttons = within(card()).getAllByRole('button');
    // The fold, and the two Sign in….
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button.getAttribute('tabindex')).toBe('0');
    expect(
      within(line('jira')).getByRole('button', {
        name: 'Sign in to jira in Settings (leaves full screen)',
      }).textContent,
    ).toBe('Sign in…');
    expect(document.querySelectorAll('[data-unknown-icon]')).toHaveLength(0);
  });

  it('is one quiet line when Settings switches connectors off, and reads nothing', async () => {
    useUiStore.setState({ agentConnectors: false });
    render(<Card />);
    await settle();
    expect(card().dataset.state).toBe('empty');
    expect(within(card()).getByRole('heading', { level: 3 }).textContent).toBe(
      'ConnectorsOff in Settings',
    );
    expect(reads.readConnectors).not.toHaveBeenCalled();
    expect(reads.connectorStatus).not.toHaveBeenCalled();
  });

  it('is unavailable, never empty, when the list cannot be read', async () => {
    reads.readConnectors.mockRejectedValue(new Error('.cerebro is a symlink'));
    render(<Card />);
    await settle();
    expect(card().dataset.state).toBe('unavailable');
    const unavailable = within(card()).getByTestId('section-unavailable');
    expect(unavailable.textContent).toContain(RAIL_CONNECTORS_WORDS.unavailable);
    expect(unavailable.textContent).toContain(
      'Runs reach no connectors until it can be read: .cerebro is a symlink',
    );
    expect(within(card()).queryAllByTestId('rail-connector')).toHaveLength(0);
    expect(card().textContent).not.toContain('None');
  });

  it('is partial when the status read fails, its rows claiming no state', async () => {
    reads.connectorStatus.mockRejectedValue(new Error('no runtime database'));
    render(<Card />);
    await settle();
    expect(card().dataset.state).toBe('partial');
    expect(screen.getByTestId('rail-connectors-partial').textContent).toBe(
      RAIL_CONNECTORS_WORDS.partial,
    );
    expect(line('Gmail').dataset.status).toBe('unavailable');
    expect(within(line('Gmail')).queryByTestId('rail-connector-status')).toBeNull();
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });

  it('is not recorded for a conversation whose runs never said what they reach', async () => {
    render(<Card reach={null} />);
    await settle();
    expect(card().dataset.state).toBe('not-recorded');
    expect(screen.getByTestId('rail-connectors-not-recorded').textContent).toContain(
      RAIL_CONNECTORS_WORDS.notRecorded,
    );
    expect(line('Gmail').hasAttribute('data-run')).toBe(false);
    expect(screen.queryByTestId('rail-connectors-mail')).toBeNull();
  });

  it('names the inherited-connector limit where the vault has no list', async () => {
    reads.readConnectors.mockResolvedValue('');
    reads.connectorStatus.mockResolvedValue([]);
    render(<Card reach={{ ...REACH, connectors: [], missing: [], inherits: true }} />);
    await settle();
    expect(card().dataset.state).toBe('ready');
    expect(screen.getByTestId('rail-connectors-inherited').textContent).toBe(
      RAIL_CONNECTORS_WORDS.inherited,
    );
    expect(screen.queryByTestId('rail-connectors-mail')).toBeNull();
  });

  it('claims nothing while its reads are out', async () => {
    reads.connectorStatus.mockReturnValue(new Promise(() => undefined));
    render(<Card />);
    await settle();
    expect(screen.queryByTestId('rail-connectors')).toBeNull();
  });
});

describe('Sign in…', () => {
  it('floats the conversation first, then opens Settings at the connector', async () => {
    const seen: string[] = [];
    const navigate = vi.fn(() => {
      seen.push(useUiStore.getState().aiPanelPresentation);
    });
    useNavStore.setState({ navigate } as never);
    render(<Card />);
    await settle();
    fireEvent.click(within(line('jira')).getByTestId('rail-connector-sign-in'));
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ kind: 'settings' });
    expect(seen).toEqual(['floating']);
    expect(useUiStore.getState().settingsFocus).toBe(connectorFocus('jira'));
  });
});

describe('the reading rules', () => {
  it('never reads while folded, and reads as the rail unfolds', async () => {
    const view = render(<Card folded />);
    await settle();
    expect(reads.readConnectors).not.toHaveBeenCalled();
    expect(reads.connectorStatus).not.toHaveBeenCalled();
    expect(screen.queryByTestId('rail-connectors')).toBeNull();
    view.rerender(<Card folded={false} />);
    await settle();
    expect(reads.readConnectors).toHaveBeenCalledExactlyOnceWith(VAULT);
    expect(reads.connectorStatus).toHaveBeenCalledExactlyOnceWith(VAULT);
    expect(card().dataset.state).toBe('ready');
    // Folded again: nothing is read, and what it drew stays.
    view.rerender(<Card folded streaming />);
    view.rerender(<Card folded />);
    await settle();
    expect(reads.readConnectors).toHaveBeenCalledTimes(1);
    expect(card().dataset.state).toBe('ready');
  });

  it('reads at a turn’s end, never on a streamed word', async () => {
    const view = render(<Card streaming />);
    await settle();
    expect(reads.connectorStatus).toHaveBeenCalledTimes(1);
    for (let at = 0; at < 50; at += 1) view.rerender(<Card streaming />);
    await settle();
    expect(reads.connectorStatus).toHaveBeenCalledTimes(1);
    reads.connectorStatus.mockResolvedValue([row('jira', { state: 'working' })]);
    view.rerender(<Card streaming={false} />);
    await settle();
    expect(reads.connectorStatus).toHaveBeenCalledTimes(2);
    expect(line('jira').dataset.status).toBe('working');
    expect(within(line('jira')).queryByTestId('rail-connector-sign-in')).toBeNull();
  });

  it('draws nothing new when a read says nothing new', async () => {
    let commits = 0;
    const counted = (streaming: boolean) => (
      <Profiler id="card" onRender={() => (commits += 1)}>
        <Card streaming={streaming} />
      </Profiler>
    );
    const view = render(counted(true));
    await settle();
    const settled = commits;
    // The turn ends: one commit for the prop, and the read that follows,
    // which answers what the card holds, draws none.
    view.rerender(counted(false));
    await settle();
    expect(reads.connectorStatus).toHaveBeenCalledTimes(2);
    expect(commits).toBe(settled + 1);
  });
});
