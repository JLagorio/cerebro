import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { blockContent, blockElement } from './sectionLinks';

/** How long a section link's landing stays lit. */
export const SECTION_FLASH_MS = 2_000;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const boxOf = (host: HTMLElement | null, blockId: string): Box | null => {
  if (host === null) return null;
  const block = blockElement(host, blockId);
  if (block === null) return null;
  const rect = (blockContent(block) ?? block).getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
};

const sameBox = (a: Box | null, b: Box | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height);

/**
 * The highlight a section link lands on (M55.8): a fixed box over the
 * heading's content, fading out over `SECTION_FLASH_MS`.
 *
 * Drawn over the heading from document.body, never written onto the editor's
 * DOM: ProseMirror owns those elements and wipes attributes it did not write
 * (trap 2). It is measured again every frame, so it rides the smooth scroll
 * that brings the heading up, and it draws nothing once the block is gone.
 */
export function SectionFlash({
  hostRef,
  blockId,
  onDone,
}: {
  hostRef: { current: HTMLElement | null };
  blockId: string;
  onDone: () => void;
}) {
  const [box, setBox] = useState<Box | null>(() => boxOf(hostRef.current, blockId));
  const done = useRef(onDone);
  done.current = onDone;

  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      const next = boxOf(hostRef.current, blockId);
      setBox((prev) => (sameBox(prev, next) ? prev : next));
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    return () => window.cancelAnimationFrame(frame);
  }, [hostRef, blockId]);

  useEffect(() => {
    const timer = window.setTimeout(() => done.current(), SECTION_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (box === null) return null;
  return createPortal(
    <div
      aria-hidden="true"
      data-testid="section-flash"
      className="cb-section-flash"
      style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
    />,
    document.body,
  );
}
