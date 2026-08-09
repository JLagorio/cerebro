import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { MermaidDiagram } from './MermaidDiagram';
import { MermaidLightbox } from './MermaidLightbox';

/**
 * The mermaid block's body (M29.6) — moved out of editor/blocks.tsx so the
 * editor keeps only BlockNote glue. Rendering goes through the shared core;
 * this file owns block chrome and the edit lifecycle. Stage B replaces the
 * textarea toggle with side-by-side live editing; Stage C adds the structural
 * editor. Both land here.
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
        <textarea
          autoFocus
          aria-label="Mermaid source"
          value={draft}
          placeholder={'graph TD\n  A[Idea] --> B[Shipped]'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.stopPropagation()}
          rows={Math.max(4, draft.split('\n').length + 1)}
          className="w-full resize-y border-0 bg-n-25 px-3 py-2 [font-family:var(--font-mono)] text-sm leading-[1.5] text-n-800 outline-none"
        />
      )}

      {!editing && code.trim() !== '' && (
        <div className="px-3 py-2">
          <MermaidDiagram code={code} onExpand={(svg) => setLightboxSvg(svg)} />
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
