import { useEffect, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTheme } from '@/hooks/useTheme';
import { useRootsStore } from '@/stores/rootsStore';
import { classifyHref, resolveRelative } from './docLinks';
import { highlight } from './highlighter';

/** The `language-xxx` class react-markdown puts on a fenced block. */
const FENCE_LANG = /language-(\w+)/;

/**
 * A fence, highlighted through the shared Shiki instance.
 *
 * Dispatched by fence LANGUAGE, which is what makes the renderer pluggable:
 * merging M29 means registering `mermaid` here, not reworking the viewer.
 * `mermaid` is already a dependency on this base, so that costs no new package.
 */
function Fence({ lang, code }: { lang: string | null; code: string }) {
  const theme = useTheme();
  const [nodes, setNodes] = useState<ReactNode | null>(null);

  useEffect(() => {
    let live = true;
    setNodes(null);
    void highlight(code, lang, theme).then((out) => {
      if (live) setNodes(out);
    });
    return () => {
      live = false;
    };
  }, [code, lang, theme]);

  return (
    <div className="code-surface my-3 overflow-x-auto rounded-md p-3 text-[13px] leading-[1.6]">
      {nodes ?? <pre className="m-0 whitespace-pre">{code}</pre>}
    </div>
  );
}

/**
 * The reading surface. Read-only, measure-controlled, and the reason this
 * milestone built a viewer rather than rendering repo markdown as table rows.
 */
export function DocViewer({
  rootId,
  path,
  content,
}: {
  rootId: string;
  path: string;
  content: string;
}) {
  const openFile = useRootsStore((s) => s.openFile);

  return (
    <article
      data-testid="doc-viewer"
      data-path={path}
      className="doc-prose mx-auto min-h-0 w-full max-w-[72ch] flex-1 overflow-y-auto px-8 py-8 text-[15px] leading-7"
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...rest }) {
            const target = href ?? '';
            const kind = classifyHref(target);
            // A relative link is a place in the repo. Following it in-app is
            // what turns a pile of markdown into browsable documentation.
            if (kind === 'internal') {
              return (
                <a
                  {...rest}
                  href={target}
                  data-testid="doc-internal-link"
                  className="text-cortex-600 underline underline-offset-2"
                  onClick={(e) => {
                    e.preventDefault();
                    openFile(rootId, resolveRelative(path, target));
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a
                {...rest}
                href={target}
                className="text-cortex-600 underline underline-offset-2"
                target={kind === 'external' ? '_blank' : undefined}
                rel={kind === 'external' ? 'noreferrer' : undefined}
              >
                {children}
              </a>
            );
          },
          img({ src, alt, ...rest }) {
            const source = typeof src === 'string' ? src : '';
            if (classifyHref(source) !== 'internal') {
              return <img {...rest} src={source} alt={alt ?? ''} className="max-w-full" />;
            }
            // Relative images resolve against the file. The resolved path is
            // recorded so the asset pipeline (and its containment guard) has
            // one place to read it from.
            return (
              <img
                {...rest}
                data-testid="doc-image"
                data-resolved={resolveRelative(path, source)}
                src={source}
                alt={alt ?? ''}
                className="max-w-full"
              />
            );
          },
          code({ className, children, ...rest }) {
            const match = FENCE_LANG.exec(className ?? '');
            const text = String(children).replace(/\n$/, '');
            // Inline code carries no language class and stays inline.
            if (match === null && !text.includes('\n')) {
              return (
                <code className="rounded-sm bg-n-50 px-1 py-px text-[0.9em]" {...rest}>
                  {children}
                </code>
              );
            }
            return <Fence lang={match?.[1] ?? null} code={text} />;
          },
        }}
      >
        {content}
      </Markdown>
    </article>
  );
}
