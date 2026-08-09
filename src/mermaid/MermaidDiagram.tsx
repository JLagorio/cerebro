import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { renderMermaid, type RenderResult } from './render';
import { useThemeEpoch } from './useThemeEpoch';

/**
 * The universal read-only diagram (M29.3): every surface that shows rendered
 * markdown uses this one component, so fit, errors, and theme-following are
 * decided once. Hosts that can open the lightbox pass `onExpand`; the current
 * svg rides along so the lightbox never re-renders the diagram.
 */
export function MermaidDiagram({
  code,
  onExpand,
  onErrorClick,
  collapseHeight = 480,
}: {
  code: string;
  onExpand?: (svg: string) => void;
  onErrorClick?: () => void;
  collapseHeight?: number;
}) {
  const [result, setResult] = useState<RenderResult | null>(null);
  const themeEpoch = useThemeEpoch();
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    void renderMermaid(code).then((r) => {
      // A stale resolve must not clobber a newer render (code changed, or
      // the theme flipped while mermaid was working).
      if (generation.current === gen) setResult(r);
    });
  }, [code, themeEpoch]);

  if (result === null) {
    return <div data-testid="mermaid-loading" className="min-h-12 w-full" aria-busy="true" />;
  }

  if (!result.ok) {
    // Button content model forbids block descendants (the <pre> below), so
    // an interactive error card is a div playing "button" via role +
    // tabIndex + keydown, not a real <button> wrapping the message.
    const clickable = onErrorClick !== undefined;
    return (
      <div
        data-testid="mermaid-error"
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? onErrorClick : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onErrorClick();
                }
              }
            : undefined
        }
        className={`w-full rounded-lg border border-danger-500/40 bg-danger-50 px-3 py-2 ${
          clickable ? 'cursor-pointer' : ''
        }`}
      >
        <div className="text-xs text-danger-700">{result.message}</div>
        <pre className="mt-1 overflow-x-auto [font-family:var(--font-mono)] text-xs leading-[18px] text-n-600">
          {code}
        </pre>
        {clickable && (
          <div className="mt-1 text-2xs text-danger-600/80">Click to fix the diagram source…</div>
        )}
      </div>
    );
  }

  const svg = result.svg;
  return (
    <div className="group relative w-full" data-testid="mermaid-diagram">
      <div
        className="overflow-auto [&_svg]:h-auto [&_svg]:max-w-full"
        style={{ maxHeight: collapseHeight }}
        // Safe: mermaid runs at securityLevel 'strict' and sanitizes its output.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {onExpand !== undefined && (
        <button
          type="button"
          aria-label="Expand diagram"
          onClick={() => onExpand(svg)}
          className="absolute right-1.5 top-1.5 hidden rounded-md border border-n-200 bg-n-0 p-1 group-hover:block hover:bg-n-50"
        >
          <Icon name="maximize-2" size={13} color="var(--n-500)" />
        </button>
      )}
    </div>
  );
}
