// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageWrite } from '@/engine/attribution';
import { makeEntry } from '@/engine/testHelpers';
import type { FleetRefusal, FleetRun, FleetRunDetail } from '@/lib/ipc';
import { __seedRunHistoryRegistry } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { RunDetailPanel } from './RunDetailPanel';

/**
 * One run, opened (M56.9): why it started, which model answered, its
 * transcript, and what it was refused, each saying when it was not recorded.
 */

const knowledgeReads = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return {
    ...actual,
    runKnowledgeWrites: knowledgeReads,
    fleetRunTranscript: () => Promise.reject(new Error('not asked for in these tests')),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function run(over: Partial<FleetRun> = {}): FleetRun {
  return {
    run_id: 'run-scout-1',
    actor: 'process:release-scout',
    vault_id: 'demo',
    mode: 'ambient',
    lane: 'scheduled',
    started_at: '2026-07-28T09:15:00Z',
    ended_at: '2026-07-28T09:19:00Z',
    outcome: 'succeeded',
    usage_state: 'exact',
    input_tokens: 12_060,
    output_tokens: 880,
    proposals_submitted: 1,
    applied: 1,
    rejected: 0,
    parent_run_id: null,
    cause: {
      kind: 'schedule',
      why: 'its schedule came due',
      subject: null,
      detail: 'weekdays 08:30',
      due_at: '2026-07-28T08:30:00.000Z',
    },
    cli_session_id: '00000000-0000-4000-8000-000000000001',
    ...over,
  };
}

function refusal(n: number, over: Partial<FleetRefusal> = {}): FleetRefusal {
  return {
    code: 'write_outside_scope',
    surface: 'create_note',
    detail: `refusal ${n}`,
    rule: null,
    recorded_at: '2026-07-28T09:18:00.000Z',
    ...over,
  };
}

function detail(over: Partial<FleetRunDetail> = {}): FleetRunDetail {
  return {
    run: run(),
    cost_components: null,
    assembly: null,
    model_id: 'claude-opus-5',
    refusals: [],
    refusals_total: 0,
    wrote: { state: 'not_recorded' },
    ...over,
  };
}

function wrote(over: Partial<PageWrite> = {}): PageWrite {
  return {
    kind: 'vault.write',
    path: 'records/risks/risk-scanner-delivery.md',
    to: null,
    at: '2026-07-28T09:17:00.000Z',
    approved_by: null,
    ...over,
  };
}

async function show(d: FleetRunDetail) {
  render(<RunDetailPanel detail={d} onClose={() => {}} />);
  await waitFor(() => expect(screen.queryByText('Resolving origin…')).toBeNull());
}

describe('RunDetailPanel', () => {
  beforeEach(() => {
    knowledgeReads.mockReset().mockResolvedValue(null);
    __seedRunHistoryRegistry({ '/demo-vault': 'demo', '/other-vault': 'other' });
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entriesVault: '/demo-vault',
      status: 'ready',
      entries: [],
    });
  });

  it('keeps missing and unrecorded origins out of the active vault with the same paths', async () => {
    const path = 'records/risks/risk-scanner-delivery.md';
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [makeEntry({ path, title: 'Wrong vault page' })],
    });
    await show(
      detail({
        run: run({
          vault_id: 'removed',
          cause: { kind: 'event', why: 'page changed', subject: path, detail: null, due_at: null },
        }),
        wrote: { state: 'recorded', writes: [wrote()] },
      }),
    );
    expect(await screen.findByText(/Origin unavailable/)).toBeTruthy();
    expect(screen.getByTestId('run-detail-page').tagName).toBe('SPAN');
    expect(screen.getByTestId('run-detail-subject').tagName).toBe('SPAN');
    expect(screen.queryByTestId('run-detail-agent')).toBeNull();
    expect(knowledgeReads).not.toHaveBeenCalled();
    expect(screen.queryByText('Wrong vault page')).toBeNull();
    cleanup();
    await show(detail({ run: run({ vault_id: null }) }));
    expect(await screen.findByText('Origin not recorded.')).toBeTruthy();
    expect(knowledgeReads).not.toHaveBeenCalled();
  });

  it('reads Knowledge from the recorded origin and preserves an unavailable read for retry', async () => {
    useVaultStore.setState({ vaultPath: '/demo-vault' });
    knowledgeReads.mockRejectedValueOnce(new Error('ledger unavailable')).mockResolvedValueOnce([]);
    await show(detail({ run: run({ vault_id: 'other' }) }));
    expect(
      await screen.findByText(/Couldn't read what this run changed in Knowledge/),
    ).toBeTruthy();
    expect(knowledgeReads).toHaveBeenCalledWith('/other-vault', 'run-scout-1');
    expect(
      within(screen.getByTestId('run-detail-knowledge')).queryByText(/not recorded/),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Knowledge' }));
    expect(await screen.findByText('Changed nothing in Knowledge.')).toBeTruthy();
  });

  it('opens a written page in its recorded vault only after the normal switch succeeds', async () => {
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      status: 'ready',
      entriesVault: '/demo-vault',
    });
    useNavStore.setState({ selection: { kind: 'home' } });
    const open = vi.spyOn(useVaultStore.getState(), 'openVault').mockResolvedValue(undefined);
    await show(
      detail({ run: run({ vault_id: 'other' }), wrote: { state: 'recorded', writes: [wrote()] } }),
    );
    await waitFor(() => expect(screen.getByTestId('run-detail-page').tagName).toBe('BUTTON'));
    fireEvent.click(screen.getByTestId('run-detail-page'));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('/other-vault', {
        stillCurrent: expect.any(Function),
        leaveIntent: { surface: expect.any(String), isCurrent: expect.any(Function) },
      }),
    );
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
    open.mockImplementation(async (path) => {
      useVaultStore.setState({ vaultPath: path, entriesVault: path, status: 'ready' });
    });
    fireEvent.click(screen.getByTestId('run-detail-page'));
    await waitFor(() =>
      expect(useNavStore.getState().selection).toEqual({
        kind: 'doc',
        path: 'records/risks/risk-scanner-delivery.md',
      }),
    );
    expect(useVaultStore.getState().vaultPath).toBe('/other-vault');
  });

  it('says why the run started, how late, and when it was due', async () => {
    await show(detail());
    const why = screen.getByTestId('run-detail-why');
    expect(within(why).getByTestId('run-why').textContent).toBe(
      'its schedule came due (weekdays 08:30) · ran 45m late',
    );
    const due = screen.getByTestId('run-detail-due');
    expect(due.textContent).toMatch(/^due .+ · started .+$/);
    expect(due.querySelector('[title="2026-07-28T08:30:00.000Z"]')).toBeTruthy();
  });

  it('a run with no cause reads why not recorded', async () => {
    await show(detail({ run: run({ cause: null }) }));
    expect(screen.getByTestId('run-why').textContent).toBe('why not recorded');
    expect(screen.queryByTestId('run-detail-due')).toBeNull();
  });

  it('the subject opens its page when the origin vault holds it, and is plain text otherwise', async () => {
    const page = makeEntry({
      path: 'records/risks/risk-scanner-delivery.md',
      filename: 'risk-scanner-delivery.md',
      folder: 'records/risks',
      title: 'Scanner delivery',
    });
    useVaultStore.setState({ entries: [page] });
    const about = (subject: string) =>
      run({
        cause: { kind: 'event', why: 'a page changed', subject, detail: null, due_at: null },
      });
    await show(detail({ run: about(page.path) }));
    await waitFor(() => expect(screen.getByTestId('run-detail-subject').tagName).toBe('BUTTON'));
    const subject = screen.getByTestId('run-detail-subject');
    expect(subject.tagName).toBe('BUTTON');
    expect(subject.textContent).toBe('Scanner delivery');
    fireEvent.click(subject);
    await waitFor(() =>
      expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: page.path }),
    );

    cleanup();
    await show(detail({ run: about('records/gone.md') }));
    const gone = screen.getByTestId('run-detail-subject');
    expect(gone.tagName).toBe('SPAN');
    expect(gone.textContent).toBe('records/gone.md');
  });

  it('names the model as Claude Code reported it, or says not recorded', async () => {
    await show(detail());
    const model = screen.getByTestId('run-detail-model');
    expect(model.textContent).toBe('claude-opus-5');
    expect(model.getAttribute('title')).toBe('as Claude Code reported it');
    cleanup();
    await show(detail({ model_id: null }));
    expect(screen.getByTestId('run-detail-model').textContent).toBe('not recorded');
  });

  it('lists what the run was refused, each code in words', async () => {
    await show(
      detail({
        refusals: [
          refusal(1, {
            detail: 'This run is scoped to records/risks and cannot write to records/work.',
          }),
          refusal(2, {
            code: 'capability_unavailable',
            surface: 'agent.permission',
            detail: 'the CLI denied 1 call(s) this run: Bash',
            recorded_at: '2026-07-28T09:18:30.000Z',
          }),
        ],
        refusals_total: 2,
      }),
    );
    const rows = screen.getAllByTestId('run-detail-refusal');
    expect(rows.map((r) => r.textContent)).toEqual([
      'create_note · write outside scope — This run is scoped to records/risks and cannot write to records/work.',
      'agent.permission · capability unavailable — the CLI denied 1 call(s) this run: Bash',
    ]);
    expect(rows[1].getAttribute('data-code')).toBe('capability_unavailable');
    expect(rows[1].getAttribute('data-surface')).toBe('agent.permission');
    expect(rows[1].getAttribute('title')).toBe('2026-07-28T09:18:30.000Z');
    expect(screen.queryByTestId('run-detail-refused-more')).toBeNull();
  });

  it('counts the refusals the list leaves out', async () => {
    const shown = Array.from({ length: 50 }, (_, n) => refusal(n));
    await show(detail({ refusals: shown, refusals_total: 60 }));
    expect(screen.getAllByTestId('run-detail-refusal')).toHaveLength(50);
    expect(screen.getByTestId('run-detail-refused-more').textContent).toBe('and 10 more not shown');
  });

  it('a run refused nothing says so', async () => {
    await show(detail());
    expect(screen.getByTestId('run-detail-refused').textContent).toContain(
      'No refusal recorded for this run.',
    );
  });

  it('a run with no session says its transcript was not recorded', async () => {
    await show(detail({ run: run({ cli_session_id: null }) }));
    expect(screen.getByTestId('run-transcript-state').textContent).toBe(
      'Transcript not recorded for this run.',
    );
  });

  it('names the pages the run wrote, each opening its page, and leaves Knowledge out', async () => {
    const page = makeEntry({
      path: 'records/risks/risk-scanner-delivery.md',
      filename: 'risk-scanner-delivery.md',
      folder: 'records/risks',
      title: 'Scanner delivery',
    });
    useVaultStore.setState({ entries: [page] });
    await show(
      detail({
        wrote: {
          state: 'recorded',
          writes: [
            wrote(),
            wrote({ path: 'knowledge/systems/pick-queue-drain.md' }),
            wrote({ kind: 'vault.create', path: 'records/risks/new.md', approved_by: 'human:me' }),
          ],
        },
      }),
    );
    await waitFor(() => expect(screen.getAllByTestId('run-detail-page')[0].tagName).toBe('BUTTON'));
    const pages = screen.getByTestId('run-detail-pages');
    const rows = within(pages).getAllByTestId('run-detail-page');
    expect(rows.map((r) => [r.dataset.path, r.textContent])).toEqual([
      ['records/risks/risk-scanner-delivery.md', 'Scanner deliverychanged'],
      ['records/risks/new.md', 'records/risks/new.mdcreated · you allowed it'],
    ]);
    expect(within(pages).queryByTestId('run-detail-shell-unrecorded')).toBeNull();
    fireEvent.click(rows[0]);
    await waitFor(() =>
      expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: page.path }),
    );
  });

  it('a booked run that wrote nothing says it wrote no pages', async () => {
    await show(detail({ wrote: { state: 'recorded', writes: [] } }));
    expect(screen.getByTestId('run-detail-pages').textContent).toContain('Wrote no pages');
  });

  it('a run that wrote only Knowledge pages wrote no pages here', async () => {
    await show(
      detail({
        wrote: { state: 'recorded', writes: [wrote({ path: 'knowledge/systems/x.md' })] },
      }),
    );
    const pages = screen.getByTestId('run-detail-pages');
    expect(within(pages).queryByTestId('run-detail-page')).toBeNull();
    expect(pages.textContent).toContain('Wrote no pages');
  });

  it('a run whose shell could write never reads complete', async () => {
    await show(detail({ wrote: { state: 'partial', writes: [] } }));
    const pages = screen.getByTestId('run-detail-pages');
    expect(pages.textContent).not.toContain('Wrote no pages');
    expect(within(pages).getByTestId('run-detail-shell-unrecorded').textContent).toBe(
      'Shell changes not recorded',
    );
  });

  it('a run from before writes were booked reads not recorded, never wrote nothing', async () => {
    await show(detail());
    const pages = screen.getByTestId('run-detail-pages');
    expect(pages.textContent).toBe('Pages written: not recorded');
    expect(pages.textContent).not.toContain('Wrote no pages');
  });

  it('still never says $0', async () => {
    await show(detail({ model_id: null }));
    const text = screen.getByTestId('run-detail').textContent ?? '';
    expect(text).not.toMatch(/\$0\b/);
    expect(text).toContain('not recorded');
  });
});
