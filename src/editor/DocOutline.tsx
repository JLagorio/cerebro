import { useEffect, useState } from 'react';
import type { Block, BlockNoteEditor } from '@blocknote/core';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { useUiStore } from '@/stores/uiStore';

export interface OutlineItem {
  id: string;
  level: number;
  text: string;
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
export function buildOutline(document: Block[]): OutlineItem[] {
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
 * Floating table of contents for a doc (M2 Task 15, per the OKR mock and
 * Tolaria's TOC panel): fixed at the top-right of the editor area while the
 * page scrolls under it; minimizes to a floating button. Collapse state
 * persists across sessions.
 */
export function DocOutline({
  editor,
  scrollRef,
}: {
  editor: BlockNoteEditor;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const collapsed = useUiStore((s) => s.docOutlineCollapsed);
  const setCollapsed = useUiStore((s) => s.setDocOutlineCollapsed);
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

  if (items.length === 0) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        aria-label="Show outline"
        onClick={() => setCollapsed(false)}
        className="absolute right-4 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--n-200)] bg-[var(--n-0)] text-[var(--n-500)] shadow-[0_2px_8px_rgba(22,26,36,0.10)] hover:text-[var(--n-800)]"
      >
        <Icon name="list" size={15} />
      </button>
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
    <nav
      data-testid="doc-outline"
      aria-label="Document outline"
      className="absolute right-4 top-2 z-10 flex w-[220px] max-h-[60vh] flex-col rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] shadow-[0_4px_16px_rgba(22,26,36,0.08)]"
    >
      <div className="flex flex-none items-center gap-1.5 px-2.5 pb-1 pt-2">
        <Icon name="list" size={13} color="var(--n-500)" />
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--n-500)]">
          Outline
        </span>
        <IconButton
          icon="minus"
          label="Hide outline"
          size="sm"
          onClick={() => setCollapsed(true)}
        />
      </div>
      <ul className="m-0 flex-1 overflow-y-auto p-0 px-1 pb-2">
        {items.map((item) => (
          <li key={item.id} className="list-none">
            <button
              type="button"
              onClick={() => jumpTo(item.id)}
              className={[
                'block w-full truncate rounded-md border-0 bg-transparent py-1 text-left text-[12px]',
                item.id === activeId
                  ? 'font-medium text-[var(--cortex-600)]'
                  : 'text-[var(--n-600)] hover:text-[var(--n-900)]',
              ].join(' ')}
              style={{ paddingLeft: 8 + (item.level - 1) * 12, paddingRight: 8 }}
            >
              {item.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
