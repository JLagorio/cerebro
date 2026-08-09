import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { MermaidDiagram } from './MermaidDiagram';
import { MermaidLightbox } from './MermaidLightbox';
import { renderMermaid } from './render';
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
  const [editing, setEditing] = useState(code.trim() === '');
  const [draft, setDraft] = useState(code);
  const [lightboxSvg, setLightboxSvg] = useState<string | null>(null);

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
        <span className="text-xs font-medium uppercase tracking-[0.05em] text-n-500">Mermaid</span>
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

      {editing && (
        <div className="flex flex-wrap">
          <textarea
            autoFocus
            aria-label="Mermaid source"
            value={draft}
            placeholder={'graph TD\n  A[Idea] --> B[Shipped]'}
            onChange={(e) => setDraft(e.target.value)}
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
            className="min-w-[260px] flex-1 basis-[280px] resize-y border-0 bg-n-25 px-3 py-2 [font-family:var(--font-mono)] text-sm leading-[1.5] text-n-800 outline-none"
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
        <button
          type="button"
          onClick={() => {
            setDraft(code);
            setEditing(true);
          }}
          className="w-full border-0 bg-transparent px-3 py-3 text-left text-sm text-n-400"
        >
          Empty diagram — click to add mermaid source
        </button>
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
