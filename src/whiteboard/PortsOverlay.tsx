import { useStore } from 'zustand';
import type { Board } from '@/engine/scene/model';
import { arrowHead } from '@/engine/scene/figure';
import { portPoints } from '@/engine/scene/ports';
import { useCanvasTransform } from '@/mermaid/CanvasViewport';
import type { BoardStore } from './boardState';

export function PortsOverlay({ board, state }: { board: Board; state: BoardStore }) {
  const port = useStore(state, (s) => s.port),
    hover = useStore(state, (s) => s.hover),
    connection = useStore(state, (s) => s.connection),
    active = useStore(state, (s) => s.interactionActive),
    editing = useStore(state, (s) => s.editing),
    tool = useStore(state, (s) => s.tool);
  const { scale, offset } = useCanvasTransform();
  if (editing || (active && !connection) || !['select', 'connector', 'line'].includes(tool))
    return null;
  const node = board.nodes.get(port?.node ?? (hover?.startsWith('n:') ? hover.slice(2) : ''));
  return (
    <svg
      data-testid="wb-ports"
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      aria-hidden="true"
    >
      <g transform={`translate(${offset.x} ${offset.y}) scale(${scale})`}>
        {connection && (
          <g data-testid="wb-connection-preview">
            <path
              d={connection.route.path}
              fill="none"
              stroke="var(--cortex-500)"
              strokeWidth={2 / scale}
            />
            {connection.arrow && (
              <polygon
                points={arrowHead(connection.route.to, connection.route.c2, 9 / scale)
                  .map((p) => `${p.x},${p.y}`)
                  .join(' ')}
                fill="var(--cortex-500)"
              />
            )}
          </g>
        )}
        {node &&
          portPoints(node, scale).map(({ side, point }) => (
            <g key={side}>
              {port?.side === side && (
                <circle
                  data-testid="wb-port-halo"
                  cx={point.x}
                  cy={point.y}
                  r={12 / scale}
                  fill="var(--cortex-500)"
                  fillOpacity={0.1}
                />
              )}
              <circle
                data-testid="wb-port"
                data-node-id={node.id}
                data-side={side}
                cx={point.x}
                cy={point.y}
                r={4 / scale}
                fill="var(--n-0)"
                stroke="var(--cortex-500)"
                strokeWidth={1.5 / scale}
              />
            </g>
          ))}
      </g>
    </svg>
  );
}
