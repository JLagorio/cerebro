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
      entries: [SKILL, AGENT, TEMPLATE],
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
    fireEvent.change(scope, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(vi.mocked(ipc.updateFrontmatter)).toHaveBeenCalled());
    expect(vi.mocked(ipc.updateFrontmatter).mock.calls[0][2].scope).toEqual([]);
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
