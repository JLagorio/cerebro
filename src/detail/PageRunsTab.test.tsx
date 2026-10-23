import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { buildSchema } from '@/engine/schema';
import type { FleetRun, FleetRunDetail } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import { PageRunsTab } from './PageRunsTab';

const { read, detail, event } = vi.hoisted(() => ({
  read: vi.fn(),
  detail: vi.fn(),
  event: { listener: null as ((value: { kind: string }) => void) | null },
}));
vi.mock('@/lib/ipc', async () => ({
  ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
  fleetSubjectRuns: read,
  fleetRunDetail: detail,
}));
vi.mock('@/agent/agentIpc', () => ({
  onAgentEvent: (listener: typeof event.listener) => {
    event.listener = listener;
    return () => {
      event.listener = null;
    };
  },
}));
vi.mock('@/status/RunDetailPanel', () => ({
  RunDetailPanel: ({ detail, onClose }: { detail: FleetRunDetail; onClose: () => void }) => (
    <div data-testid="opened-run">
      {detail.run.run_id}
      <button onClick={onClose}>Close run</button>
    </div>
  ),
}));
const host = makeEntry({
  path: 'project.md',
  filename: 'project.md',
  title: 'Launch',
  type: 'Project',
});
const scout = makeEntry({
  path: 'agents/scout.md',
  title: 'Scout',
  type: 'Agent',
  properties: { slug: 'scout' },
});
const work = makeEntry({
  path: 'work/a.md',
  title: 'Ship docs',
  type: 'Task',
  relationships: { project: ['project'] },
});
const projectType = makeEntry({
  path: 'types/project.md',
  title: 'Project',
  type: 'Type',
  properties: {
    tabs: [
      { id: 'tasks', name: 'Tasks', content: 'view', source: { type: 'Task' }, scope: 'related' },
    ],
  } as never,
});
const taskType = makeEntry({
  path: 'types/task.md',
  title: 'Task',
  type: 'Type',
  properties: { fields: { project: { kind: 'relation', target: 'Project' } } } as never,
});
const entries = [host, scout, work, projectType, taskType];
const run = (over: Partial<FleetRun> = {}): FleetRun => ({
  run_id: 'root',
  actor: 'process:scout',
  vault_id: 'vault',
  mode: 'ambient',
  lane: 'filed',
  started_at: '2026-07-28T12:00:00Z',
  ended_at: '2026-07-28T12:01:00Z',
  outcome: 'succeeded',
  usage_state: 'exact',
  input_tokens: 1,
  output_tokens: 1,
  proposals_submitted: 0,
  applied: 0,
  rejected: 0,
  parent_run_id: null,
  cause: {
    kind: 'assigned',
    why: 'work was assigned to it',
    subject: work.path,
    detail: 'via agent',
    due_at: null,
  },
  cli_session_id: null,
  ...over,
});
const mount = (all = entries) =>
  render(<PageRunsTab entry={host} entries={all} schema={buildSchema(all)} />);
beforeEach(() => {
  read.mockReset().mockResolvedValue([]);
  detail.mockReset().mockResolvedValue({ run: run() });
  useVaultStore.setState({ vaultPath: '/vault', entries, views: [] });
});
afterEach(cleanup);

it('reading is distinct from empty and the footnote does not place old causes', async () => {
  let finish!: (runs: FleetRun[]) => void;
  read.mockImplementation(
    () =>
      new Promise<FleetRun[]>((resolve) => {
        finish = resolve;
      }),
  );
  mount();
  expect(screen.getByRole('status').textContent).toBe('Reading runs…');
  expect(screen.queryByTestId('page-runs-empty')).toBeNull();
  expect(read).toHaveBeenCalledWith('/vault', ['project.md', 'work/a.md'], 100);
  await act(async () => finish([]));
  expect(screen.getByTestId('page-runs-empty').textContent).toContain('No runs about this page');
  expect(screen.getByTestId('page-runs-footnote').textContent).toBe(
    "Runs from before Cerebro recorded why a run started can't be placed on a page.",
  );
});
it('a refused read says unavailable, never empty', async () => {
  read.mockRejectedValue(new Error('closed'));
  mount();
  expect((await screen.findByTestId('section-unavailable')).textContent).toBe(
    "Couldn't read this page's runs.",
  );
  expect(screen.queryByTestId('page-runs-empty')).toBeNull();
});
it('a row names the recorded assignment, resolves titles, groups a hop, and opens detail', async () => {
  read.mockResolvedValue([
    run({ run_id: 'hop', actor: null, parent_run_id: 'root', cause: null }),
    run(),
  ]);
  mount();
  const rows = await screen.findAllByTestId('page-run-row');
  expect(rows.map((row) => row.getAttribute('data-run'))).toEqual(['root', 'hop']);
  expect(rows[0].textContent).toContain('Scout');
  expect(rows[0].textContent).toContain('Ship docs');
  expect(rows[0].textContent).toContain('work was assigned to it (via agent)');
  expect(rows[1].getAttribute('data-depth')).toBe('1');
  expect(rows[1].textContent).toContain('unattributed');
  fireEvent.click(rows[0]);
  expect((await screen.findByTestId('opened-run')).textContent).toContain('root');
  expect(detail).toHaveBeenCalledWith('root');
});
it("nests a hop's own hop under it on the trace's rule, each row keeping its depth", async () => {
  read.mockResolvedValue([
    run({ run_id: 'hop-2', actor: null, parent_run_id: 'hop-1', cause: null }),
    run(),
    run({ run_id: 'hop-1', actor: null, parent_run_id: 'root', cause: null }),
  ]);
  mount();
  const rows = await screen.findAllByTestId('page-run-row');
  expect(rows.map((row) => [row.getAttribute('data-run'), row.getAttribute('data-depth')])).toEqual(
    [
      ['root', '0'],
      ['hop-1', '1'],
      ['hop-2', '2'],
    ],
  );
  expect(rows[1].closest('[data-hops]')?.getAttribute('data-hops')).toBe('root');
  expect(rows[2].closest('[data-hops]')?.getAttribute('data-hops')).toBe('hop-1');
});
it('says how each run ended in a word before it, and how long only as recorded', async () => {
  read.mockResolvedValue([
    run({ run_id: 'failed', outcome: 'failed', ended_at: '2026-07-28T12:00:30Z' }),
    run({ run_id: 'live', outcome: 'running', ended_at: null }),
  ]);
  mount();
  await screen.findAllByTestId('page-run-row');
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-run="${id}"]`)!;
  expect(row('failed').textContent).toMatch(/^Failed: Scoutfailed30s/);
  expect(row('live').textContent).toMatch(/^Running: Scoutrunning/);
  expect(row('live').querySelector('[data-slot="trace-description"]')).toBeNull();
});
it('bounds subjects at 500 and tells how many pages were searched', async () => {
  mount([
    ...entries,
    ...Array.from({ length: 510 }, (_, i) =>
      makeEntry({ path: `work/${i}.md`, type: 'Task', relationships: { project: ['project'] } }),
    ),
  ]);
  await screen.findByTestId('page-runs-empty');
  expect(read.mock.calls[0][1]).toHaveLength(500);
  expect(screen.getByTestId('page-runs-limit').textContent).toBe(
    'Searched the first 500 of 512 pages filed here.',
  );
});
it('run-end signals refresh the read without polling', async () => {
  mount();
  await screen.findByTestId('page-runs-empty');
  act(() => event.listener?.({ kind: 'Done' }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  act(() => event.listener?.({ kind: 'Text' }));
  expect(read).toHaveBeenCalledTimes(2);
});
it('a vault switch hides old rows and rejects their delayed detail', async () => {
  read.mockResolvedValueOnce([run()]).mockImplementation(() => new Promise(() => {}));
  let finish!: (value: { run: FleetRun }) => void;
  detail.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mount();
  fireEvent.click(await screen.findByTestId('page-run-row'));
  act(() => useVaultStore.setState({ vaultPath: '/other' }));
  expect(screen.queryByTestId('page-run-row')).toBeNull();
  await act(async () => finish({ run: run() }));
  expect(screen.queryByTestId('opened-run')).toBeNull();
});
