import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { CanvasPage } from './CanvasPage';
const path = 'boards/plan.canvas';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
beforeEach(() => {
  resetMockFs();
  useVaultStore.setState({ vaultPath: '/demo-vault', entries: [] });
});
afterEach(cleanup);
it('names the file and measured card/connection singulars without a details panel', async () => {
  fs().set(
    path,
    '{"nodes":[{"id":"a","type":"text","text":"A","x":0,"y":0,"width":100,"height":50}],"edges":[{"id":"e","fromNode":"a","toNode":"a"}]}',
  );
  render(<CanvasPage selection={{ kind: 'diagram', path }} />);
  expect(await screen.findByTestId('canvas-board')).toBeTruthy();
  expect(screen.getByTestId('canvas-title').textContent).toBe('Plan');
  expect(screen.getByTestId('canvas-summary').textContent).toBe('1 card · 1 connection');
  expect(screen.queryByTestId('canvas-save-state')).toBeNull();
  expect(screen.queryByTestId('detail-panel')).toBeNull();
});
it('an empty board has measured zero counts and an empty face', async () => {
  fs().set(path, '{}');
  render(<CanvasPage selection={{ kind: 'diagram', path }} />);
  expect(await screen.findByTestId('canvas-empty')).toBeTruthy();
  expect(screen.getByTestId('canvas-summary').textContent).toBe('0 cards · 0 connections');
});
it('broken bytes stay unavailable, never an empty board', async () => {
  fs().set(path, 'broken');
  render(<CanvasPage selection={{ kind: 'diagram', path }} />);
  expect(await screen.findByTestId('canvas-unavailable')).toBeTruthy();
  expect(screen.queryByTestId('canvas-board')).toBeNull();
  expect(screen.queryByTestId('canvas-summary')).toBeNull();
});
it('loaded dangling edges are reported and kept', async () => {
  const source = '{"edges":[{"id":"old","fromNode":"gone","toNode":"lost"}]}';
  fs().set(path, source);
  render(<CanvasPage selection={{ kind: 'diagram', path }} />);
  expect((await screen.findByTestId('canvas-problems')).textContent).toContain(
    'Connection old points at a missing card.',
  );
  expect(fs().get(path)).toBe(source);
});
it('a knowledge board has a scene without an input or any save path', async () => {
  const knowledge = 'knowledge/maps/flow.canvas';
  const source =
    '{"nodes":[{"id":"a","type":"text","text":"Knowledge map","x":0,"y":0,"width":100,"height":80}]}';
  fs().set(knowledge, source);
  const save = vi.spyOn(ipc, 'saveCanvasFile');
  const { unmount } = render(<CanvasPage selection={{ kind: 'diagram', path: knowledge }} />);
  expect(await screen.findByText('Knowledge map')).toBeTruthy();
  expect(screen.getByTestId('canvas-read-only').textContent).toBe(
    'Knowledge boards are read-only here.',
  );
  expect(screen.queryByTestId('wb-input')).toBeNull();
  unmount();
  expect(save).not.toHaveBeenCalled();
  expect(fs().get(knowledge)).toBe(source);
  save.mockRestore();
});
