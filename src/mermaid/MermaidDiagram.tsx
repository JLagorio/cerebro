import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { applyStoredManualLayout } from './flowchart/manualLayout';
import { renderMermaid, type RenderResult } from './render';
import { useInertDiagramLinks } from './svgLinks';
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
  // The svg and THE CODE THAT PRODUCED IT, together. Rendering is async, so a
  // `code` prop that has already changed does not yet describe the svg in the
  // DOM — and manual layout below reads positions out of `code` and writes them
  // onto that svg. Kept apart, an edit applied the NEW code's positions to the
  // OLD, already-transformed picture for one frame. They travel as a pair so
  // that state is unrepresentable.
  const [rendered, setRendered] = useState<{ code: string; result: RenderResult } | null>(null);
  const result = rendered?.result ?? null;
  const themeEpoch = useThemeEpoch();
  const generation = useRef(0);
  // A rendered diagram must not be able to navigate the app away (M29.38).
  // Called before the early returns below, as every hook must be: the ref is
  // simply null on the loading and error faces, where there is no svg to
  // strip. The dependency is the svg itself, so the strip re-runs each time
  // React rewrites the subtree with a new render.
  const renderedSvg = result !== null && result.ok ? result.svg : null;
  const svgRef = useInertDiagramLinks<HTMLDivElement>(renderedSvg);

  /**
   * MEASURED, and not what the docs imply: React 19 re-applies
   * `dangerouslySetInnerHTML` whenever the PROP OBJECT differs, not whenever
   * the html string does. A fresh `{{ __html: svg }}` literal per render
   * therefore rebuilds this whole subtree on any re-render at all — throwing
   * away every manual-layout transform we wrote into it, and (older, quieter)
   * restoring the `href`s M29.38 strips, since that effect is keyed on the svg
   * string too and would not re-run either. Memoized on the string, the
   * subtree is rebuilt only when it genuinely changes.
   */
  const html = useMemo(() => ({ __html: renderedSvg ?? '' }), [renderedSvg]);

  // Manual layout in view mode (M29.42). A source carrying
  // `%% cerebro:layout manual` must honour its stored positions HERE too, or a
  // manual diagram snaps back to mermaid's auto geometry the moment the block
  // leaves edit mode, and again after every reload. `useLayoutEffect` for the
  // same reason the link strip uses one: the attribute writes land in the
  // commit that wrote the markup, so no frame ever paints the auto layout
  // first. The svg subtree is opaque to React, so those writes survive every
  // re-render. The dependency is the PAIR, not the svg string: a position-only
  // edit is inert to mermaid (measured, positions.mermaid.test.ts) so it comes
  // back byte-identical, React leaves the subtree alone, and keying off the svg
  // would silently never re-place the node the user just moved.
  //
  // What it deliberately does NOT fix: `onExpand(svg)` below hands the lightbox
  // the RAW svg string, so an expanded manual diagram still shows auto layout
  // (Stage G risk ledger item 9).
  useLayoutEffect(() => {
    if (rendered === null || !rendered.result.ok || svgRef.current === null) return;
    applyStoredManualLayout(svgRef.current, rendered.code);
  }, [rendered, svgRef]);

  useEffect(() => {
    const gen = ++generation.current;
    void renderMermaid(code).then((r) => {
      // A stale resolve must not clobber a newer render (code changed, or
      // the theme flipped while mermaid was working).
      if (generation.current === gen) setRendered({ code, result: r });
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
        ref={svgRef}
        className="overflow-auto [&_svg]:h-auto [&_svg]:max-w-full"
        style={{ maxHeight: collapseHeight }}
        // Safe: mermaid runs at securityLevel 'strict' and sanitizes its output.
        dangerouslySetInnerHTML={html}
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
