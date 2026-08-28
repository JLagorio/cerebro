// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { MyWorkPage } from './MyWorkPage';

const TYPE_DOC = makeEntry({
  path: 'types/task.md',
  title: 'Task',
  type: 'Type',
  properties: {
    fields: { status: { kind: 'status' } },
    statuses: [
      { id: 'todo', label: 'To do', group: 'active' },
      { id: 'done', label: 'Done', group: 'done' },
    ],
  } as unknown as Entry['properties'],
});

describe('MyWorkPage', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: [] });
  });
  afterEach(cleanup);

  it('groups open work by database and shows the status label', () => {
    useVaultStore.setState({
      entries: [
        TYPE_DOC,
        makeEntry({
          path: 'records/tasks/fix-login.md',
          title: 'Fix login',
          type: 'Task',
          properties: { status: 'todo' } as unknown as Entry['properties'],
        }),
      ],
    });
    render(<MyWorkPage />);
    expect(screen.getByRole('heading', { name: 'My work' })).toBeTruthy();
    expect(screen.getByText('Task')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Fix login/ })).toBeTruthy();
    expect(screen.getByText('To do')).toBeTruthy();
  });

  it('says the empty state in words, never a zero', () => {
    useVaultStore.setState({ entries: [TYPE_DOC] });
    render(<MyWorkPage />);
    expect(screen.getByText(/Nothing is in progress/)).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });
});
