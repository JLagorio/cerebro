import { useEffect, useState, type ReactNode } from 'react';
import { highlight, languageFor } from './highlighter';

/**
 * Read-only, highlighted source.
 *
 * Nothing here can write a file — M30 ships a viewer, and editing arrives with
 * C-prime alongside dirty state, save conflicts and undo.
 */
export function CodeViewer({ content, path }: { content: string; path: string }) {
  const [nodes, setNodes] = useState<ReactNode | null>(null);

  useEffect(() => {
    let live = true;
    void highlight(content, languageFor(path)).then((out) => {
      if (live) setNodes(out);
    });
    return () => {
      live = false;
    };
  }, [content, path]);

  return (
    <div
      data-testid="code-viewer"
      data-lang={languageFor(path) ?? 'plain'}
      className="min-h-0 flex-1 overflow-auto p-4 text-sm [font-family:var(--font-mono)]"
    >
      {/* Unhighlighted until the grammar loads: the text is readable either
          way, and blocking on a lazy import would make every file flash. */}
      {nodes ?? <pre className="m-0">{content}</pre>}
    </div>
  );
}
