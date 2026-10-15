import { useStore } from 'zustand';
import type { Board } from '@/engine/scene/model';
import { getItem } from '@/engine/scene/board';
import { edgeRoute } from '@/engine/scene/figure';
import { selectionBox } from '@/engine/scene/pick';
import { handlePoints } from '@/engine/scene/resize';
import { useCanvasTransform } from '@/mermaid/CanvasViewport';
import type { BoardStore } from './boardState';
export function SelectionOverlay({ board, state }: { board: Board; state: BoardStore }) {
  const selected = useStore(state, (s) => s.selection),
    marquee = useStore(state, (s) => s.marquee),
    guides = useStore(state, (s) => s.guides),
    hover = useStore(state, (s) => s.hover),
    trail = useStore(state, (s) => s.trail);
  const { scale, offset } = useCanvasTransform();
  const box = selectionBox(board, selected);
  const stroke = 1.5 / scale;
  const outline = (key: Parameters<typeof getItem>[1], faint = false) => {
    const item = getItem(board, key);
    if (!item) return null;
    if ('fromNode' in item) {
      const a = board.nodes.get(item.fromNode),
        b = board.nodes.get(item.toNode);
      return a && b ? (
        <g key={key}>
          <path
            d={edgeRoute(item, a, b).path}
            fill="none"
            stroke="var(--cortex-500)"
            strokeWidth={3 / scale}
            opacity={faint ? 0.4 : 0.8}
          />
          {!faint &&
            selected.size === 1 &&
            (['from', 'to'] as const).map((end) => {
              const point = edgeRoute(item, a, b)[end];
              return (
                <circle
                  key={end}
                  data-testid="wb-endpoint"
                  data-end={end}
                  cx={point.x}
                  cy={point.y}
                  r={5 / scale}
                  fill="var(--n-0)"
                  stroke="var(--cortex-500)"
                  strokeWidth={1.5 / scale}
                />
              );
            })}
        </g>
      ) : null;
    }
    return (
      <rect
        key={key}
        x={item.x}
        y={item.y}
        width={item.width}
        height={item.height}
        fill="none"
        stroke="var(--cortex-500)"
        strokeWidth={stroke}
        opacity={faint ? 0.4 : 1}
      />
    );
  };
  return (
    <svg
      data-testid="wb-selection"
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      aria-hidden="true"
    >
      <g transform={`translate(${offset.x} ${offset.y}) scale(${scale})`}>
        {trail.length > 0 && (
          <polyline
            data-testid="wb-eraser-trail"
            points={trail.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="var(--n-400)"
            opacity={0.3}
            strokeWidth={20 / scale}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {hover && !selected.has(hover) && outline(hover, true)}
        {[...selected].map((key) => outline(key))}
        {box && (
          <>
            <rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              fill="none"
              stroke="var(--cortex-500)"
              strokeWidth={1 / scale}
              strokeDasharray={`${4 / scale} ${3 / scale}`}
            />
            {handlePoints(box).map(({ handle, point }) => (
              <rect
                key={handle}
                data-testid="wb-handle"
                data-handle={handle}
                x={point.x - 3.5 / scale}
                y={point.y - 3.5 / scale}
                width={7 / scale}
                height={7 / scale}
                fill="var(--n-0)"
                stroke="var(--cortex-500)"
                strokeWidth={1 / scale}
              />
            ))}
          </>
        )}
        {marquee && (
          <rect
            data-testid="wb-marquee"
            {...marquee}
            fill="var(--cortex-500)"
            fillOpacity={0.1}
            stroke="var(--cortex-500)"
            strokeWidth={1 / scale}
            strokeDasharray={`${4 / scale} ${3 / scale}`}
          />
        )}
        {guides.map((guide) => (
          <line
            key={guide.axis}
            data-testid="wb-guide"
            x1={guide.axis === 'x' ? guide.position : guide.from}
            y1={guide.axis === 'y' ? guide.position : guide.from}
            x2={guide.axis === 'x' ? guide.position : guide.to}
            y2={guide.axis === 'y' ? guide.position : guide.to}
            stroke="var(--cortex-500)"
            strokeWidth={1 / scale}
          />
        ))}
      </g>
    </svg>
  );
}
