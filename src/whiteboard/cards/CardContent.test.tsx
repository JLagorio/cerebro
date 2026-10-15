import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import type { FileCard } from '@/engine/scene/model';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { watchSections } from '@/editor/sectionLinks';
import { CardContent } from './CardContent';
const open = vi.fn();
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => open }));
const node = (file: string): FileCard => ({
  id: 'a',
  type: 'file',
  file,
  subpath: '#Rollback',
  x: 0,
  y: 0,
  width: 320,
  height: 120,
  z: 'a0',
});
beforeEach(() => {
  open.mockClear();
  useVaultStore.setState({
    vaultPath: '/vault',
    entries: [
      makeEntry({
        path: 'types/task.md',
        type: 'Type',
        title: 'Task',
        properties: { fields: { state: { kind: 'status' } } } as unknown as Entry['properties'],
      }),
      makeEntry({
        path: 'task.md',
        title: 'Task title',
        type: 'Task',
        properties: { state: 'todo' },
      }),
      makeEntry({ path: 'doc.md', title: 'Doc title' }),
      makeEntry({ path: 'empty.md', title: 'Empty status', type: 'Task' }),
    ],
  });
});
afterEach(cleanup);
it('status follows the schema capability and stays absent for docs and unset fields', () => {
  const { rerender } = render(<CardContent node={node('task.md')} />);
  expect(screen.getByText('Task title')).toBeTruthy();
  expect(screen.getByTestId('page-card-status')).toBeTruthy();
  rerender(<CardContent node={node('doc.md')} />);
  expect(screen.queryByTestId('page-card-status')).toBeNull();
  rerender(<CardContent node={node('empty.md')} />);
  expect(screen.queryByTestId('page-card-status')).toBeNull();
});
it('Open stops the native pointer, requests a section and forwards command-click into a pane', () => {
  const pointer = vi.fn(),
    section = vi.fn(),
    stop = watchSections('task.md', section);
  const { container } = render(
    <div>
      <CardContent node={node('task.md')} />
    </div>,
  );
  container.addEventListener('pointerdown', pointer);
  const button = screen.getByTestId('whiteboard-card-open');
  expect(button.hasAttribute('data-board-control')).toBe(true);
  fireEvent.pointerDown(button);
  expect(pointer).not.toHaveBeenCalled();
  fireEvent.click(button, { metaKey: true });
  expect(section).toHaveBeenCalledWith('Rollback');
  expect(open).toHaveBeenCalledExactlyOnceWith('task.md', { newPane: true });
  stop();
});
it('missing cards keep the pointer and have no Open; links expose only http(s)', () => {
  const { rerender } = render(<CardContent node={node('gone/nowhere.md')} />);
  expect(screen.getByText('No page at gone/nowhere.md')).toBeTruthy();
  expect(screen.queryByTestId('whiteboard-card-open')).toBeNull();
  for (const url of ['mailto:me@example.com', 'javascript:alert(1)']) {
    rerender(<CardContent node={{ ...node(''), type: 'link', url }} />);
    expect(screen.queryByRole('link')).toBeNull();
  }
  rerender(<CardContent node={{ ...node(''), type: 'link', url: 'https://example.com/docs' }} />);
  const link = screen.getByRole('link');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noreferrer');
  expect(link.hasAttribute('data-board-control')).toBe(true);
});
