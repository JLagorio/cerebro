import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { readPortalViewport, toPortalRect } from '@/components/ui/portalGeometry';

/** A field's save feedback is passive: it neither opens a layer nor takes
 * focus. Tables need a portal because their scrollport clips inline helpers. */
export function AnchoredFieldStatus({
  anchor,
  id,
  children,
  error = false,
  floating = true,
}: {
  anchor: RefObject<HTMLElement | null>;
  id: string;
  children: ReactNode;
  error?: boolean;
  floating?: boolean;
}) {
  const surface = useRef<HTMLSpanElement>(null);
  // Keep this component mounted throughout editing, before any status text.
  // Its input ref becomes available during that first commit.
  const [inGrid, setInGrid] = useState(false);
  useLayoutEffect(() => {
    setInGrid(floating && anchor.current?.closest('[role="grid"]') != null);
  }, [anchor, floating]);
  const active = children !== null && children !== undefined && children !== '';
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    visible: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    if (!inGrid || !active) return;
    const input = anchor.current;
    const node = surface.current;
    if (input === null || node === null) return;
    const grid = input.closest<HTMLElement>('[role="grid"]');
    const place = () => {
      const viewport = readPortalViewport();
      const bounds = toPortalRect(input.getBoundingClientRect(), viewport.zoom);
      const clip = grid === null ? null : toPortalRect(grid.getBoundingClientRect(), viewport.zoom);
      const width = Math.max(0, Math.min(240, viewport.width - 16));
      node.style.width = `${width}px`;
      const height = node.getBoundingClientRect().height / viewport.zoom;
      const below = bounds.bottom + 4;
      const top = below + height <= viewport.height - 8 ? below : bounds.top - height - 4;
      setPosition({
        left: Math.max(8, Math.min(bounds.left, viewport.width - width - 8)),
        top: Math.max(8, Math.min(top, viewport.height - height - 8)),
        width,
        visible:
          bounds.bottom > Math.max(0, clip?.top ?? 0) &&
          bounds.top < Math.min(viewport.height, clip?.bottom ?? viewport.height) &&
          bounds.right > Math.max(0, clip?.left ?? 0) &&
          bounds.left < Math.min(viewport.width, clip?.right ?? viewport.width),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(input);
    observer.observe(node);
    if (grid !== null) observer.observe(grid);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, children, inGrid, active]);

  const status = (
    <span
      ref={surface}
      data-field-status={id}
      aria-hidden="true"
      className={`text-metadata ${error ? 'text-danger-600' : 'text-n-600'} ${
        inGrid
          ? 'pointer-events-none fixed z-50 rounded-md border border-n-200 bg-surface-raised p-2 shadow-[var(--shadow-sm)]'
          : ''
      }`}
      style={
        inGrid
          ? {
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              width: position?.width ?? 240,
              visibility: position?.visible ? 'visible' : 'hidden',
            }
          : undefined
      }
    >
      {children}
    </span>
  );
  return (
    <>
      {/* A mounted live region announces changes even when the field scrolls
          out of view. The visible bubble is not a second announcement. */}
      <span id={id} role="status" className="sr-only">
        {children}
      </span>
      {active && (inGrid ? createPortal(status, document.body) : status)}
    </>
  );
}
