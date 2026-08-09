import { useEffect, useRef, useState } from 'react';
import { loadMermaidHighlighter, type Highlighter } from './highlight';

/**
 * A textarea with a highlight layer painted underneath (M29.10). The classic
 * trick: the textarea's text is transparent (caret stays visible), an
 * aria-hidden <div> renders shiki's html in the same font box, and scroll
 * positions are mirrored. If no highlighter loads, the textarea simply keeps
 * visible text — zero behavior difference.
 */
export function HighlightedTextarea({
  value,
  onChange,
  onKeyDown,
  ariaLabel,
  placeholder,
  rows,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  ariaLabel: string;
  placeholder?: string;
  rows: number;
  autoFocus?: boolean;
}) {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let stale = false;
    void loadMermaidHighlighter().then((h) => {
      if (!stale) setHighlighter(() => h);
    });
    return () => {
      stale = true;
    };
  }, []);

  const sharedFont =
    '[font-family:var(--font-mono)] text-sm leading-[1.5] whitespace-pre-wrap break-words';

  return (
    <div className="relative min-w-[260px] flex-1 basis-[280px] bg-n-25">
      {highlighter !== null && (
        <div
          ref={layerRef}
          data-testid="mermaid-highlight-layer"
          aria-hidden
          className={`pointer-events-none absolute inset-0 overflow-hidden px-3 py-2 ${sharedFont} [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0 [&_code]:!bg-transparent`}
          // Safe: shiki html generated locally from the highlighter's own
          // language grammar over this editor's mermaid source text — the
          // same trust boundary as MermaidDiagram/MermaidLightbox elsewhere
          // in this module, not third-party or network content.
          dangerouslySetInnerHTML={{ __html: highlighter(value) }}
        />
      )}
      <textarea
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (layerRef.current !== null) {
            layerRef.current.scrollTop = e.currentTarget.scrollTop;
            layerRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}
        rows={rows}
        className={`relative w-full resize-y border-0 bg-transparent px-3 py-2 outline-none ${sharedFont} ${
          highlighter !== null ? 'text-transparent [caret-color:var(--n-800)]' : 'text-n-800'
        }`}
      />
    </div>
  );
}
