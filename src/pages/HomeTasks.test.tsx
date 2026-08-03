// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocTask } from '@/engine/tasks';
import type { Entry } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const tasks: DocTask[] = [
  {
    sourcePath: 'projects/alpha/brief.md',
    line: 3,
    text: 'Assign owners',
    done: false,
    due: null,
    assignees: [],
  },
  {
    sourcePath: 'projects/beta/brief.md',
    line: 3,
    text: 'Assign owners',
    done: false,
    due: null,
    assignees: [],
  },
  {
    sourcePath: 'projects/alpha/brief.md',
    line: 4,
    text: 'Confirm scope',
    done: true,
    due: null,
    assignees: [],
  },
];

const toggle = vi.fn(async () => {});

vi.mock('@/hooks/useDocTasks', () => ({
  useDocTasks: () => ({ tasks, loading: false, toggle }),
}));

const { HomeTasks } = await import('./HomePage');

function mkEntry(path: string, title: string): Entry {
  return {
    path,
    filename: path.split('/').pop() ?? '',
    folder: path.slice(0, path.lastIndexOf('/')),
    project: null,
    title,
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-01T00:00:00Z',
    parseError: null,
  };
}

describe('HomeTasks', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [
        mkEntry('projects/alpha/brief.md', 'Alpha kickoff'),
        mkEntry('projects/beta/brief.md', 'Beta kickoff'),
      ],
      views: [],
      collections: [],
      status: 'ready',
      error: null,
    });
    useUiStore.setState({ homeTaskAssignee: '' });
  });

  afterEach(cleanup);

  // The source used to be flushed to the far right by a flex-1 label, ~1100px
  // from the checkbox, which is the only thing telling two identical rows
  // apart.
  it('puts the source next to the label, not at the far right of the row', () => {
    render(<HomeTasks />);
    const row = screen.getAllByTestId('home-task')[0];
    const children = [...row.children];
    const label = children.find((c) => c.textContent === 'Assign owners');
    const source = children.find((c) => c.textContent === 'Alpha kickoff');
    expect(label).toBeTruthy();
    expect(source).toBeTruthy();
    // adjacent siblings, and the spacer that right-aligns dates comes after
    expect(children.indexOf(source!) - children.indexOf(label!)).toBe(1);
    expect(label!.className).not.toContain('flex-1');
  });

  // '· N done' was a dead number — nothing revealed the done set.
  it("'N done' is a control that reveals the completed rows", () => {
    render(<HomeTasks />);
    expect(screen.getAllByTestId('home-task')).toHaveLength(2);
    expect(screen.queryByText('Confirm scope')).toBeNull();

    const toggleDone = screen.getByTestId('home-tasks-show-done');
    expect(toggleDone.textContent).toBe('1 done');
    expect(toggleDone.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggleDone);
    expect(screen.getAllByTestId('home-task')).toHaveLength(3);
    expect(screen.getByText('Confirm scope')).toBeTruthy();
    expect(screen.getByTestId('home-tasks-show-done').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the open count on the open tasks when done rows are shown', () => {
    render(<HomeTasks />);
    fireEvent.click(screen.getByTestId('home-tasks-show-done'));
    expect(screen.getByText('2 open')).toBeTruthy();
  });
});
