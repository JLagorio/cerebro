import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import type { CerebroEditor } from './MarkdownEditor';

export interface OutlineItem {
  id: string;
  level: number;
  text: string;
}

/** Minimal structural view of a BlockNote block — keeps buildOutline
 * schema-agnostic (custom inline specs change the concrete Block type). */
export interface OutlineSourceBlock {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: unknown;
}

const REBUILD_DEBOUNCE_MS = 200;
const ACTIVE_OFFSET_PX = 90;

function inlineText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof n.text === 'string') return n.text;
  if (Array.isArray(n.content)) return n.content.map(inlineText).join('');
  return '';
}

/** Top-level H1–H3 blocks as a flat outline (nesting shown by indent). */
export function buildOutline(document: OutlineSourceBlock[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const block of document) {
    if (block.type !== 'heading') continue;
    const level = (block.props as { level?: number }).level ?? 1;
    if (level > 3) continue;
    const text = Array.isArray(block.content) ? block.content.map(inlineText).join('') : '';
    if (text.trim() === '') continue;
    items.push({ id: block.id, level, text });
  }
  return items;
}

const escapeAttr = (value: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');

/**
 * Table-of-contents tab of the doc side panel (M2.x docs polish — Plane's
 * outline pane pattern): live heading list, click to jump, section under the
 * viewport top highlighted while the page scrolls.
 */
export function OutlineTab({
  editor,
  scrollRef,
}: {
  editor: CerebroEditor;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [items, setItems] = useState<OutlineItem[]>(() => buildOutline(editor.document));
  const [activeId, setActiveId] = useState<string | null>(null);

  // Rebuild on document changes, debounced — typing bursts settle first.
  useEffect(() => {
    setItems(buildOutline(editor.document));
    let timer: number | null = null;
    const unsubscribe = editor.onChange?.(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        setItems(buildOutline(editor.document));
      }, REBUILD_DEBOUNCE_MS);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, [editor]);

  // Track the section under the top of the viewport while the page scrolls.
  useEffect(() => {
    const container = scrollRef.current;
    if (container === null || items.length === 0) {
      setActiveId(null);
      return;
    }
    const onScroll = () => {
      const containerTop = container.getBoundingClientRect().top;
      let current = items[0].id;
      for (const item of items) {
        const node = container.querySelector(`[data-id="${escapeAttr(item.id)}"]`);
        if (node === null) continue;
        if (node.getBoundingClientRect().top - containerTop <= ACTIVE_OFFSET_PX) {
          current = item.id;
        }
      }
      setActiveId(current);
    };
    onScroll();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [items, scrollRef]);

  if (items.length === 0) {
    return (
      <div className="px-2 py-6">
        <EmptyState
          icon="list"
          title="No headings yet"
          description="Add headings to this page to see its outline here."
        />
      </div>
    );
  }

  const jumpTo = (id: string) => {
    editor.setTextCursorPosition?.(id, 'start');
    scrollRef.current
      ?.querySelector(`[data-id="${escapeAttr(id)}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setActiveId(id);
  };

  return (
    <nav data-testid="doc-outline" aria-label="Document outline" className="py-1">
      <ul className="m-0 p-0">
        {items.map((item) => (
          <li key={item.id} className="list-none">
            <button
              type="button"
              onClick={() => jumpTo(item.id)}
              className={[
                'block w-full truncate rounded-md border-0 bg-transparent py-[5px] text-left text-sm',
                item.id === activeId
                  ? 'bg-cortex-50 font-medium text-cortex-600'
                  : 'text-n-600 hover:bg-n-50 hover:text-n-900',
              ].join(' ')}
              style={{ paddingLeft: 10 + (item.level - 1) * 14, paddingRight: 10 }}
            >
              {item.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
