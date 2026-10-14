// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { AGENT_TABS, AgentPageBody, agentTabOf } from './AgentPage';

/*
 * What an agent page puts between its title and its body (M55.12): the duty
 * bar and the properties on every tab, then a fixed strip of the app's own
 * three tabs.
 */
const SCOUT = 'records/agents/release-scout.md';

describe('agentTabOf', () => {
  it('names the three tabs, and anything else is Instructions', () => {
    expect(AGENT_TABS.map((t) => t.id)).toEqual(['instructions', 'runs', 'memory']);
    expect(agentTabOf('runs')).toBe('runs');
    expect(agentTabOf('memory')).toBe('memory');
    expect(agentTabOf(undefined)).toBe('instructions');
    expect(agentTabOf('overview')).toBe('instructions');
  });
});

describe('AgentPageBody', () => {
  let entry: Entry;
  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    entry = useVaultStore.getState().entries.find((e) => e.path === SCOUT)!;
  });
  afterEach(cleanup);

  const body = (tab: 'instructions' | 'runs' | 'memory', onTab = vi.fn()) => {
    render(
      <AgentPageBody
        entry={entry}
        tab={tab}
        onTab={onTab}
        editor={<div data-testid="the-editor" />}
      />,
    );
    return onTab;
  };

  it('shows the duty bar, the properties and a fixed strip of three tabs', () => {
    body('instructions');
    expect(screen.getByTestId('agent-dossier')).toBeTruthy();
    expect(screen.getByTestId('agent-properties')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Instructions',
      'Runs',
      'Memory',
    ]);
    expect(screen.queryByTestId('new-record-tab')).toBeNull();
    expect(screen.getByTestId('the-editor')).toBeTruthy();
  });

  it('pressing Runs or Memory asks the host for that tab', () => {
    const onTab = body('instructions');
    fireEvent.click(screen.getByTestId('record-tab-runs'));
    expect(onTab).toHaveBeenCalledWith('runs');
    fireEvent.click(screen.getByTestId('record-tab-memory'));
    expect(onTab).toHaveBeenLastCalledWith('memory');
  });

  it('Runs shows the run history, not the editor', async () => {
    body('runs');
    // The corpus's release scout has a run of its own.
    expect(await screen.findByTestId('agent-runs')).toBeTruthy();
    expect(screen.queryByTestId('the-editor')).toBeNull();
    expect(screen.getByTestId('agent-dossier')).toBeTruthy();
  });

  it('Memory shows the memory tiers', () => {
    body('memory');
    expect(screen.getByTestId('agent-memory')).toBeTruthy();
    expect(screen.queryByTestId('the-editor')).toBeNull();
  });
});

describe('AgentPageBody across agents', () => {
  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
  });
  afterEach(cleanup);

  it('an editor open on one agent does not follow you to the next', () => {
    const entries = useVaultStore.getState().entries;
    const scout = entries.find((e) => e.path === SCOUT)!;
    const knowledge = entries.find((e) => e.path === 'records/agents/knowledge.md')!;
    const page = (entry: Entry) => (
      <AgentPageBody entry={entry} tab="instructions" onTab={vi.fn()} editor={null} />
    );
    const { rerender } = render(page(scout));
    fireEvent.click(within(screen.getByTestId('agent-prop-scope')).getByTestId('agent-prop-open'));
    expect(screen.getByTestId('agent-editor-scope')).toBeTruthy();
    rerender(page(knowledge));
    expect(screen.queryByTestId('agent-editor-scope')).toBeNull();
  });
});
