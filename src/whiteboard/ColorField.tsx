import { normalizeColor } from '@/engine/scene/colors';
import { MIXED } from '@/engine/scene/inspect';
import { presetPaint } from './palette';
import { useBoardDraft, type BoardDraftOwner } from './pendingText';
const COLORS = [
  ['1', 'Red'],
  ['2', 'Orange'],
  ['3', 'Yellow'],
  ['4', 'Green'],
  ['5', 'Cyan'],
  ['6', 'Purple'],
] as const;
export function ColorField({
  value,
  onCommit,
  draftOwner,
}: {
  value: string | null | typeof MIXED;
  onCommit(value: string | null): boolean | void;
  draftOwner?: BoardDraftOwner;
}) {
  const {
    draft,
    error,
    prepare: commit,
    change,
    discard,
  } = useBoardDraft(
    draftOwner,
    typeof value === 'string' && value.startsWith('#') ? value : '',
    (text) => {
      const normalized = text.startsWith('#') ? normalizeColor(text) : null;
      if (!normalized) return false;
      return normalized === value || onCommit(normalized) !== false ? normalized : false;
    },
  );
  const choose = (color: string | null) => {
    if (onCommit(color) !== false) discard();
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Colour">
        <button
          type="button"
          aria-pressed={value === null}
          onClick={() => choose(null)}
          className="rounded-md border border-n-200 bg-n-0 px-1.5 py-1 text-xs text-n-600"
        >
          None
        </button>
        {COLORS.map(([color, name]) => (
          <button
            key={color}
            type="button"
            aria-label={name}
            aria-pressed={value === color}
            onClick={() => choose(color)}
            className={`h-6 w-6 rounded-md border ${value === color ? 'border-cortex-500' : 'border-n-200'}`}
            style={{ background: presetPaint(color) ?? undefined }}
          />
        ))}
      </div>
      <input
        aria-label="Hex colour"
        value={draft}
        placeholder={value === MIXED ? 'Mixed' : '#aabbcc'}
        aria-invalid={error}
        className="w-full rounded-md border border-n-200 bg-n-0 px-2 py-1 text-xs text-n-700"
        onChange={(event) => {
          change(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            discard();
          } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commit();
          }
        }}
      />
      {error && (
        <p role="alert" className="m-0 text-xs text-danger-600">
          Use a hex colour such as #aabbcc.
        </p>
      )}
    </div>
  );
}
