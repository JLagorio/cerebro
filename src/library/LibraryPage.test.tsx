import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
 * M18 — the library as a workflow rather than a directory: the shelves, the
 * cards, and where each kind opens. An agent's editor is its page since
 * M55.12; its grant rows are tested in AgentProperties.test.tsx.
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
      history: [{ kind: 'home' }, stale],
      historyIndex: 1,
    });
    const { container } = render(<LibraryPage />);
    await waitFor(() =>
      expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: AGENT.path }),
    );
    expect(useNavStore.getState().history).toEqual([
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
