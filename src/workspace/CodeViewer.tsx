import { useEffect, useState, type ReactNode } from 'react';
import { useTheme } from '@/hooks/useTheme';
import { highlight, languageFor } from './highlighter';

/**
 * Read-only, highlighted source.
 *
 * Re-highlights when the app theme flips: Shiki bakes colours into the output,
 * so a themed render is only correct for the theme it was made under.
 *
 * Nothing here can write a file — M30 ships a viewer, and editing arrives with
 * C-prime alongside dirty state, save conflicts and undo.
 */
export function CodeViewer({ content, path }: { content: string; path: string }) {
  const theme = useTheme();
  const [nodes, setNodes] = useState<ReactNode | null>(null);

  useEffect(() => {
    let live = true;
    setNodes(null);
    void highlight(content, languageFor(path), theme).then((out) => {
      if (live) setNodes(out);
    });
    return () => {
      live = false;
    };
  }, [content, path, theme]);

  return (
    <div
      data-testid="code-viewer"
      data-lang={languageFor(path) ?? 'plain'}
      className="code-surface min-h-0 flex-1 overflow-auto p-4 text-[13px] leading-[1.6] [font-family:var(--font-mono)]"
    >
      {/* Unhighlighted until the grammar loads: the text is readable either
          way, and blocking on a lazy import would make every file flash. */}
      {nodes ?? <pre className="m-0 whitespace-pre">{content}</pre>}
    </div>
  );
}
