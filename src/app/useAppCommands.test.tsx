import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '@/lib/keys/registry';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useAppCommands } from './useAppCommands';

vi.mock('@/lib/capture', () => ({ captureNote: vi.fn() }));
import { captureNote } from '@/lib/capture';
const capture = vi.mocked(captureNote);

const APP = ['app'];

beforeEach(() => {
  useUiStore.setState({
    quickOpenVisible: false,
    aiPanelOpen: false,
    toasts: [],
    inboxSelectedPath: null,
  });
  useNavStore.setState({
    selection: { kind: 'home' },
    history: [{ kind: 'home' }],
    historyIndex: 0,
  });
});

afterEach(() => {
  cleanup();
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
