import { useDragGesture } from '@/hooks/useDragGesture';
import { MIXED } from '@/engine/scene/inspect';
import { useBoardDraft, type BoardDraftOwner } from './pendingText';

export function NumberField({
  label,
  value,
  onCommit,
  onScrubStart,
  onScrub,
  onScrubEnd,
  disabled = false,
  draftOwner,
}: {
  label: string;
  draftOwner?: BoardDraftOwner;
  value: number | typeof MIXED;
  disabled?: boolean;
  onCommit(value: number): boolean | void;
  onScrubStart?(cancel: () => void): void;
  onScrub?(delta: number): void;
  onScrubEnd?(commit: boolean): void;
}) {
  const display = value === MIXED ? '' : String(value);
  const {
    draft,
    error,
    prepare: commit,
    change,
    discard,
  } = useBoardDraft(draftOwner, display, (text) => {
    const number = text.trim() === '' ? NaN : Number(text);
    if (!Number.isFinite(number) || !Number.isInteger(number)) return false;
    return number === value || onCommit(number) !== false ? text : false;
  });
  const gesture = useDragGesture();
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled || !onScrub}
        aria-label={`Adjust ${label}`}
        className="w-6 shrink-0 cursor-ew-resize border-0 bg-transparent p-0 text-left text-xs text-n-500"
        onPointerDown={(event) => {
          if (event.button !== 0 || disabled || !onScrub) return;
          event.preventDefault();
          const start = event.clientX,
            id = event.pointerId,
            target = event.currentTarget;
          let started = false,
            ended = false;
          // Claim at pointer-down, including the threshold, so a previous board
          // pointer loop cannot preview into this new interaction.
          onScrubStart?.(gesture.end);
          const move = (e: PointerEvent) => {
            if (e.pointerId !== id) return;
            const delta = Math.round(e.clientX - start);
            if (!started && Math.abs(delta) < 3) return;
            if (!started) {
              started = true;
              target.setPointerCapture?.(id);
            }
            onScrub(delta * (e.shiftKey ? 10 : 1));
          };
          const up = (e: PointerEvent) => {
            if (e.pointerId !== id) return;
            ended = true;
            onScrubEnd?.(started);
            gesture.end();
          };
          const cancel = (e: PointerEvent) => {
            if (e.pointerId === id) gesture.end();
          };
          gesture.begin(() => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', cancel);
            if (target.hasPointerCapture?.(id)) target.releasePointerCapture?.(id);
            if (!ended) onScrubEnd?.(false);
          });
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
          window.addEventListener('pointercancel', cancel);
        }}
      >
        {label}
      </button>
      <input
        aria-label={label}
        disabled={disabled}
        inputMode="numeric"
        aria-invalid={error}
        value={draft}
        placeholder={value === MIXED ? 'Mixed' : undefined}
        className="w-full min-w-0 rounded-md border border-n-200 bg-n-0 px-2 py-1 text-xs text-n-700"
        onChange={(event) => {
          change(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            discard();
          } else if (
            (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
            typeof value === 'number'
          ) {
            event.preventDefault();
            const next = value + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1);
            change(String(next));
            commit();
          }
        }}
      />
    </div>
  );
}
