// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SelectedEntryProperties } from '@/lib/generated/workspace';
import type { Entry, ListFile, ViewDefinition } from '@/engine/types';
import { makeEntry } from '@/test/factories';
import { buildSchema } from '@/engine/schema';
import { resolveViewTab } from '@/engine/viewTab';
import { TypePage } from '@/pages/TypePage';
import { ListPage } from '@/pages/ListPage';
import { ViewCanvas } from './ViewCanvas';
import { DatabaseBlockView } from './DatabaseBlockView';
import { exportViewCsv } from '@/app/csvActions';
import * as ipc from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
vi.mock('@/mermaid/FullScreenDiagramEditor', () => ({ FullScreenDiagramEditor: () => <div /> }));
const saved: ViewDefinition = { id: 'all', name: 'All', icon: null, filters: { all: [{ field: 'amount', op: 'gt', value: 1 }] }, presentation: { type: 'table', group: [], sort: [{ field: 'title', dir: 'asc' }], columns: [{ field: 'amount' }] } };
function rows(): Entry[] {
  const type = makeEntry({ path: 'types/task.md', type: 'Type', title: 'Task', properties: { fields: { amount: 'number', project: { kind: 'relation', target: 'Project' } }, views: [saved] } as unknown as Entry['properties'] });
  const entry = Object.assign(makeEntry({ path: 'page.md', type: 'Task', title: 'Original page', authority: { kind: 'sqlite_metadata', workspaceId: 'workspace', recordId: 'record', metadataRevision: '1', metadataHash: 'a'.repeat(64), bodyHash: 'b'.repeat(64) } }), { canonicalProperties: { value: { kind: 'object', value: { amount: { kind: 'decimal', value: '1e400' }, project: { kind: 'relation', spelling: 'Host', resolution: { status: 'resolved', targetId: 'host' } } } }, unavailableLegacyKeys: ['amount', 'project'] } satisfies SelectedEntryProperties });
  return [type, entry];
}
function list(): ListFile { return { id: 'all', path: 'all.list.yml', collection: null, project: null, definition: { name: 'All', icon: null, color: null, order: null, source: { type: 'Task', project: null }, views: [saved] } }; }
beforeEach(() => { cleanup(); vi.restoreAllMocks(); useNavStore.getState().reset(); useVaultStore.setState({ vaultPath: '/test-only-selected-hosts', entriesVault: '/test-only-selected-hosts', entries: rows(), views: [list()], collections: [], folders: [], status: 'ready', error: null }); useUiStore.setState({ toasts: [], detailPath: null }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function visibleUnavailable(): void {
  expect(screen.getByTestId('selected-view-unavailable').textContent).toMatch(/unavailable/i);
  expect(screen.queryByText('Nothing matches these filters')).toBeNull();
  expect(screen.queryByText('No items yet')).toBeNull();
}
it('the actual TypePage displays unavailable result/count instead of false filter emptiness', () => {
  render(<TypePage selection={{ kind: 'type', name: 'Task', view: 'all' }} />);
  visibleUnavailable(); expect(screen.getByTestId('view-count').textContent).toBe('Unavailable');
});
it('the actual ListPage preserves refused result/count across its saved tab resolver', () => {
  render(<ListPage selection={{ kind: 'list', id: 'all', view: 'all' }} />);
  visibleUnavailable(); expect(screen.getByTestId('view-count').textContent).toBe('Unavailable');
});
it('a direct actual ViewCanvas refuses a hidden footer before building rows or totals', () => {
  const entries = rows(); render(<ViewCanvas entries={[entries[1]]} allEntries={entries} schema={buildSchema(entries)} fields={[{ name: 'amount', kind: 'number' }]} presentation={{ ...saved.presentation, columns: [{ field: 'amount', hidden: true, calc: 'sum' }] }} scope="selected-hidden" filtered={false} />);
  visibleUnavailable(); expect(screen.queryByTestId('table-view')).toBeNull();
});
it('the actual page database embed preserves the selected surface refusal', () => {
  const entries = rows(); render(<DatabaseBlockView database="Task" view="all" entries={entries} schema={buildSchema(entries)} />);
  visibleUnavailable();
});
it('human CSV export refuses the selected evaluation before opening an external destination', async () => {
  const exportFile = vi.spyOn(ipc, 'exportCsv').mockResolvedValue('/test-only-chosen.csv');
  expect(await exportViewCsv({ kind: 'type', name: 'Task', view: 'all' }, [])).toBe(false);
  expect(exportFile).not.toHaveBeenCalled();
  expect(useUiStore.getState().toasts.some(toast => /canonical|selected/i.test(toast.message))).toBe(true);
});
it('related selected scoping refuses before legacy relationship spellings can produce a false empty result', () => {
  const entries = rows(); const host = makeEntry({ path: 'host.md', type: 'Project', title: 'Host' });
  const type = entries[0]; type.properties = { ...type.properties, views: [{ ...saved, filters: null }] } as unknown as Entry['properties'];
  const resolution = resolveViewTab({ id: 'related', name: 'Related', icon: null, content: 'view', source: { type: 'Task' }, scope: 'related' }, host, [...entries, host], buildSchema([...entries, host]), []);
  expect(resolution).toMatchObject({ kind: 'broken', reason: expect.stringMatching(/canonical|selected/i) });
});
