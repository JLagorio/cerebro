import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return {
    ...actual,
    readNote: vi.fn(async () => '---\ntype: Agent\n---\n\n# Release scout\n\nWatch the risks.\n'),
    saveNote: vi.fn(async () => undefined),
    setNoteTitle: vi.fn(async () => undefined),
    updateFrontmatter: vi.fn(async () => undefined),
    createNote: vi.fn(async () => 'records/skills/new-skill.md'),
  };
});

import * as ipc from '@/lib/ipc';
import { makeEntry } from '@/test/factories';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { LibraryPage } from './LibraryPage';

afterEach(cleanup);

/**
 * M18 — the library as a workflow rather than a directory.
 *
 * These test the two things only the page can get wrong: that a boundary the
 * form draws reaches the file as the value it drew, and that nothing is written
 * before the user says so.
 */
const SKILL = makeEntry({
  path: 'records/skills/risk-sweep.md',
  folder: 'records/skills',
  title: 'Risk sweep',
  type: 'Skill',
  properties: { slug: 'risk-sweep', description: 'Find unwritten risks' } as never,
});
const AGENT = makeEntry({
  path: 'records/agents/release-scout.md',
  folder: 'records/agents',
  title: 'Release scout',
  type: 'Agent',
  properties: {
    slug: 'release-scout',
    description: 'Watches risks',
    schedule: 'weekdays 08:30',
    scope: ['records/risks'],
  } as never,
});
const RISK = makeEntry({
  path: 'records/risks/rollback.md',
  folder: 'records/risks',
  title: 'Rollback unrehearsed',
  type: 'Risk',
  properties: { status: 'open' } as never,
});
const TEMPLATE = makeEntry({
  path: 'templates/prd.md',
  folder: 'templates',
  title: 'PRD',
  type: 'Spec',
  properties: { fill: 'Draft it.' } as never,
});

describe('LibraryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [SKILL, AGENT, RISK, TEMPLATE],
      rescan: vi.fn(async () => undefined) as never,
    });
    useNavStore.setState({ selection: { kind: 'library' } });
  });

  it('shelves all three kinds, templates included', async () => {
    render(<LibraryPage />);
    expect(screen.getByTestId('library-tab-skill')).toBeTruthy();
    expect(screen.getByTestId('library-tab-agent')).toBeTruthy();
    expect(screen.getByTestId('library-tab-template')).toBeTruthy();
    expect(screen.getByText('Risk sweep')).toBeTruthy();
    fireEvent.click(screen.getByTestId('library-tab-template'));
    expect(await screen.findByText('PRD')).toBeTruthy();
  });

  it('says what an agent may write on the card, without opening it', () => {
    // A boundary that only exists in a file nobody opens is a promise, not a
    // control surface.
    useNavStore.setState({ selection: { kind: 'library', tab: 'agent' } });
    render(<LibraryPage />);
    const tags = screen.getAllByTestId('library-tag').map((t) => t.textContent);
    expect(tags).toContain('writes records/risks');
  });

  it('warns when an agent has no scope at all', () => {
    useVaultStore.setState({
      entries: [makeEntry({ path: 'records/agents/loose.md', type: 'Agent', title: 'Loose' })],
    });
    useNavStore.setState({ selection: { kind: 'library', tab: 'agent' } });
    render(<LibraryPage />);
    expect(screen.getAllByTestId('library-tag').map((t) => t.textContent)).toContain(
      'writes anywhere',
    );
  });

  it('pauses an agent by writing a key, not by deleting its schedule', async () => {
    // The point of the pause: the trigger you wrote survives being turned off.
    useNavStore.setState({ selection: { kind: 'library', tab: 'agent' } });
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole('switch', { name: /Pause Release scout/ }));
    await waitFor(() => expect(vi.mocked(ipc.updateFrontmatter)).toHaveBeenCalled());
    const [, path, patch] = vi.mocked(ipc.updateFrontmatter).mock.calls[0];
    expect(path).toBe(AGENT.path);
    expect(patch).toEqual({ paused: true });
  });

  it('opens the editor for the item on the selection, not for a tab', async () => {
    useNavStore.setState({
      selection: { kind: 'library', tab: 'agent', path: AGENT.path },
    });
    render(<LibraryPage />);
    expect(await screen.findByTestId('library-editor')).toBeTruthy();
    expect(screen.getByTestId('library-name')).toHaveProperty('value', 'Release scout');
  });

  it('writes NOTHING until Save — a half-typed boundary is a wrong boundary', async () => {
    useNavStore.setState({
      selection: { kind: 'library', tab: 'agent', path: AGENT.path },
    });
    render(<LibraryPage />);
    const description = await screen.findByTestId('agent-description');
    fireEvent.change(description, { target: { value: 'Watches everything' } });
    expect(vi.mocked(ipc.updateFrontmatter)).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.saveNote)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(vi.mocked(ipc.updateFrontmatter)).toHaveBeenCalled());
    const patch = vi.mocked(ipc.updateFrontmatter).mock.calls[0][2];
    expect(patch.description).toBe('Watches everything');
    // Untouched fields survive the round trip rather than being cleared by a
    // form that only knows about the box you typed in.
    expect(patch.scope).toEqual(['records/risks']);
    expect(patch.schedule).toBe('weekdays 08:30');
  });

  it('scoping an agent to nothing writes an empty list, not a removal', async () => {
    // [] and absent are opposite instructions; a form that collapsed them
    // would turn the safest-looking declaration into the most dangerous one.
    useNavStore.setState({
      selection: { kind: 'library', tab: 'agent', path: AGENT.path },
    });
    render(<LibraryPage />);
    const scope = await screen.findByTestId('agent-scope');
    fireEvent.click(within(scope).getByRole('button', { name: 'Remove records/risks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(vi.mocked(ipc.updateFrontmatter)).toHaveBeenCalled());
    expect(vi.mocked(ipc.updateFrontmatter).mock.calls[0][2].scope).toEqual([]);
  });

  it('offers folders that EXIST, with what is in them', async () => {
    // The complaint that started M18.4: "I should not have to say
    // records/risks, it should load where I can select". A text box accepted a
    // folder that does not exist and scoped the agent to nothing, silently.
    useNavStore.setState({
      selection: { kind: 'library', tab: 'agent', path: AGENT.path },
    });
    render(<LibraryPage />);
    const scope = await screen.findByTestId('agent-scope');
    fireEvent.click(within(scope).getByTestId('picker-add'));
    const labels = (await screen.findAllByTestId('picker-option')).map((o) => o.textContent);
    expect(labels.some((l) => l?.includes('records/risks'))).toBe(true);
    expect(labels.some((l) => l?.includes('records/agents'))).toBe(true);
    // Ancestors too — `records` is a legitimate scope even when every file
    // lives two levels down, and a picker offering only leaves would make the
    // broad, common choice unreachable.
    expect(labels).toContain('records3');
  });

  it('picks tools from the catalog the server actually serves', async () => {
    useNavStore.setState({
      selection: { kind: 'library', tab: 'agent', path: AGENT.path },
    });
    render(<LibraryPage />);
    // The body loads from disk, so wait for the form before touching it.
    await screen.findByTestId('agent-description');
    fireEvent.click(
      screen.getByRole('checkbox', { name: /Restrict this agent to specific tools/ }),
    );
    const tools = await screen.findByTestId('agent-allowed-tools');
    fireEvent.click(within(tools).getByTestId('picker-add'));
    const labels = (await screen.findAllByTestId('picker-option')).map((o) => o.textContent);
    expect(labels.some((l) => l?.includes('search_notes'))).toBe(true);
    expect(labels.some((l) => l?.includes('write_concept'))).toBe(true);
  });

  it('takes a whole toolset in one click, and says whether it can write', async () => {
    useNavStore.setState({
      selection: { kind: 'library', tab: 'agent', path: AGENT.path },
    });
    render(<LibraryPage />);
    // The body loads from disk, so wait for the form before touching it.
    await screen.findByTestId('agent-description');
    fireEvent.click(
      screen.getByRole('checkbox', { name: /Restrict this agent to specific tools/ }),
    );
    const tools = await screen.findByTestId('agent-allowed-tools');
    fireEvent.click(within(tools).getByTestId('picker-add'));
    const readGroup = (await screen.findAllByTestId('picker-group')).find((g) =>
      g.textContent?.includes('Read the vault'),
    );
    fireEvent.click(readGroup!);
    // The one sentence a tool picker owes you: can this change my files?
    expect((await screen.findByTestId('agent-tools-summary')).textContent).toContain('Read-only');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(vi.mocked(ipc.updateFrontmatter)).toHaveBeenCalled());
    expect(vi.mocked(ipc.updateFrontmatter).mock.calls[0][2]['allowed-tools']).toEqual([
      'get_vault_context',
      'search_notes',
      'get_note',
      'list_inbox',
    ]);
  });

  it('keeps a tool name it does not recognise, and says it does not', async () => {
    // Dropping one would rewrite the user's policy behind their back on save,
    // and a hand-edited `allowed-tools:` is exactly where the app should say
    // "I do not know this" rather than quietly disagree.
    useVaultStore.setState({
      entries: [
        makeEntry({
          path: 'records/agents/odd.md',
          type: 'Agent',
          title: 'Odd',
          properties: { 'allowed-tools': ['get_note', 'delete_everything'] } as never,
        }),
      ],
    });
    useNavStore.setState({
      selection: { kind: 'library', tab: 'agent', path: 'records/agents/odd.md' },
    });
    render(<LibraryPage />);
    await screen.findByTestId('agent-description');
    const tools = await screen.findByTestId('agent-allowed-tools');
    expect(within(tools).getByText(/not something this vault has/)).toBeTruthy();
    // Save is disabled until something changes — edit an unrelated field, so
    // the assertion is about what SURVIVES a save rather than what it writes.
    fireEvent.change(screen.getByTestId('agent-description'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(vi.mocked(ipc.updateFrontmatter)).toHaveBeenCalled());
    expect(vi.mocked(ipc.updateFrontmatter).mock.calls[0][2]['allowed-tools']).toEqual([
      'get_note',
      'delete_everything',
    ]);
  });

  it('builds a schedule instead of asking for its grammar', async () => {
    // An unparseable `schedule:` is not an error — it is silently not a
    // schedule, so the agent never runs and nothing anywhere says why.
    useNavStore.setState({
      selection: { kind: 'library', tab: 'agent', path: AGENT.path },
    });
    render(<LibraryPage />);
    const repeat = await screen.findByLabelText('Repeat');
    expect((repeat as HTMLSelectElement).value).toBe('weekdays');
    fireEvent.change(repeat, { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '5' } });
    fireEvent.change(screen.getByTestId('schedule-time'), { target: { value: '17:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(vi.mocked(ipc.updateFrontmatter)).toHaveBeenCalled());
    expect(vi.mocked(ipc.updateFrontmatter).mock.calls[0][2].schedule).toBe('weekly fri 17:30');
  });

  it('un-scoping an agent removes the key, which means anywhere', async () => {
    useNavStore.setState({
      selection: { kind: 'library', tab: 'agent', path: AGENT.path },
    });
    render(<LibraryPage />);
    await screen.findByTestId('agent-scope');
    fireEvent.click(screen.getByRole('checkbox', { name: /Limit where this agent can write/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(vi.mocked(ipc.updateFrontmatter)).toHaveBeenCalled());
    expect(vi.mocked(ipc.updateFrontmatter).mock.calls[0][2].scope).toBe(null);
  });

  it('never writes the agent’s own notes back over what the last run learned', async () => {
    useNavStore.setState({
      selection: { kind: 'library', tab: 'agent', path: AGENT.path },
    });
    render(<LibraryPage />);
    await screen.findByTestId('agent-recent');
    fireEvent.change(screen.getByTestId('agent-description'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(vi.mocked(ipc.updateFrontmatter)).toHaveBeenCalled());
    expect('recent' in vi.mocked(ipc.updateFrontmatter).mock.calls[0][2]).toBe(false);
  });

  it('creates one that is inert — no schedule, nothing that fires it', async () => {
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole('button', { name: /New skill/ }));
    await waitFor(() => expect(vi.mocked(ipc.createNote)).toHaveBeenCalled());
    const [, folder, , frontmatter] = vi.mocked(ipc.createNote).mock.calls[0];
    expect(folder).toBe('records/skills');
    expect(frontmatter).toMatchObject({ type: 'Skill' });
    expect('schedule' in frontmatter).toBe(false);
    expect('when' in frontmatter).toBe(false);
  });
});
