import { createClientToken, __seedClientTokens } from '@/lib/mockIpc';
import { useClientAccessStore } from '@/stores/clientAccessStore';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { AccessSummary, PageAccess } from './PageAccess';

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
  useClientAccessStore.getState().reset(VAULT);
  opened.mockReset();
  await useVaultStore.getState().openVault(VAULT);
  useUiStore.setState({ agentShell: 'off', agentDelegate: true, panelAgents: { [VAULT]: null } });
});
afterEach(cleanup);

describe('PageAccess', () => {
  it('summarises on the header, and lists the rows that can change the page', () => {
    render(<PageAccess entry={page(RISK)} />);
    // The inspector's section names it; the list repeats no heading of its
    // own, and no summary sentence either: the header says it (AccessSummary).
    expect(screen.queryByText('Who can change this page')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByTestId('page-access-summary')).toBeNull();
    render(<AccessSummary entry={page(RISK)} />);
    expect(screen.getByTestId('page-access-summary').textContent).toBe(
      '1 of 2 agents can change it',
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
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    // A quiet disclosure row: its words stay, its state turns.
    expect(toggle.textContent).toBe("1 more can't change it");
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const knowledge = rowOf('process:knowledge');
    expect(knowledge?.dataset).toMatchObject({ write: 'no', read: 'yes' });
    expect(
      within(screen.getByTestId('page-access-others')).getAllByTestId('page-access-row'),
    ).toHaveLength(1);
  });

  // Owner, 2026-10-18 — "that right side panel is disgusting": every agent's
  // every reason stood open under it, a wall of small print.
  it('draws each agent as one line, its reasons folded under it until asked', () => {
    render(<PageAccess entry={page(RISK)} />);
    const scout = rowOf('process:release-scout') as HTMLElement;
    const why = within(scout).getByTestId('page-access-why');
    const reasons = within(scout).getAllByTestId('page-access-reason');
    const list = reasons[0].closest('ul') as HTMLElement;
    // Folded, and still in the DOM, so what the row says is always there.
    expect(list.hidden).toBe(true);
    expect(why.getAttribute('aria-expanded')).toBe('false');
    expect(why.getAttribute('aria-controls')).toBe(list.id);
    // Its name says whose status it is; the status is its visible words.
    expect(screen.getByRole('button', { name: 'Release scout: Can change it' })).toBe(why);
    expect(within(why).getByTestId('page-access-status').textContent).toBe('Can change it');
    fireEvent.click(why);
    expect(why.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);
    fireEvent.click(why);
    expect(list.hidden).toBe(true);
  });

  it('keeps its explanations in tooltips, not paragraphs', async () => {
    render(
      <>
        <AccessSummary entry={page(RISK)} />
        <PageAccess entry={page(RISK)} />
      </>,
    );
    const rule = 'You can always change this page. An agent can only as its grant allows.';
    expect(screen.queryByText(rule)).toBeNull();
    expect(screen.getByTestId('page-access-summary').title).toBe(
      `1 of 2 agents can change this page. ${rule}`,
    );
    // Connector tools are never counted, and the apps line's tooltip says so.
    expect(screen.queryByText(/Connector tools/)).toBeNull();
    await screen.findByText('No other app can change it');
    expect(screen.getByTestId('page-client-access').title).toBe(
      'Connector tools act outside the vault’s checks, so they are not counted here.',
    );
  });

  it("opens an agent's page from its title", () => {
    render(<PageAccess entry={page(RISK)} />);
    const scout = rowOf('process:release-scout') as HTMLElement;
    fireEvent.click(within(scout).getByTestId('page-access-agent'));
    expect(opened).toHaveBeenCalledWith('records/agents/release-scout.md');
  });

  it('re-derives the panel row when the Settings shell ceiling changes', () => {
    render(
      <>
        <AccessSummary entry={page(TYPE_DOC)} />
        <PageAccess entry={page(TYPE_DOC)} />
      </>,
    );
    expect(screen.getByTestId('page-access-summary').textContent).toBe('No agent can change it');
    expect(panelRow()).toBeUndefined();
    act(() => useUiStore.setState({ agentShell: 'on' }));
    expect(panelRow()?.dataset.write).toBe('yes');
    expect(
      within(panelRow() as HTMLElement)
        .getAllByTestId('page-access-reason')
        .map((r) => r.textContent),
    ).toContain('Shell is On: it can change any file in the vault folder, past every rule above.');
  });

  // M91.2d: the panel says whether, while you watch, it can hand reading to
  // a researcher, as the Subagents switch in Settings stands.
  it('re-derives the panel row when the Settings Subagents switch changes', () => {
    const researcher =
      'While you watch, it can hand reading to a researcher that reports back and changes nothing.';
    render(<PageAccess entry={page(RISK)} />);
    const reasons = () =>
      within(panelRow() as HTMLElement)
        .getAllByTestId('page-access-reason')
        .map((r) => r.textContent);
    expect(reasons()).toContain(researcher);
    expect(reasons()).not.toContain('Subagents are Off in Settings.');
    act(() => useUiStore.setState({ agentDelegate: false }));
    expect(reasons()).toContain('Subagents are Off in Settings.');
    expect(reasons()).not.toContain(researcher);
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

describe('other apps in the access section', () => {
  it('names a writing token and preserves read-only attribution without claiming a writer', async () => {
    await createClientToken(VAULT, {
      name: 'Editor',
      toolsets: ['read', 'write'],
      writeScope: ['records/risks'],
      readScope: null,
    });
    await createClientToken(VAULT, {
      name: 'Reader',
      toolsets: ['read'],
      writeScope: [],
      readScope: null,
    });
    render(<PageAccess entry={page(RISK)} />);
    await screen.findByText('Other apps that can change it: Editor');
    expect(rowOf('client:editor')?.dataset).toMatchObject({ write: 'yes', read: 'yes' });
    expect(rowOf('client:reader')?.dataset).toMatchObject({ write: 'no', read: 'yes' });
    // An app's line reads like an agent's: what it can do here, its reason
    // folded under it.
    const status = (actor: string) =>
      within(rowOf(actor) as HTMLElement).getByTestId('page-access-status').textContent;
    expect([status('client:editor'), status('client:reader')]).toEqual([
      'Can change it',
      'Can read it',
    ]);
    const reason = within(rowOf('client:reader') as HTMLElement).getByTestId('page-access-reason');
    expect(reason.textContent).toBe('Its token only reads.');
    expect(reason.closest('ul')?.hidden).toBe(true);
  });
  it('protects governed pages and ignores tokens for a different vault', async () => {
    await createClientToken(VAULT, {
      name: 'Editor',
      toolsets: ['read', 'write'],
      writeScope: ['types'],
      readScope: null,
    });
    await createClientToken('/other', {
      name: 'Other',
      toolsets: ['read', 'write'],
      writeScope: ['types'],
      readScope: null,
    });
    render(<PageAccess entry={page(TYPE_DOC)} />);
    await screen.findByText('No other app can change it');
    expect(rowOf('client:editor')?.dataset.write).toBe('no');
    expect(rowOf('client:other')).toBeUndefined();
  });
  it('says a failed token read is unavailable, never that no app can write', async () => {
    __seedClientTokens(null);
    render(<PageAccess entry={page(RISK)} />);
    await screen.findByText('Couldn’t read which other apps have tokens.');
    expect(screen.queryByText('No other app can change it')).toBeNull();
  });
});
