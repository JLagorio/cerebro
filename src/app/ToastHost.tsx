import { useCallback, useEffect, useRef, useState } from 'react';
import { Toast } from '@/components/ui/Toast';
import { useUiStore } from '@/stores/uiStore';

/**
 * Toasts are the app's only feedback channel for failed writes, so 3s was too
 * short to read one — especially since there is no history to recover it from.
 */
const AUTO_DISMISS_MS = 6000;

/**
 * A toast with an action (M60.7: Undo, Redo) stays longer: reading it and
 * then reaching for its button takes more than reading alone. Clicking the
 * button runs the action and dismisses the toast; hovering still pauses.
 */
export const ACTION_DISMISS_MS = 10_000;

export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  // Pointer inside the stack freezes every countdown: a user who moved to the
  // toast is reading it (or reaching for Dismiss) and should not lose it.
  const [paused, setPaused] = useState(false);

  const clearTimers = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  useEffect(() => {
    if (paused) {
      clearTimers();
      return;
    }
    for (const t of toasts) {
      if (!timers.current.has(t.id)) {
        timers.current.set(
          t.id,
          setTimeout(
            () => {
              timers.current.delete(t.id);
              dismissToast(t.id);
            },
            t.action === undefined ? AUTO_DISMISS_MS : ACTION_DISMISS_MS,
          ),
        );
      }
    }
    // Drop timers for toasts already dismissed by hand, so the map cannot grow
    // across a long session.
    for (const id of [...timers.current.keys()]) {
      if (!toasts.some((t) => t.id === id)) {
        clearTimeout(timers.current.get(id));
        timers.current.delete(id);
      }
    }
  }, [toasts, dismissToast, paused, clearTimers]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  return (
    // The live region has to EXIST before the toast lands in it — a container
    // that appears already carrying its text is routinely never announced. So
    // this renders unconditionally (empty, click-through) and only the toasts
    // inside it come and go.
    //
    // z-[1100] sits above the DS Dialog scrim (z-index 1000) so failure
    // toasts fired while a dialog stays open remain visible and dismissable
    // (fix round I1).
    <div
      data-testid="toast-host"
      // Neutral chrome (M65.1): pressing a toast's action leaves the keymap's
      // scope on the page it came from.
      data-key-neutral
      role="status"
      aria-live="polite"
      aria-atomic="false"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="fixed bottom-4 left-1/2 z-[1100] flex w-[360px] -translate-x-1/2 flex-col gap-2"
      style={{ pointerEvents: toasts.length === 0 ? 'none' : undefined }}
    >
      {toasts.map((t) => (
        <Toast
          key={t.id}
          title={t.message}
          action={
            t.action === undefined
              ? undefined
              : {
                  label: t.action.label,
                  onClick: () => {
                    dismissToast(t.id);
                    t.action?.run();
                  },
                }
          }
          onDismiss={() => dismissToast(t.id)}
        />
      ))}
    </div>
  );
}
