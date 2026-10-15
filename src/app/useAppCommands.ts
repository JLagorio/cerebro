import { DARK_QUERY, resolveTheme } from '@/hooks/useTheme';
import { captureNote } from '@/lib/capture';
import { useCommands } from '@/lib/keys/useKeys';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';

/** ⌘K: the palette. */
function openPalette(): void {
  useUiStore.getState().setQuickOpen(true);
}

/** ⌘J: the assistant, a companion to whatever surface you are on (M6). */
function toggleAssistant(): void {
  const ui = useUiStore.getState();
  ui.setAiPanelOpen(!ui.aiPanelOpen);
}

/**
 * ⌘⇧N, quick capture (M4): writes an untyped note and opens the Inbox ON IT.
 * M15: the resolved path is SELECTED — throwing it away landed you on
 * whichever capture the persisted `inboxSelectedPath` still pointed at, so
 * the first thing you typed went into someone else's note.
 */
function newCapture(): void {
  void captureNote()
    .then((path) => {
      useUiStore.getState().setInboxSelectedPath(path);
      useNavStore.getState().navigate({ kind: 'inbox' });
    })
    .catch((err: unknown) => {
      useUiStore
        .getState()
        .toast(`Couldn't capture: ${err instanceof Error ? err.message : String(err)}`);
    });
}

/**
 * ⌘⇧L flips the theme against what is ON SCREEN, not against the stored
 * mode. From 'system' the user means "the opposite of what I am looking at",
 * and resolving first is the only way to know what that is — a naive
 * mode === 'dark' ? 'light' : 'dark' sends a system-dark user to dark.
 * Landing on an explicit mode is the intent: asking for the other one is
 * asking to stop following the OS.
 */
function toggleTheme(): void {
  const ui = useUiStore.getState();
  const systemDark =
    typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
  ui.setThemeMode(resolveTheme(ui.themeMode, systemDark) === 'dark' ? 'light' : 'dark');
}

/** M15: nav history existed in the store with no way to reach it. */
function back(): void {
  useNavStore.getState().back();
}

function forward(): void {
  useNavStore.getState().forward();
}

const GENERAL = [
  { id: 'palette.open', run: openPalette },
  { id: 'assistant.toggle', run: toggleAssistant },
  { id: 'capture.new', run: newCapture },
  { id: 'theme.toggle', run: toggleTheme },
  { id: 'nav.back', run: back },
  { id: 'nav.forward', run: forward },
];

/**
 * The General commands (`app.commands.ts`), bound in the app scope (M65.1).
 * App.tsx calls this above the vault early return, so ⌘⇧L answers at the
 * vault chooser too.
 */
export function useAppCommands(): void {
  useCommands(GENERAL);
}
