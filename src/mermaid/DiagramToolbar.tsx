import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { MenuItem, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { useUiStore } from '@/stores/uiStore';
import { parseFlowchart, serialize, type FlowchartModel } from './flowchart/model';
import { addNode, setDirection, setLayoutEngine } from './flowchart/ops';
import { copyPng, copySvg, savePng } from './export';
import { renderMermaid } from './render';

const DIRECTIONS = ['TD', 'LR', 'BT', 'RL'] as const;

const isElk = (code: string): boolean => code.match(/^\s*layout:\s*elk\s*$/m) !== null;

const TEXT_BTN =
  'rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50';

/**
 * The full-screen editor's control strip (M29.26, spec D1/D9-partial).
 *
 * The structural cluster (add node, direction, layout engine) only exists
 * over the structural editor — a read-only canvas has no model to operate on.
 * The zoom cluster is NOT here on purpose: CanvasViewport owns zoom state, so
 * it draws its own controls (spec D2). Stage G grows the layout menu (ELK
 * variants, Auto-layout OFF); this stage names the two engines the ops already
 * speak.
 *
 * Export renders through the cached service at click time — the canvas just
 * rendered this exact code, so it is a cache hit, never a second layout.
 */
export function DiagramToolbar({
  code,
  onChangeCode,
  title,
  mode,
  showCode,
  onToggleShowCode,
  onEditVisually,
}: {
  code: string;
  onChangeCode: (code: string) => void;
  /**
   * For hosts with no chrome of their own (Stage H's WhiteboardView). The page
   * header and the block dialog already name the diagram, so both omit it.
   */
  title?: string;
  /** What the canvas is hosting right now. */
  mode: 'visual' | 'code';
  showCode: boolean;
  onToggleShowCode: () => void;
  /**
   * Present when the source is flowchart-capable but the canvas is read-only.
   * The latch never auto-promotes (M29.18.1), so promotion is this explicit
   * button — or null when there is nothing to promote to.
   */
  onEditVisually: (() => void) | null;
}) {
  const toast = useUiStore((s) => s.toast);
  const model = useMemo(() => parseFlowchart(code), [code]);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const layoutAnchor = useRef<HTMLButtonElement | null>(null);

  const apply = (next: FlowchartModel | null) => {
    if (next !== null) onChangeCode(serialize(next));
  };

  // savePng resolves null on user cancel — no toast either way (the M29.5
  // contract); the copy actions resolve undefined and always toast.
  const act = (success: string, failure: string, run: (svg: string) => Promise<unknown>) => {
    void renderMermaid(code)
      .then((r) => {
        if (!r.ok) throw new Error(r.message);
        return run(r.svg);
      })
      .then((result) => {
        if (result !== null) toast(success);
      })
      .catch(() => toast(failure));
  };

  return (
    <div
      data-testid="diagram-toolbar"
      className="flex h-10 flex-none items-center gap-1 border-b border-n-200 bg-n-0 px-2"
    >
      {title !== undefined && (
        <span className="mr-1 truncate text-sm font-medium text-n-900">{title}</span>
      )}
      {mode === 'visual' && model !== null && (
        <>
          <button
            type="button"
            aria-label="Add node"
            onClick={() => apply(addNode(model, 'New step').model)}
            className={TEXT_BTN}
          >
            + Node
          </button>
          <span className="mx-0.5 h-4 w-px bg-n-100" />
          {DIRECTIONS.map((d) => (
            <button
              key={d}
              type="button"
              aria-label={`Direction ${d}`}
              onClick={() => apply(setDirection(model, d))}
              className={TEXT_BTN}
            >
              {d}
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-n-100" />
          <button
            type="button"
            ref={layoutAnchor}
            aria-label="Layout engine"
            onClick={() => setLayoutOpen(true)}
            className={TEXT_BTN}
          >
            {isElk(code) ? 'Layout: ELK' : 'Layout: Dagre'}
          </button>
          {layoutOpen && (
            <Popover
              anchorRef={layoutAnchor}
              onClose={() => setLayoutOpen(false)}
              role="menu"
              ariaLabel="Layout engine"
            >
              <MenuSurface width={160}>
                <MenuItem
                  label="Dagre"
                  checked={!isElk(code)}
                  onSelect={() => {
                    apply(setLayoutEngine(model, 'dagre'));
                    setLayoutOpen(false);
                  }}
                />
                <MenuItem
                  label="ELK"
                  checked={isElk(code)}
                  onSelect={() => {
                    apply(setLayoutEngine(model, 'elk'));
                    setLayoutOpen(false);
                  }}
                />
              </MenuSurface>
            </Popover>
          )}
        </>
      )}
      {onEditVisually !== null && (
        <button type="button" onClick={onEditVisually} className={TEXT_BTN}>
          Edit visually
        </button>
      )}
      <span className="flex-1" />
      <button type="button" onClick={onToggleShowCode} className={TEXT_BTN}>
        {showCode ? 'Hide code' : 'Show code'}
      </button>
      <span className="mx-0.5 h-4 w-px bg-n-100" />
      <Button
        variant="secondary"
        onClick={() => act('SVG copied', 'Copy SVG failed', (svg) => copySvg(svg))}
      >
        Copy SVG
      </Button>
      <Button
        variant="secondary"
        onClick={() => act('PNG copied', 'Copy PNG failed', (svg) => copyPng(svg))}
      >
        Copy PNG
      </Button>
      <Button
        variant="secondary"
        onClick={() => act('PNG saved', 'Save PNG failed', (svg) => savePng(svg, 'diagram.png'))}
      >
        Save PNG…
      </Button>
    </div>
  );
}
