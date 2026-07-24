import { EmptyState } from '@/components/ui/EmptyState';
import type { Entry, Presentation, Schema } from '@/engine/types';

export interface BoardViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
}

// Placeholder — Task 21 replaces the body with the real kanban board.
// Keep the props above and data-testid="board-view" on the root element.
export function BoardView({ entries }: BoardViewProps) {
  return (
    <div data-testid="board-view" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
      {entries.length === 0 ? (
        <EmptyState
          icon="columns-3"
          title="No items"
          description="Items in this collection will appear here."
        />
      ) : (
        <div className="px-5 py-3 text-[13px] text-[var(--n-500)]">
          {entries.length} {entries.length === 1 ? 'item' : 'items'}
        </div>
      )}
    </div>
  );
}
