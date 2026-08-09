import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { detectDiagramType } from './detect';
import { StructuralEditor } from './flowchart/StructuralEditor';
import { parseFlowchart } from './flowchart/model';
import { HighlightedTextarea } from './HighlightedTextarea';
import { MermaidDiagram } from './MermaidDiagram';
import { MermaidLightbox } from './MermaidLightbox';
import { renderMermaid } from './render';
import { TEMPLATES } from './templates';
import { useDebounced } from './useDebounced';

/**
 * The mermaid block's body (M29.6) — moved out of editor/blocks.tsx so the
 * editor keeps only BlockNote glue. Rendering goes through the shared core;
 * this file owns block chrome and the edit lifecycle. Stage B (M29.9)
 * replaced the textarea-toggle-with-blur-commit with side-by-side live
 * editing; Stage C adds the structural editor. Both land here.
 */
export function MermaidBlockView({
  code,
  onChangeCode,
}: {
  code: string;
  onChangeCode: (code: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(code);
  const [lightboxSvg, setLightboxSvg] = useState<string | null>(null);
  // Stage C (M29.18): flowcharts get a visual/code toggle; every other
  // diagram type has no structural model to edit, so it never leaves code.
  const [editMode, setEditMode] = useState<'visual' | 'code'>('visual');
  const isVisualCapable = parseFlowchart(editing ? draft : code) !== null;

  const commit = () => {
    setEditing(false);
    if (draft !== code) onChangeCode(draft);
  };

  const cancel = () => {
    setDraft(code);
    setEditing(false);
  };

  return (
    <div
      data-testid="mermaid-block"
      contentEditable={false}
      className="my-1 w-full rounded-lg border border-n-200 bg-n-0"
    >
      <div className="flex items-center gap-1.5 border-b border-n-100 px-2.5 py-1">
        <Icon name="waypoints" size={13} color="var(--n-500)" />
        <span className="text-xs font-medium uppercase tracking-[0.05em] text-n-500">
          {detectDiagramType(editing ? draft : code)}
        </span>
        {editing && isVisualCapable && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditMode(editMode === 'visual' ? 'code' : 'visual')}
            className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
          >
            {editMode === 'visual' ? 'Show code' : 'Show diagram'}
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          // Without this the textarea blurs FIRST, commit() flips `editing`
          // false, and the click then lands on the (now) "Edit" branch —
          // reopening the source box the button just closed.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (editing) commit();
            else {
              setDraft(code);
              setEditing(true);
            }
          }}
          className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>

      {editing && isVisualCapable && editMode === 'visual' && (
        <div
          onKeyDown={(e) => {
            // No Stage-B textarea here to swallow BlockNote hotkeys via
            // e.stopPropagation on every keystroke, so only intercept the one
            // key this pane cares about: Escape just exits — every visual op
            // already committed through onChangeCode as it happened, so
            // there is nothing left to revert (unlike Stage B's cancel()).
            if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(false);
            }
          }}
        >
          <StructuralEditor
            code={draft}
            onChangeCode={(next) => {
              // Each visual operation (drag an edge, rename, delete…) commits
              // immediately — its own BlockNote history step — rather than
              // batching until Done, so cmd+z undoes one visual action at a
              // time instead of the whole editing session.
              setDraft(next);
              onChangeCode(next);
            }}
          />
        </div>
      )}

      {editing && (!isVisualCapable || editMode === 'code') && (
        <div className="flex flex-wrap">
          <HighlightedTextarea
            autoFocus
            ariaLabel="Mermaid source"
            value={draft}
            placeholder={'graph TD\n  A[Idea] --> B[Shipped]'}
            onChange={setDraft}
            onKeyDown={(e) => {
              // BlockNote hotkeys must not fire while typing in the source box.
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit();
              }
            }}
            rows={Math.max(6, draft.split('\n').length + 1)}
          />
          <LivePreview code={draft} />
        </div>
      )}

      {!editing && code.trim() !== '' && (
        <div className="px-3 py-2">
          <MermaidDiagram
            code={code}
            onExpand={(svg) => setLightboxSvg(svg)}
            onErrorClick={() => {
              setDraft(code);
              setEditing(true);
            }}
          />
        </div>
      )}

      {!editing && code.trim() === '' && (
        <div
          data-testid="mermaid-template-grid"
          className="grid grid-cols-2 gap-1.5 p-3 sm:grid-cols-3"
        >
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setDraft(t.code);
                setEditing(true);
              }}
              className="flex items-center gap-2 rounded-md border border-n-200 bg-n-0 px-2.5 py-2 text-left text-sm text-n-700 hover:border-n-300 hover:bg-n-25"
            >
              <Icon name={t.icon} size={14} color="var(--n-500)" />
              {t.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setDraft('');
              setEditing(true);
            }}
            className="flex items-center gap-2 rounded-md border border-dashed border-n-200 bg-transparent px-2.5 py-2 text-left text-sm text-n-500 hover:border-n-300"
          >
            <Icon name="pencil" size={14} color="var(--n-400)" />
            Blank
          </button>
        </div>
      )}

      {lightboxSvg !== null && (
        <MermaidLightbox
          open
          svg={lightboxSvg}
          title="Diagram"
          onClose={() => setLightboxSvg(null)}
        />
      )}
    </div>
  );
}

/**
 * The edit-mode pane: renders the (debounced) draft, keeps the last good svg
 * when the draft breaks, and names the error's line.
 *
 * The debounce lives HERE, not in the parent: LivePreview mounts fresh at
 * the start of every edit session, so `useDebounced`'s `useState(value)`
 * seed makes its first render current immediately. Hoisting the debounce
 * into MermaidBlockView (M29.9's first cut) let it survive Escape/Done —
 * the debounced value from the closed session was still settling when the
 * next edit session reopened, so the preview briefly showed a stale render
 * for a draft the textarea no longer had.
 */
function LivePreview({ code }: { code: string }) {
  const debounced = useDebounced(code, 250);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; line: number | null } | null>(null);

  useEffect(() => {
    if (debounced.trim() === '') {
      setSvg(null);
      setError(null);
      return;
    }
    let stale = false;
    void renderMermaid(debounced).then((r) => {
      if (stale) return;
      if (r.ok) {
        setSvg(r.svg);
        setError(null);
      } else {
        setError({ message: r.message, line: r.line });
        // svg intentionally untouched: the last good render stays visible.
      }
    });
    return () => {
      stale = true;
    };
  }, [debounced]);

  return (
    <div className="min-w-[260px] flex-1 basis-[280px] border-l border-n-100 px-3 py-2">
      {error !== null && (
        <div
          data-testid="mermaid-edit-error"
          className="mb-1.5 rounded-md bg-danger-50 px-2 py-1 text-xs text-danger-700"
        >
          {error.line !== null ? `Line ${error.line}: ` : ''}
          {error.message.split('\n')[0]}
        </div>
      )}
      {svg !== null && (
        <div
          data-testid="mermaid-live-preview"
          className={`overflow-auto [&_svg]:h-auto [&_svg]:max-w-full ${error !== null ? 'opacity-60' : ''}`}
          // Safe: strict-mode mermaid output, same as every other sink in
          // this module (MermaidDiagram, MermaidLightbox) — mermaid runs in
          // securityLevel: 'strict', so the svg it returns is sanitized.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {svg === null && error === null && (
        <div className="py-4 text-center text-xs text-n-400">Preview appears as you type</div>
      )}
    </div>
  );
}
