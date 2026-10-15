import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { buildSchema } from '@/engine/schema';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { PageAgentsTab } from './PageAgentsTab';

const project = makeEntry({ path: 'projects/launch.md', title: 'Launch', type: 'Project' });
const projectType = makeEntry({
  path: 'types/project.md',
  title: 'Project',
  type: 'Type',
  properties: {
    fields: { agents: { kind: 'relation', target: 'Agent' } },
    tabs: [
      { id: 'tasks', name: 'Tasks', content: 'view', source: { type: 'Task' }, scope: 'related' },
      { id: 'docs', name: 'Docs', content: 'view', source: { type: 'Spec' }, scope: 'related' },
      { id: 'many', name: 'Many', content: 'view', source: { type: 'Many' }, scope: 'related' },
    ],
  } as never,
});
const taskType = makeEntry({
  path: 'types/task.md',
  title: 'Task',
  type: 'Type',
  properties: {
    fields: {
      project: { kind: 'relation', target: 'Project' },
      agent: { kind: 'relation', target: 'Agent' },
    },
  } as never,
});
const specType = makeEntry({
  path: 'types/spec.md',
  title: 'Spec',
  type: 'Type',
  properties: { fields: { project: { kind: 'relation', target: 'Project' } } } as never,
});
const manyType = makeEntry({
  path: 'types/many.md',
  title: 'Many',
  type: 'Type',
  properties: {
    fields: {
      project: { kind: 'relation', target: 'Project' },
      first: { kind: 'relation', target: 'Agent' },
      second: { kind: 'relation', target: 'Agent' },
    },
  } as never,
});
const scout = makeEntry({ path: 'agents/scout.md', title: 'Scout', type: 'Agent' });
const worker = makeEntry({
  path: 'agents/worker.md',
  title: 'Worker',
  type: 'Agent',
  properties: { when: [{ event: 'assigned', field: 'agent' }] } as never,
});
const paused = makeEntry({
  path: 'agents/paused.md',
  title: 'Paused',
  type: 'Agent',
  properties: { paused: true },
});
const entries = [project, projectType, taskType, specType, manyType, scout, worker, paused];
const patch = vi.fn(async () => true);
const navigate = vi.fn();
beforeEach(() => {
  patch.mockClear();
  navigate.mockClear();
  useVaultStore.setState({ entries, patchFrontmatter: patch });
  useNavStore.setState({ navigate });
});
afterEach(cleanup);

it('an unconfigured host explains the missing capability', () => {
  render(<PageAgentsTab entry={project} entries={[]} schema={buildSchema([])} />);
  expect(screen.getByTestId('page-agents-unconfigured').textContent).toContain(
    'Project pages have no relation to Agent',
  );
  expect(screen.queryByTestId('page-agents-add')).toBeNull();
});
it('an empty host explains future inheritance and every footer case', () => {
  render(<PageAgentsTab entry={project} entries={entries} schema={buildSchema(entries)} />);
  expect(screen.getByTestId('page-agents-empty').textContent).toContain(
    'No agents yet. Agents you add here are assigned the work filed here from now on.',
  );
  const footers = screen.getByTestId('page-agents-footers');
  expect(footers.textContent).toContain(
    'Tasks filed here get these agents through their agent field.',
  );
  expect(footers.textContent).toContain('Docs have no field that takes agents.');
  expect(footers.textContent).toContain(
    'Many have more than one field that takes agents, so none is filled.',
  );
  expect(footers.textContent).toContain(
    'Work already here keeps its own agents, and so does work that leaves.',
  );
});
it('rows show the four statuses and existing agents open their pages', () => {
  render(
    <PageAgentsTab
      entry={{ ...project, relationships: { agents: ['scout', 'worker', 'paused', 'Gone'] } }}
      entries={entries}
      schema={buildSchema(entries)}
    />,
  );
  const rows = screen.getAllByTestId('page-agent-row');
  expect(rows[0].textContent).toContain(
    "Won't wake on its own: none of its triggers is assigned to it via agent. Open its page to add one.",
  );
  expect(rows[1].textContent).toContain('Wakes when work is assigned to it via agent.');
  expect(rows[2].textContent).toContain("Paused: work that arrives now won't wake it.");
  expect(rows[3].textContent).toContain('No agent called Gone.');
  fireEvent.click(within(rows[0]).getByTestId('page-agent-open'));
  expect(navigate).toHaveBeenCalledWith({ kind: 'doc', path: scout.path });
});
it('Add links an existing agent and removing the last writes null', () => {
  const schema = buildSchema(entries);
  const view = render(<PageAgentsTab entry={project} entries={entries} schema={schema} />);
  fireEvent.click(screen.getByTestId('page-agents-add'));
  fireEvent.click(screen.getByText('Scout'));
  expect(patch).toHaveBeenCalledWith(project.path, { agents: ['[[scout]]'] });
  fireEvent.keyDown(screen.getByPlaceholderText('Link an agent…'), { key: 'Escape' });
  view.rerender(
    <PageAgentsTab
      entry={{ ...project, relationships: { agents: ['scout'] } }}
      entries={entries}
      schema={schema}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove Scout' }));
  expect(patch).toHaveBeenLastCalledWith(project.path, { agents: null });
});
