import { useRef, useState } from 'react';
import { useDragGesture } from '@/hooks/useDragGesture';

/**
 * The drag handle on a panel's edge (M11).
 *
 * Shared by the sidebar and the record panel because they need identical
 * behaviour and it is easy to get subtly wrong: the pointer leaves the 5px
 * strip almost immediately, so the listeners live on the window; text
 * selection has to be suppressed for the whole drag; and the width has to be
 * computed from where the drag STARTED rather than accumulated per event, or a
 * fast drag drifts away from the cursor.
 *
 * It is a `separator` with arrow-key support, because a pointer-only resize is
 * a resize keyboard users do not have.
 *
 * Escape abandons a drag in flight (M46.2). It had none: the key went straight
 * to whatever surface the handle was drawn inside, and the release then wrote
 * the width the user was backing out of.
 */
export function ResizeHandle({
  label,
  side,
  width,
  min,
  max,
  onResize,
}: {
  label: string;
  /** Which edge of the panel this sits on — decides the sign of the drag. */
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
}) {
  const start = useRef({ x: 0, w: 0 });
  const [active, setActive] = useState(false);
  /** The drag's claim on Escape, and the teardown an unmount runs (M46.2). */
  const gesture = useDragGesture();
  const clamp = (w: number) => Math.min(max, Math.max(min, Math.round(w)));
  // A handle on the LEFT edge grows the panel as the pointer moves left.
  const sign = side === 'left' ? -1 : 1;

  const begin = (clientX: number) => {
    const from = width;
    start.current = { x: clientX, w: from };
    setActive(true);
    const at = (x: number) => clamp(start.current.w + (x - start.current.x) * sign);
    const move = (e: PointerEvent) => onResize(at(e.clientX));
    let released = false;
    /**
     * Ends the gesture. `released` is false for an Escape and for an unmount
     * that catches the drag still live, and both mean the same thing: the
     * gesture never finished, so the width goes back to where the grab found
     * it (M46.2). This handle paints by WRITING — every move calls `onResize`
     * — so the restore is a write of its own rather than the absence of one.
     */
    const teardown = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('cb-resizing');
      setActive(false);
      if (!released) onResize(from);
    };
    const up = (e: PointerEvent) => {
      released = true;
      const w = at(e.clientX);
      gesture.end();
      onResize(w);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    document.body.classList.add('cb-resizing');
    gesture.begin(teardown);
  };

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid={`resize-${side}`}
      onPointerDown={(e) => {
        e.preventDefault();
        begin(e.clientX);
      }}
      onDoubleClick={() => onResize(clamp(width))}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 12;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onResize(clamp(width - step * sign));
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          onResize(clamp(width + step * sign));
        }
      }}
      className={[
        'absolute top-0 z-20 flex h-full w-[7px] cursor-col-resize touch-none items-stretch justify-center',
        side === 'left' ? '-left-[3px]' : '-right-[3px]',
      ].join(' ')}
    >
      <span
        className={[
          'w-[2px] transition-colors',
          active ? 'bg-cortex-500' : 'bg-transparent hover:bg-cortex-300',
        ].join(' ')}
      />
    </span>
  );
}
