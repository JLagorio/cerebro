// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { AgentMemoryTab } from './AgentMemoryTab';

/*
 * An agent page's Memory tab (M55.12): your corrections (human-only, on
 * blur), the agent's own notes (read-only, D7), and the concepts it wrote.
 */
const SCOUT = 'records/agents/release-scout.md';
const KNOWLEDGE = 'records/agents/knowledge.md';

const patch = vi.fn(async (_path: string, _patch: Record<string, unknown>) => true);

function Host({ path }: { path: string }) {
  const entry = useVaultStore((s) => s.entries.find((e) => e.path === path));
  return entry === undefined ? null : <AgentMemoryTab entry={entry} />;
}

function withProperties(path: string, extra: Record<string, unknown>) {
  act(() =>
    useVaultStore.setState({
      entries: useVaultStore
        .getState()
        .entries.map((e) =>
          e.path === path ? { ...e, properties: { ...e.properties, ...extra } as never } : e,
        ),
    }),
  );
}

describe('AgentMemoryTab', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    useVaultStore.setState({ patchFrontmatter: patch as never });
  });
  afterEach(cleanup);

  it('commits your corrections on blur, writing preferences alone', () => {
    render(<Host path={SCOUT} />);
    const box = screen.getByTestId('agent-preferences');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Never file a risk without an owner.' } });
    expect(patch).not.toHaveBeenCalled();
    fireEvent.blur(box);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(SCOUT, {
      preferences: 'Never file a risk without an owner.',
    });
  });

  it('an emptied correction removes the key, and an untouched one writes nothing', () => {
    withProperties(SCOUT, { preferences: 'Be brief.' });
    render(<Host path={SCOUT} />);
    const box = screen.getByTestId('agent-preferences');
    fireEvent.focus(box);
    fireEvent.blur(box);
    expect(patch).not.toHaveBeenCalled();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '  ' } });
    fireEvent.blur(box);
    expect(patch).toHaveBeenCalledWith(SCOUT, { preferences: null });
  });

  it('a rescan does not overwrite a draft you are typing', () => {
    render(<Host path={SCOUT} />);
    const box = screen.getByTestId('agent-preferences') as HTMLTextAreaElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Half a thought' } });
    withProperties(SCOUT, { preferences: 'From the disk' });
    expect(box.value).toBe('Half a thought');
    fireEvent.blur(box);
    withProperties(SCOUT, { preferences: 'Later from the disk' });
    expect(box.value).toBe('Later from the disk');
  });

  // M56.13 — `preferences: "Ask [[maya-chen]] before touching [[atlas]]"`
  // reaches the app as a relation, its prose dropped by the scan. Saving the
  // rebuilt links would erase "Ask" and "before touching" from disk.
  it('never saves over corrections whose value holds [[links]]', () => {
    act(() =>
      useVaultStore.setState({
        entries: useVaultStore
          .getState()
          .entries.map((e) =>
            e.path === SCOUT
              ? { ...e, relationships: { ...e.relationships, preferences: ['maya-chen', 'atlas'] } }
              : e,
          ),
      }),
    );
    render(<Host path={SCOUT} />);
    const box = screen.getByTestId('agent-preferences') as HTMLTextAreaElement;
    expect(box.value).toBe('[[maya-chen]]\n[[atlas]]');
    expect(box.readOnly).toBe(true);
    expect(screen.getByTestId('agent-preferences-linked').textContent).toMatch(
      /holds \[\[links\]\].*keeps only the\s+links/s,
    );
    fireEvent.focus(box);
    fireEvent.change(box, {
      target: { value: '[[maya-chen]]\n[[atlas]]\nNever file a risk without an owner.' },
    });
    fireEvent.blur(box);
    expect(patch).not.toHaveBeenCalled();
  });

  it('keeps the box editable, with no notice, for plain corrections', () => {
    render(<Host path={SCOUT} />);
    expect((screen.getByTestId('agent-preferences') as HTMLTextAreaElement).readOnly).toBe(false);
    expect(screen.queryByTestId('agent-preferences-linked')).toBeNull();
  });

  it('shows the agent’s own notes read-only, and says when there are none', () => {
    render(<Host path={SCOUT} />);
    const recent = screen.getByTestId('agent-recent');
    expect(recent.textContent).toBe('Nothing kept yet.');
    expect(recent.tagName).toBe('P');
    expect(screen.getByText(/Read-only here: saving over it would erase what a run learned/)).toBe(
      screen.getByText(/What the agent keeps between runs/),
    );
    cleanup();
    withProperties(SCOUT, { recent: 'Last run found two.' });
    render(<Host path={SCOUT} />);
    expect(screen.getByTestId('agent-recent').textContent).toBe('Last run found two.');
  });

  it('lists what the Knowledge agent wrote, and that it maintains Knowledge', () => {
    render(<Host path={KNOWLEDGE} />);
    const wrote = screen.getAllByTestId('agent-wrote');
    expect(wrote.map((w) => w.getAttribute('data-path')).sort()).toEqual([
      'knowledge/playbooks/warehouse-cutover.md',
      'knowledge/systems/pick-queue-drain.md',
    ]);
    expect(screen.getByTestId('agent-maintains').textContent).toContain('Maintains Knowledge');
  });

  it('says when an agent has not written a concept yet', () => {
    render(<Host path={SCOUT} />);
    expect(screen.getByTestId('agent-knowledge').textContent).toContain(
      'It has not written a concept yet.',
    );
    expect(screen.queryByTestId('agent-maintains')).toBeNull();
  });
});
