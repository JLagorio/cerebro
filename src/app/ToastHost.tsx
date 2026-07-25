import { useEffect, useRef } from 'react';
import { Toast } from '@/components/ui/Toast';
import { useUiStore } from '@/stores/uiStore';

const AUTO_DISMISS_MS = 3000;

export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    for (const t of toasts) {
      if (!timers.current.has(t.id)) {
        timers.current.set(
          t.id,
          setTimeout(() => {
            timers.current.delete(t.id);
            dismissToast(t.id);
          }, AUTO_DISMISS_MS),
        );
      }
    }
  }, [toasts, dismissToast]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );

  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[80] flex w-[360px] -translate-x-1/2 flex-col gap-2">
      {toasts.map((t) => (
        <Toast key={t.id} title={t.message} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  );
}
