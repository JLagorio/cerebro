import { useEffect, useState, type ReactNode } from 'react';
import { useTheme } from '@/hooks/useTheme';
import { useUiStore } from '@/stores/uiStore';
import { highlight, languageFor } from './highlighter';

/**
 * Read-only, highlighted source.
 *
 * Re-highlights when the app theme flips: Shiki bakes colours into the output,
 * so a themed render is only correct for the theme it was made under.
 *
 * Line numbers are a CSS counter on `.line`, never elements. A number that is
 * a real node is a number that lands in the clipboard, and code copied out of
 * a viewer with its line numbers attached is code you have to clean by hand.
 *
 * Nothing here can write a file — M30 ships a viewer, and editing arrives with
 * C-prime alongside dirty state, save conflicts and undo.
 */
export function CodeViewer({ content, path }: { content: string; path: string }) {
  const theme = useTheme();
  const lineNumbers = useUiStore((s) => s.workspaceLineNumbers);
  const wrap = useUiStore((s) => s.workspaceWordWrap);
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

  // The gutter is sized from the widest number it will ever hold, so it does
  // not jump a character wider as you scroll past line 99.
  const digits = Math.max(2, String(content.split('\n').length).length);

  return (
    <div
      data-testid="code-viewer"
      data-lang={languageFor(path) ?? 'plain'}
      data-wrap={wrap}
      data-line-numbers={lineNumbers}
      style={{ ['--cb-gutter' as string]: `${digits + 1}ch` }}
      // No LEFT padding while numbered: sticky pins to the scroll container's
      // content box, so left padding is a strip the gutter cannot cover and
      // the scrolling code shows through beside the numbers. The gutter brings
      // its own inset instead.
      className={`code-surface min-h-0 flex-1 overflow-auto py-4 pr-4 text-[13px] leading-[1.6] [font-family:var(--font-mono)] ${
        lineNumbers ? 'code-numbered pl-0' : 'pl-4'
      } ${wrap ? 'code-wrap' : ''}`}
    >
      {/* Unhighlighted until the grammar loads: the text is readable either
          way, and blocking on a lazy import would make every file flash. */}
      {nodes ?? <pre className="m-0 whitespace-pre">{content}</pre>}
    </div>
  );
}
