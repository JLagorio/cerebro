import { useRef, useState } from 'react';

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
  const clamp = (w: number) => Math.min(max, Math.max(min, Math.round(w)));
  // A handle on the LEFT edge grows the panel as the pointer moves left.
  const sign = side === 'left' ? -1 : 1;

  const begin = (clientX: number) => {
    start.current = { x: clientX, w: width };
    setActive(true);
    const at = (x: number) => clamp(start.current.w + (x - start.current.x) * sign);
    const move = (e: PointerEvent) => onResize(at(e.clientX));
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('cb-resizing');
      setActive(false);
      onResize(at(e.clientX));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    document.body.classList.add('cb-resizing');
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
