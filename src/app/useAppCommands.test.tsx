import { navSeed } from '@/test/navSeed';
import { DESTINATIONS } from '@/engine/destinations';
import { registerFlush, __resetOpenPages } from '@/editor/openPages';
import { useVaultStore } from '@/stores/vaultStore';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '@/lib/keys/registry';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useAppCommands } from './useAppCommands';

import { useLauncherStore } from '@/stores/launcherStore';
import { CREATE_ROWS } from './createCatalog';
import { makeEntry } from '@/test/factories';

vi.mock('@/lib/capture', () => ({ captureNote: vi.fn() }));
import { captureNote } from '@/lib/capture';
const capture = vi.mocked(captureNote);

const APP = ['app'];

beforeEach(() => {
  useVaultStore.setState({
    vaultPath: '/demo',
    entriesVault: '/demo',
    status: 'ready',
    entries: [],
  });
  useLauncherStore.setState({ open: false, flow: null, recents: {} });
  useUiStore.setState({
    quickOpenVisible: false,
    aiPanelOpen: false,
    toasts: [],
    inboxSelectedPath: null,
  });
  useNavStore.setState({
    selection: { kind: 'home' },
    history: [navSeed({ kind: 'home' })],
    historyIndex: 0,
  });
});

afterEach(() => {
  cleanup();
  __resetOpenPages();
  capture.mockReset();
});

describe('useAppCommands (M65.1)', () => {
  it('⌘K opens the palette and ⌘J toggles the assistant', () => {
    renderHook(() => useAppCommands());
    act(() => void runCommand('palette.open', APP));
    expect(useUiStore.getState().quickOpenVisible).toBe(true);
    act(() => void runCommand('assistant.toggle', APP));
    expect(useUiStore.getState().aiPanelOpen).toBe(true);
    act(() => void runCommand('assistant.toggle', APP));
    expect(useUiStore.getState().aiPanelOpen).toBe(false);
  });

  it('a capture selects the note it made and opens the Inbox on it', async () => {
    capture.mockResolvedValue('inbox/2026-10-15-1200.md');
    renderHook(() => useAppCommands());
    await act(async () => {
      runCommand('capture.new', APP);
      await Promise.resolve();
    });
    expect(useUiStore.getState().inboxSelectedPath).toBe('inbox/2026-10-15-1200.md');
    expect(useNavStore.getState().selection).toEqual({ kind: 'inbox' });
  });

  it('a failed capture toasts and stays put', async () => {
    capture.mockRejectedValue(new Error('disk full'));
    renderHook(() => useAppCommands());
    await act(async () => {
      runCommand('capture.new', APP);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
      "Couldn't capture: disk full",
    ]);
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  });

  it('the theme flips against the screen, and Back and Forward walk history', () => {
    act(() => useUiStore.getState().setThemeMode('light'));
    renderHook(() => useAppCommands());
    act(() => void runCommand('theme.toggle', APP));
    expect(useUiStore.getState().themeMode).toBe('dark');
    act(() => useNavStore.getState().navigate({ kind: 'pulse' }));
    act(() => void runCommand('nav.back', APP));
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
    act(() => void runCommand('nav.forward', APP));
    expect(useNavStore.getState().selection).toEqual({ kind: 'pulse' });
  });
});

it('binds every destination to its table selection, and gates Inbox live', () => {
  useUiStore.setState({ inboxEnabled: true });
  renderHook(() => useAppCommands());
  for (const place of DESTINATIONS) {
    act(() => {
      expect(runCommand(`go.${place.id}`, APP)).toBe(true);
    });
    expect(useNavStore.getState().selection).toEqual(place.selection);
  }
  useUiStore.setState({ inboxEnabled: false });
  expect(runCommand('go.inbox', APP)).toBe(false);
  expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
});

it('c p and c d open their creation flows, and c n opens the launcher', () => {
  renderHook(() => useAppCommands());
  const key = (value: string) =>
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    );
  act(() => {
    key('c');
    key('p');
  });
  expect(useLauncherStore.getState().flow?.id).toBe('page');
  act(() => {
    useLauncherStore.getState().endFlow();
    key('c');
    key('d');
  });
  expect(useLauncherStore.getState().flow?.id).toBe('database');
  act(() => {
    useLauncherStore.getState().endFlow();
    key('c');
    key('n');
  });
  expect(useLauncherStore.getState().open).toBe(true);
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
});

it('creation waits for a current scan and a sub-page needs an open page', () => {
  renderHook(() => useAppCommands());
  expect(runCommand('create.sub-page', APP)).toBe(false);
  useVaultStore.setState({ vaultPath: '/other' });
  expect(runCommand('create.page', APP)).toBe(false);
  expect(useLauncherStore.getState().flow).toBeNull();
});

it('every available catalog command reaches its matching creation flow', () => {
  useVaultStore.setState({ entries: [makeEntry({ path: 'plan.md' })] });
  useNavStore.setState({ selection: { kind: 'doc', path: 'plan.md' } });
  useUiStore.setState({ inboxEnabled: true });
  renderHook(() => useAppCommands());
  for (const row of CREATE_ROWS) {
    act(() => {
      expect(runCommand(`create.${row.id}`, APP)).toBe(true);
    });
    expect(useLauncherStore.getState().flow?.id).toBe(row.id);
  }
});

it('Save flushes every open page and leaves the key alone with none open', async () => {
  renderHook(() => useAppCommands());
  const press = () => {
    const event = new KeyboardEvent('keydown', {
      key: 's',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(press()).toBe(false);
  const first = vi.fn(async () => {});
  const second = vi.fn(async () => {});
  registerFlush(first);
  registerFlush(second);
  await act(async () => {
    expect(press()).toBe(true);
  });
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
});

it('opens Settings and scrolls to Keyboard shortcuts through its command', async () => {
  const target = document.createElement('section');
  target.id = 'keyboard-shortcuts';
  target.scrollIntoView = vi.fn();
  document.body.append(target);
  renderHook(() => useAppCommands());
  act(() => {
    runCommand('shortcuts.show', APP);
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
  await vi.waitFor(() => expect(target.scrollIntoView).toHaveBeenCalledOnce());
  target.remove();
});
