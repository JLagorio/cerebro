import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CommandDef } from '@/app/commands';

const defs = vi.hoisted(() => {
  vi.resetModules();
  return [
    { id: 'go.home', label: 'Home', keys: ['g h'], scope: 'app', group: 'Go to', palette: false },
    { id: 'create.page', label: 'New page', keys: ['c p'], scope: 'app', group: 'Create' },
    { id: 'list.first', label: 'Top of list', keys: ['g g'], scope: 'page', group: 'Lists' },
  ];
});
vi.mock('@/app/commands', () => ({
  catalog: () => defs,
  commandDef: (id: string) => defs.find((def) => def.id === id)!,
  scopesOf: (def: CommandDef) => [def.scope],
}));
import { armChord, cancelChord, HINT_MS, RESET_MS } from '@/lib/keys/chords';
import { APP_SCOPE, bind, resetKeymap } from '@/lib/keys/registry';
import { ChordHint } from './ChordHint';

const key = (key: string) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  cancelChord();
  resetKeymap();
  vi.useRealTimers();
});

it('waits 200 ms, lists the live go options, then disappears at 2 seconds', () => {
  bind(APP_SCOPE, 'go.home', { run: () => {} });
  render(<ChordHint />);
  act(() => {
    armChord(key('g'), ['app']);
  });
  expect(screen.queryByTestId('chord-hint')).toBeNull();
  act(() => vi.advanceTimersByTime(HINT_MS));
  expect(screen.getByRole('status').textContent).toContain('Go to');
  expect(screen.getByText('Home')).toBeTruthy();
  expect(
    screen.getByTestId('chord-hint').querySelector('[data-keys]')?.getAttribute('data-keys'),
  ).toBe('g h');
  expect(screen.queryByText('Top of list')).toBeNull();
  act(() => vi.advanceTimersByTime(RESET_MS - HINT_MS));
  expect(screen.queryByTestId('chord-hint')).toBeNull();
});

it('shows Top of list only in the chain where a list binds it', () => {
  bind(APP_SCOPE, 'go.home', { run: () => {} });
  bind({ id: 'page:list', name: 'page' }, 'list.first', { run: () => {} });
  render(<ChordHint />);
  act(() => {
    armChord(key('g'), ['app']);
    vi.advanceTimersByTime(HINT_MS);
  });
  expect(screen.queryByText('Top of list')).toBeNull();
  act(() => {
    armChord(key('g'), ['page:list', 'app']);
    vi.advanceTimersByTime(HINT_MS);
  });
  expect(screen.getByText('Top of list')).toBeTruthy();
});

it('uses Create for c and drops options that unbind', () => {
  const dispose = bind(APP_SCOPE, 'create.page', { run: () => {} });
  render(<ChordHint />);
  act(() => {
    armChord(key('c'), ['app']);
    vi.advanceTimersByTime(HINT_MS);
  });
  expect(screen.getByText('Create')).toBeTruthy();
  expect(screen.getByText('New page')).toBeTruthy();
  act(dispose);
  expect(screen.queryByTestId('chord-hint')).toBeNull();
});
