import { EmptyState } from '@/components/ui/EmptyState';
import type { Entry, Presentation, Schema } from '@/engine/types';

export interface ListViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** project context enables the quick-add row; null outside a project */
  project: Entry | null;
}

// Placeholder — Task 20 replaces the body with the real grouped list.
// Keep the props above and data-testid="list-view" on the root element.
export function ListView({ entries }: ListViewProps) {
  return (
    <div data-testid="list-view" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
      {entries.length === 0 ? (
        <EmptyState
          icon="list"
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
