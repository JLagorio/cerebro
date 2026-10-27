import { sourceBodyDisplay, sourceBodyInput } from './sourceBodyEdits';

/** Presentation only: the document owner and rich editor's existing debounce
 * own generations and saves. Textarea values are LF projections of raw bytes. */
export function SourceBodyEditor({
  raw,
  onChange,
  readOnly = false,
  onError,
}: {
  raw: string;
  onChange: (raw: string) => void;
  readOnly?: boolean;
  onError?: (message: string) => void;
}) {
  return (
    <textarea
      aria-label="Page source"
      className="min-h-72 w-full flex-1 resize-y rounded-md border border-n-200 bg-transparent p-4 font-mono text-sm leading-6 text-n-800"
      value={sourceBodyDisplay(raw)}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(event) => {
        if (readOnly) return;
        try {
          onChange(sourceBodyInput(raw, event.currentTarget.value));
        } catch (error) {
          onError?.(error instanceof Error ? error.message : String(error));
        }
      }}
    />
  );
}
