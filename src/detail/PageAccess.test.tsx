// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { PageAccess } from './PageAccess';

const opened = vi.fn();
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => opened }));

const RISK = 'records/risks/risk-rollback-unrehearsed.md';
const TYPE_DOC = 'types/decision.md';
const VAULT = '/demo-vault';

function page(path: string): Entry {
  const found = useVaultStore.getState().entries.find((e) => e.path === path);
  if (found === undefined) throw new Error(`fixture vault has no ${path}`);
  return found;
}

const rows = () => screen.queryAllByTestId('page-access-row');
const rowOf = (actor: string, panel = false) =>
  rows().find((r) => r.dataset.actor === actor && (r.dataset.panel === 'yes') === panel);
const panelRow = () => rows().find((r) => r.dataset.panel === 'yes');

beforeEach(async () => {
  resetMockFs();
  opened.mockReset();
  await useVaultStore.getState().openVault(VAULT);
  useUiStore.setState({ agentShell: 'off', panelAgents: { [VAULT]: null } });
});
afterEach(cleanup);

describe('PageAccess', () => {
  it('summarises, and lists the rows that can change the page with their attributes', () => {
    render(<PageAccess entry={page(RISK)} />);
    expect(screen.getByText('Who can change this page')).toBeTruthy();
    expect(screen.getByTestId('page-access-summary').textContent).toBe(
      '1 of 2 agents can change this page.',
    );
    const scout = rowOf('process:release-scout');
    expect(scout?.dataset).toMatchObject({ write: 'yes', read: 'yes', unattended: 'yes' });
    expect(
      within(scout as HTMLElement)
        .getAllByTestId('page-access-reason')
        .map((r) => r.textContent),
    ).toContain('Inside its write scope: records/risks/.');
    expect(panelRow()?.dataset).toMatchObject({
      actor: 'claude-code',
      write: 'yes',
      unattended: 'no',
    });
  });

  it("folds the rows that can't change the page", () => {
    render(<PageAccess entry={page(RISK)} />);
    expect(rowOf('process:knowledge')).toBeUndefined();
    const toggle = screen.getByTestId('page-access-others-toggle');
    expect(toggle.textContent).toBe("1 more can't change it");
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe('Hide');
    const knowledge = rowOf('process:knowledge');
    expect(knowledge?.dataset).toMatchObject({ write: 'no', read: 'yes' });
    expect(
      within(screen.getByTestId('page-access-others')).getAllByTestId('page-access-row'),
    ).toHaveLength(1);
  });

  it("opens an agent's page from its title", () => {
    render(<PageAccess entry={page(RISK)} />);
    const scout = rowOf('process:release-scout') as HTMLElement;
    fireEvent.click(within(scout).getByTestId('page-access-agent'));
    expect(opened).toHaveBeenCalledWith('records/agents/release-scout.md');
  });

  it('re-derives the panel row when the Settings shell ceiling changes', () => {
    render(<PageAccess entry={page(TYPE_DOC)} />);
    expect(screen.getByTestId('page-access-summary').textContent).toBe(
      'No agent can change this page.',
    );
    expect(panelRow()).toBeUndefined();
    act(() => useUiStore.setState({ agentShell: 'on' }));
    expect(panelRow()?.dataset.write).toBe('yes');
    expect(
      within(panelRow() as HTMLElement)
        .getAllByTestId('page-access-reason')
        .map((r) => r.textContent),
    ).toContain('Shell is On: it can change any file in the vault folder, past every rule above.');
  });

  it('names the agent a bound panel answers as', () => {
    useUiStore.setState({ panelAgents: { [VAULT]: 'release-scout' } });
    render(<PageAccess entry={page(RISK)} />);
    expect(
      within(panelRow() as HTMLElement)
        .getAllByTestId('page-access-reason')
        .map((r) => r.textContent),
    ).toContain('Answers as Release scout here.');
  });
});
