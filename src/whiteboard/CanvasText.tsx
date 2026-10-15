import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
interface LabelNode {
  type: string;
  value?: string;
  children?: LabelNode[];
}
function remarkWikiLabels() {
  return (tree: LabelNode) => {
    const walk = (node: LabelNode) => {
      if (node.type === 'text' && node.value !== undefined)
        node.value = node.value.replace(
          /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
          (_all, target: string, label: string | undefined) => label ?? target,
        );
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
const components: Components = {
  a: ({ children }) => <span style={{ textDecoration: 'underline' }}>{children}</span>,
  img: ({ alt }) => <span>[image: {alt ?? ''}]</span>,
  p: ({ children }) => <p style={{ margin: '0 0 6px' }}>{children}</p>,
  h1: ({ children }) => (
    <h1 style={{ fontSize: 22, lineHeight: 1.2, fontWeight: 650, margin: '0 0 8px' }}>
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: 19, lineHeight: 1.25, fontWeight: 650, margin: '0 0 7px' }}>
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ fontSize: 16, lineHeight: 1.3, fontWeight: 650, margin: '0 0 6px' }}>
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 style={{ fontSize: 15, fontWeight: 650, margin: '0 0 6px' }}>{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 style={{ fontSize: 14, fontWeight: 650, margin: '0 0 6px' }}>{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 style={{ fontSize: 13, fontWeight: 650, margin: '0 0 6px' }}>{children}</h6>
  ),
  ul: ({ children }) => (
    <ul style={{ margin: '0 0 6px', paddingLeft: 18, listStyleType: 'disc' }}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: '0 0 6px', paddingLeft: 18, listStyleType: 'decimal' }}>{children}</ol>
  ),
  li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
  pre: ({ children }) => (
    <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '4px 0' }}>{children}</pre>
  ),
  code: ({ children }) => (
    <code style={{ fontFamily: 'monospace', fontSize: '0.9em' }}>{children}</code>
  ),
  blockquote: ({ children }) => (
    <blockquote style={{ margin: '4px 0 4px 12px', fontStyle: 'italic' }}>{children}</blockquote>
  ),
  table: ({ children }) => (
    <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>{children}</table>
  ),
  th: ({ children }) => (
    <th style={{ padding: '2px 5px', textAlign: 'left', fontWeight: 650 }}>{children}</th>
  ),
  td: ({ children }) => <td style={{ padding: '2px 5px', textAlign: 'left' }}>{children}</td>,
};
/** Exportable HTML: every paint is inline; links and images never navigate or
 * fetch. Raw HTML remains text, as in ReactMarkdown's default safe reader. */
export function CanvasText({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 14,
        lineHeight: 1.4,
        color: 'var(--n-900)',
        overflowWrap: 'anywhere',
        overflow: 'hidden',
        height: '100%',
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkWikiLabels]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
