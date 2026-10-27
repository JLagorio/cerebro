import { __resetOpenPages } from '@/editor/openPages';
import { libraryCards } from './LibraryIndex';
import { stampActivation } from '@/agent/activation';
vi.mock('@/agent/activation', async (original) => ({
  ...(await original<typeof import('@/agent/activation')>()),
  stampActivation: vi.fn(async () => true),
}));
import { navSeed } from '@/test/navSeed';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return {
    ...actual,
    readNoteSource: vi.fn(async () => ({
      content: '---\ntype: Skill\n---\n\n# Risk sweep\n\nWatch the risks.\n',
      hash: 'loaded-hash',
    })),
    applyBatch: vi.fn(),
    saveNote: vi.fn(async () => 'body-hash'),
    setNoteTitle: vi.fn(async () => undefined),
    updateFrontmatter: vi.fn(async () => 'final-hash'),
    createNote: vi.fn(async () => 'records/skills/new-skill.md'),
  };
});

import * as ipc from '@/lib/ipc';
import { chooseOption } from '@/test/chooseOption';
import { makeEntry } from '@/test/factories';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { LibraryPage } from './LibraryPage';

afterEach(cleanup);

/**
 * M18 — the library as a workflow rather than a directory: the shelves, the
 * cards, and where each kind opens. An agent's editor is its page since
 * M55.12; its grant rows are tested in AgentProperties.test.tsx.
 */
const SKILL = makeEntry({
  path: 'records/skills/risk-sweep.md',
  folder: 'records/skills',
  title: 'Risk sweep',
  hash: 'loaded-hash',
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
  hash: 'loaded-hash',
  type: 'Spec',
  properties: { fill: 'Draft it.' } as never,
});

describe('LibraryPage', () => {
  beforeEach(() => {
    __resetOpenPages();
    vi.clearAllMocks();
    vi.mocked(stampActivation).mockResolvedValue(true);
    vi.mocked(ipc.readNoteSource).mockResolvedValue({
      content: '# Risk sweep\n\nWatch the risks.\n',
      hash: 'loaded-hash',
    });
    vi.mocked(ipc.updateFrontmatter).mockResolvedValue('final-hash');
    vi.mocked(ipc.applyBatch).mockImplementation(async (_vault, ops) => {
      const body = ops.find((op) => op.op === 'body');
      if (body?.op !== 'body') throw new Error('Expected body');
      vi.mocked(ipc.readNoteSource).mockResolvedValue({ content: body.body, hash: 'final-hash' });
      return {
        batchId: 'batch',
        files: [
          {
            path: body.path,
            beforeHash: body.expectHash ?? null,
            afterHash: 'final-hash',
            before: 'before',
            keys: [],
            trashed: null,
            restored: null,
            skipped: null,
          },
        ],
      };
    });
    useVaultStore.setState({
      vaultPath: '/vault',
      entriesVault: '/vault',
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

  // M59.3 — the shelf filters through nameMatches: words apart still match.
  it('finds a card from two words that are apart', () => {
    render(<LibraryPage />);
    // In order, across the title and the description: a match.
    fireEvent.change(screen.getByLabelText('Search the library'), {
      target: { value: 'risk unwritten' },
    });
    expect(screen.getAllByTestId('library-card').map((c) => c.textContent)).toEqual([
      expect.stringContaining('Risk sweep'),
    ]);
    // Out of order: none.
    fireEvent.change(screen.getByLabelText('Search the library'), {
      target: { value: 'unwritten sweep' },
    });
    expect(screen.queryAllByTestId('library-card')).toHaveLength(0);
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

  it('an agent card opens the agent’s page', () => {
    useNavStore.setState({ selection: { kind: 'library', tab: 'agent' } });
    render(<LibraryPage />);
    fireEvent.click(screen.getByText('Release scout'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: AGENT.path });
  });

  it('a stale library path to an agent forwards to its page, replacing the slot', async () => {
    const stale = { kind: 'library' as const, tab: 'agent' as const, path: AGENT.path };
    useNavStore.setState({
      selection: stale,
      history: [navSeed({ kind: 'home' }), navSeed(stale)],
      historyIndex: 1,
    });
    const { container } = render(<LibraryPage />);
    await waitFor(() =>
      expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: AGENT.path }),
    );
    expect(useNavStore.getState().history.map((slot) => slot.selection)).toEqual([
      { kind: 'home' },
      { kind: 'doc', path: AGENT.path },
    ]);
    expect(container.querySelector('[data-testid="library-editor"]')).toBeNull();
  });

  it('a skill path still opens the skill editor', async () => {
    useNavStore.setState({ selection: { kind: 'library', tab: 'skill', path: SKILL.path } });
    render(<LibraryPage />);
    expect(await screen.findByTestId('library-editor')).toBeTruthy();
    expect(screen.getByTestId('library-name')).toHaveProperty('value', 'Risk sweep');
    expect(useNavStore.getState().selection).toEqual({
      kind: 'library',
      tab: 'skill',
      path: SKILL.path,
    });
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

  it('only a changed, successfully saved schedule stamps its activation', async () => {
    useNavStore.setState({ selection: { kind: 'library', tab: 'skill', path: SKILL.path } });
    render(<LibraryPage />);
    await screen.findByLabelText('Instructions');
    chooseOption(screen.getByLabelText('Repeat'), 'Every day');
    vi.mocked(stampActivation).mockImplementationOnce(async () => {
      expect(ipc.applyBatch).toHaveBeenCalled();
      return true;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Saved' });
    expect(stampActivation).toHaveBeenCalledWith(
      '/vault',
      'slug:risk-sweep',
      ['daily 09:00'],
      expect.any(Date),
    );
    vi.mocked(stampActivation).mockClear();
    act(() =>
      useVaultStore.setState({
        entries: [{ ...SKILL, properties: { ...SKILL.properties, schedule: 'daily 09:00' } }],
      }),
    );
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'changed body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Saved' });
    expect(stampActivation).not.toHaveBeenCalled();
    vi.mocked(ipc.applyBatch).mockRejectedValueOnce(new Error('disk'));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false),
    );
    expect(stampActivation).not.toHaveBeenCalled();
  });

  it('saves against the loaded version, then the final metadata version', async () => {
    useNavStore.setState({ selection: { kind: 'library', tab: 'skill', path: SKILL.path } });
    render(<LibraryPage />);
    const instructions = await screen.findByLabelText('Instructions');
    fireEvent.change(instructions, { target: { value: 'First draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Saved' });
    expect(ipc.applyBatch).toHaveBeenLastCalledWith('/vault', [
      { op: 'body', path: SKILL.path, body: 'First draft\n', expectHash: 'loaded-hash' },
      { op: 'patch', path: SKILL.path, set: expect.objectContaining({ slug: 'risk-sweep' }) },
    ]);
    fireEvent.change(instructions, { target: { value: 'Second draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Saved' });
    expect(ipc.applyBatch).toHaveBeenLastCalledWith('/vault', [
      { op: 'body', path: SKILL.path, body: 'Second draft\n', expectHash: 'final-hash' },
      { op: 'patch', path: SKILL.path, set: expect.any(Object) },
    ]);
  });

  it('keeps a stale draft dirty and only overwrites after Save mine anyway', async () => {
    vi.mocked(ipc.applyBatch).mockRejectedValueOnce('stale_content: changed');
    useNavStore.setState({ selection: { kind: 'library', tab: 'skill', path: SKILL.path } });
    render(<LibraryPage />);
    const instructions = await screen.findByLabelText('Instructions');
    fireEvent.change(instructions, { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByTestId('library-stale')).textContent).toContain(
      '“Risk sweep” changed on disk',
    );
    expect(instructions).toHaveProperty('value', 'My draft');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
    expect(ipc.updateFrontmatter).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save mine anyway' }));
    await screen.findByRole('button', { name: 'Saved' });
    expect(ipc.applyBatch).toHaveBeenLastCalledWith('/vault', [
      { op: 'body', path: SKILL.path, body: 'My draft\n', expectHash: 'loaded-hash' },
      { op: 'patch', path: SKILL.path, set: expect.any(Object) },
    ]);
    expect(screen.queryByTestId('library-stale')).toBeNull();
  });

  it('loads the new version only on request, discarding the stale draft', async () => {
    vi.mocked(ipc.applyBatch).mockRejectedValueOnce(new Error('stale_content: changed'));
    useNavStore.setState({ selection: { kind: 'library', tab: 'skill', path: SKILL.path } });
    render(<LibraryPage />);
    const instructions = await screen.findByLabelText('Instructions');
    fireEvent.change(instructions, { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByTestId('library-stale');
    vi.mocked(ipc.readNoteSource).mockResolvedValue({
      content: '# Risk sweep\n\nOutside edit\n',
      hash: 'outside-hash',
    });
    act(() => useVaultStore.setState({ entries: [{ ...SKILL, hash: 'outside-hash' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Load the new version' }));
    await waitFor(() =>
      expect(instructions).toHaveProperty('value', '# Risk sweep\n\nOutside edit\n'),
    );
    expect(screen.queryByTestId('library-stale')).toBeNull();
    expect(ipc.applyBatch).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Saved' })).toHaveProperty('disabled', true);
    fireEvent.change(instructions, { target: { value: 'Third draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(ipc.applyBatch).toHaveBeenLastCalledWith('/vault', [
        { op: 'body', path: SKILL.path, body: 'Third draft\n', expectHash: 'outside-hash' },
        { op: 'patch', path: SKILL.path, set: expect.any(Object) },
      ]),
    );
  });

  it('a new agent is born PAUSED, not just inert (M36.2)', async () => {
    // Inert-by-no-schedule ends the moment somebody adds one. The settled
    // design makes activation two acts — configure, then unpause — so the
    // stamp is explicit, and the existing duty toggle is the way back.
    useNavStore.setState({ selection: { kind: 'library', tab: 'agent' } });
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole('button', { name: /New agent/ }));
    await waitFor(() => expect(vi.mocked(ipc.createNote)).toHaveBeenCalled());
    const [, folder, , frontmatter] = vi.mocked(ipc.createNote).mock.calls[0];
    expect(folder).toBe('records/agents');
    expect(frontmatter).toMatchObject({ type: 'Agent', paused: true });
    expect('schedule' in frontmatter).toBe(false);
    // …and it opens on its page, where it is configured (M55.12).
    await waitFor(() =>
      expect(useNavStore.getState().selection).toEqual({
        kind: 'doc',
        path: 'records/skills/new-skill.md',
      }),
    );
  });
});

it('library duty names a waiting follow-up instead of claiming nothing can fire it', () => {
  const entry = {
    ...makeEntry({ path: 'agents/scout.md', title: 'Scout', type: 'Agent' }),
    properties: { slug: 'scout' },
  };
  const row = {
    followupId: 'id',
    actor: 'process:scout',
    note: 'check',
    dueAt: '2026-10-15T12:00:00Z',
    requestedAt: '2026-10-15T12:00:00Z',
    requestedByRun: 'run',
    state: 'pending' as const,
    claimedAt: null,
    runId: null,
    endedAt: null,
    cancelReason: null,
  };
  expect(libraryCards('agent', [entry], new Date(row.dueAt), [row])[0].duty).toEqual({
    on: true,
    reason:
      'No schedule and no trigger — a follow-up it booked will run it while Learn on its own is on',
  });
});
