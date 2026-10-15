import { Button } from '@/components/ui/Button';
export function ListSelectionBar({
  count,
  onCopy,
  doneHint = false,
}: {
  count: number;
  onCopy?: () => void;
  doneHint?: boolean;
}) {
  if (count === 0) return null;
  return (
    <div
      data-testid="list-selection"
      role="status"
      className="sticky bottom-3 z-20 mx-auto mt-3 flex w-fit items-center gap-3 rounded-lg border border-n-200 bg-n-0 px-3 py-2 shadow-[var(--shadow-lg)]"
    >
      <span className="text-sm font-medium text-n-700">
        {count} selected{doneHint ? ' · e marks done' : ''}
      </span>
      {onCopy && (
        <Button size="sm" variant="ghost" icon="link" onClick={onCopy}>
          Copy links
        </Button>
      )}
      <span className="text-xs text-n-500">Esc clears</span>
    </div>
  );
}
