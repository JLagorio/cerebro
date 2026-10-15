import { useStore } from 'zustand';
import { Icon } from '@/components/ui/Icon';
import { Tooltip } from '@/components/ui/Tooltip';
import type { BoardStore } from './boardState';
import { BOARD_TOOLS } from './tools';
export function Toolbar({ state, focus }: { state: BoardStore; focus: () => void }) {
  const active = useStore(state, (s) => s.tool);
  return (
    <div
      data-testid="wb-toolbar"
      data-no-pan="true"
      role="toolbar"
      aria-label="Whiteboard tools"
      className="absolute left-3 top-3 z-10 flex items-center gap-0.5 rounded-md border border-n-200 bg-n-0 p-1 shadow-sm"
    >
      {BOARD_TOOLS.map((tool) => (
        <Tooltip key={tool.id} label={tool.label} command={`whiteboard.tool.${tool.id}`}>
          <button
            type="button"
            data-testid="wb-tool"
            data-tool={tool.id}
            aria-label={tool.label}
            aria-pressed={active === tool.id}
            className={`flex h-8 w-8 items-center justify-center rounded-md border-0 ${active === tool.id ? 'bg-cortex-50 text-cortex-600' : 'bg-transparent text-n-500 hover:bg-n-50'}`}
            onClick={() => {
              state.getState().setTool(tool.id);
              focus();
            }}
          >
            <Icon name={tool.icon} size={16} />
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
