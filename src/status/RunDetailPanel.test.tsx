// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageWrite } from '@/engine/attribution';
import { makeEntry } from '@/engine/testHelpers';
import type { FleetRefusal, FleetRun, FleetRunDetail } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { RunDetailPanel } from './RunDetailPanel';

/**
 * One run, opened (M56.9): why it started, which model answered, its
 * transcript, and what it was refused, each saying when it was not recorded.
 */

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return {
    ...actual,
    runKnowledgeWrites: () => Promise.resolve(null),
    fleetRunTranscript: () => Promise.reject(new Error('not asked for in these tests')),
  };
});

afterEach(cleanup);

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

function show(d: FleetRunDetail) {
  render(<RunDetailPanel detail={d} onClose={() => {}} />);
}

describe('RunDetailPanel', () => {
  beforeEach(() => {
    useVaultStore.setState({ vaultPath: null, entries: [] });
  });

  it('says why the run started, how late, and when it was due', () => {
    show(detail());
    const why = screen.getByTestId('run-detail-why');
    expect(within(why).getByTestId('run-why').textContent).toBe(
      'its schedule came due (weekdays 08:30) · ran 45m late',
    );
    const due = screen.getByTestId('run-detail-due');
    expect(due.textContent).toMatch(/^due .+ · started .+$/);
    expect(due.querySelector('[title="2026-07-28T08:30:00.000Z"]')).toBeTruthy();
  });

  it('a run with no cause reads why not recorded', () => {
    show(detail({ run: run({ cause: null }) }));
    expect(screen.getByTestId('run-why').textContent).toBe('why not recorded');
    expect(screen.queryByTestId('run-detail-due')).toBeNull();
  });

  it('the subject opens its page when the vault holds it, and is plain text otherwise', () => {
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
    show(detail({ run: about(page.path) }));
    const subject = screen.getByTestId('run-detail-subject');
    expect(subject.tagName).toBe('BUTTON');
    expect(subject.textContent).toBe('Scanner delivery');
    fireEvent.click(subject);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: page.path });

    cleanup();
    show(detail({ run: about('records/gone.md') }));
    const gone = screen.getByTestId('run-detail-subject');
    expect(gone.tagName).toBe('SPAN');
    expect(gone.textContent).toBe('records/gone.md');
  });

  it('names the model as Claude Code reported it, or says not recorded', () => {
    show(detail());
    const model = screen.getByTestId('run-detail-model');
    expect(model.textContent).toBe('claude-opus-5');
    expect(model.getAttribute('title')).toBe('as Claude Code reported it');
    cleanup();
    show(detail({ model_id: null }));
    expect(screen.getByTestId('run-detail-model').textContent).toBe('not recorded');
  });

  it('lists what the run was refused, each code in words', () => {
    show(
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

  it('counts the refusals the list leaves out', () => {
    const shown = Array.from({ length: 50 }, (_, n) => refusal(n));
    show(detail({ refusals: shown, refusals_total: 60 }));
    expect(screen.getAllByTestId('run-detail-refusal')).toHaveLength(50);
    expect(screen.getByTestId('run-detail-refused-more').textContent).toBe('and 10 more not shown');
  });

  it('a run refused nothing says so', () => {
    show(detail());
    expect(screen.getByTestId('run-detail-refused').textContent).toContain(
      'No refusal recorded for this run.',
    );
  });

  it('a run with no session says its transcript was not recorded', () => {
    show(detail({ run: run({ cli_session_id: null }) }));
    expect(screen.getByTestId('run-transcript-state').textContent).toBe(
      'Transcript not recorded for this run.',
    );
  });

  it('names the pages the run wrote, each opening its page, and leaves Knowledge out', () => {
    const page = makeEntry({
      path: 'records/risks/risk-scanner-delivery.md',
      filename: 'risk-scanner-delivery.md',
      folder: 'records/risks',
      title: 'Scanner delivery',
    });
    useVaultStore.setState({ entries: [page] });
    show(
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
    const pages = screen.getByTestId('run-detail-pages');
    const rows = within(pages).getAllByTestId('run-detail-page');
    expect(rows.map((r) => [r.dataset.path, r.textContent])).toEqual([
      ['records/risks/risk-scanner-delivery.md', 'Scanner deliverychanged'],
      ['records/risks/new.md', 'records/risks/new.mdcreated · you allowed it'],
    ]);
    expect(within(pages).queryByTestId('run-detail-shell-unrecorded')).toBeNull();
    fireEvent.click(rows[0]);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: page.path });
  });

  it('a booked run that wrote nothing says it wrote no pages', () => {
    show(detail({ wrote: { state: 'recorded', writes: [] } }));
    expect(screen.getByTestId('run-detail-pages').textContent).toContain('Wrote no pages');
  });

  it('a run that wrote only Knowledge pages wrote no pages here', () => {
    show(
      detail({
        wrote: { state: 'recorded', writes: [wrote({ path: 'knowledge/systems/x.md' })] },
      }),
    );
    const pages = screen.getByTestId('run-detail-pages');
    expect(within(pages).queryByTestId('run-detail-page')).toBeNull();
    expect(pages.textContent).toContain('Wrote no pages');
  });

  it('a run whose shell could write never reads complete', () => {
    show(detail({ wrote: { state: 'partial', writes: [] } }));
    const pages = screen.getByTestId('run-detail-pages');
    expect(pages.textContent).not.toContain('Wrote no pages');
    expect(within(pages).getByTestId('run-detail-shell-unrecorded').textContent).toBe(
      'Shell changes not recorded',
    );
  });

  it('a run from before writes were booked reads not recorded, never wrote nothing', () => {
    show(detail());
    const pages = screen.getByTestId('run-detail-pages');
    expect(pages.textContent).toBe('Pages written: not recorded');
    expect(pages.textContent).not.toContain('Wrote no pages');
  });

  it('still never says $0', () => {
    show(detail({ model_id: null }));
    const text = screen.getByTestId('run-detail').textContent ?? '';
    expect(text).not.toMatch(/\$0\b/);
    expect(text).toContain('not recorded');
  });
});
