import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { useUiStore } from '@/stores/uiStore';
import { copyPng, copySvg, savePng } from './export';

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

/**
 * Diagram viewer (M29.5): zoom (buttons + wheel), drag-to-pan, copy/export.
 * Receives the already-rendered svg — it never re-renders the diagram, so
 * opening it is instant and cannot fail.
 */
export function MermaidLightbox({
  open,
  svg,
  title,
  onClose,
}: {
  open: boolean;
  svg: string;
  title: string;
  onClose: () => void;
}) {
  const toast = useUiStore((s) => s.toast);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );

  const zoomBy = (factor: number) =>
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)));

  const act = (label: string, run: () => Promise<unknown>) => {
    void run()
      .then(() => toast(label))
      .catch(() => toast(`${label.split(' ')[0]} failed`));
  };

  return (
    <Dialog open={open} onClose={onClose} title={title} width={960}>
      <div className="mb-2 flex items-center gap-1.5">
        <IconButton icon="zoom-out" label="Zoom out" onClick={() => zoomBy(1 / 1.1)} />
        {/* Button has no aria-label passthrough, and this control's visible
            text ("100%") is not its accessible name ("Reset zoom") — a plain
            button reusing Button's own classes covers both. */}
        <button
          type="button"
          aria-label="Reset zoom"
          className="cb-btn cb-btn-md cb-btn-ghost"
          onClick={() => {
            setScale(1);
            setOffset({ x: 0, y: 0 });
          }}
        >
          {Math.round(scale * 100)}%
        </button>
        <IconButton icon="zoom-in" label="Zoom in" onClick={() => zoomBy(1.1)} />
        <span className="flex-1" />
        <Button variant="secondary" onClick={() => act('SVG copied', () => copySvg(svg))}>
          Copy SVG
        </Button>
        <Button variant="secondary" onClick={() => act('PNG copied', () => copyPng(svg))}>
          Copy PNG
        </Button>
        <Button
          variant="secondary"
          onClick={() => act('PNG saved', () => savePng(svg, 'diagram.png'))}
        >
          Save PNG…
        </Button>
      </div>
      <div
        data-testid="lightbox-viewport"
        className="relative h-[60vh] cursor-grab overflow-hidden rounded-lg border border-n-200 bg-n-25 active:cursor-grabbing"
        onWheel={(e) => {
          e.preventDefault();
          zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = {
            startX: e.clientX,
            startY: e.clientY,
            baseX: offset.x,
            baseY: offset.y,
          };
        }}
        onPointerMove={(e) => {
          if (drag.current === null) return;
          setOffset({
            x: drag.current.baseX + (e.clientX - drag.current.startX),
            y: drag.current.baseY + (e.clientY - drag.current.startY),
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <div
          data-testid="lightbox-canvas"
          className="[&_svg]:h-auto [&_svg]:max-w-none"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: '0 0',
          }}
          // Safe: same strict-mode mermaid output the inline view showed.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </Dialog>
  );
}
