import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { timeTableAllocation } from '@/views/displayGeometry';

/** Two independent horizontal viewports share one vertical row position.
 * Column widths belong to the table content, never to the split allocation.
 * The split is session-local; resize/measurement cannot write a view file. */
export function TimeViewport({
  table,
  axisRef,
  children,
}: {
  table: ReactNode;
  axisRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [wideWidth, setWideWidth] = useState<number>();
  const [narrowWidth, setNarrowWidth] = useState<number>();
  const hasTable = Boolean(table);
  const narrow = available > 0 && available < 720;
  const split = timeTableAllocation(available, narrow ? narrowWidth : wideWidth);

  useEffect(() => {
    const node = host.current;
    if (node === null) return;
    const measure = () => setAvailable(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const axis = axisRef.current;
    const tableNode = tableRef.current;
    if (axis === null || tableNode === null) return;
    const sync = (source: HTMLElement, target: HTMLElement) => {
      if (Math.abs(target.scrollTop - source.scrollTop) > 0.5) target.scrollTop = source.scrollTop;
    };
    const fromAxis = () => sync(axis, tableNode);
    const fromTable = () => sync(tableNode, axis);
    tableNode.scrollTop = axis.scrollTop;
    axis.addEventListener('scroll', fromAxis, { passive: true });
    tableNode.addEventListener('scroll', fromTable, { passive: true });
    return () => {
      axis.removeEventListener('scroll', fromAxis);
      tableNode.removeEventListener('scroll', fromTable);
    };
  }, [axisRef, hasTable]);

  return (
    <div ref={host} data-testid="time-viewport" className="flex min-h-0 min-w-0 flex-1">
      {table && (
        <div
          className="relative z-30 flex min-h-0 flex-none border-r border-n-200"
          style={{ width: split.width }}
        >
          <div
            ref={tableRef}
            data-testid="time-table-viewport"
            aria-label="Schedule records"
            className="min-h-0 min-w-0 flex-1 overflow-auto"
          >
            {table}
          </div>
          <ResizeHandle
            label="Table and time divider"
            side="right"
            width={split.width}
            min={split.min}
            max={split.max}
            onResize={narrow ? setNarrowWidth : setWideWidth}
          />
        </div>
      )}
      <div
        ref={axisRef}
        data-testid="time-axis-viewport"
        aria-label="Time axis"
        className="min-h-0 min-w-0 flex-1 overflow-auto"
      >
        {children}
      </div>
    </div>
  );
}
