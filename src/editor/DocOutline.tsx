import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useEscapeLayer } from '@/components/ui/Popover';
import type { CerebroEditor } from './MarkdownEditor';
import './outline.css';

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
/** A heading is the current section once its top is this close to the page's top. */
const ACTIVE_OFFSET_PX = 90;
/** Where a jump puts a heading: this far below the page's top. */
const JUMP_OFFSET_PX = 24;
/** A jump has landed once the page has been still this long. */
const JUMP_SETTLE_MS = 150;
/** An outline of one heading is noise. */
const MIN_HEADINGS = 2;
/** The rail draws this many marks at most; the list holds every heading. */
const MAX_MARKS = 24;

/** The text of an inline node, chips read as nothing: what the outline lists a
 * heading by, and what a section link matches it by (M55.8). */
export function inlineText(node: unknown): string {
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

/** The headings a page's outline lists. With `skipTitle`, the H1 the page
 * shows as its title is left out: the first top-level H1, as
 * `pageTitleProjection.ts` finds it, taken by id before blank headings drop,
 * so a blank title never takes a later H1 with it. */
export function outlineOf(
  document: OutlineSourceBlock[],
  { skipTitle }: { skipTitle: boolean },
): OutlineItem[] {
  const items = buildOutline(document);
  if (!skipTitle) return items;
  const title = document.find(
    (block) => block.type === 'heading' && ((block.props as { level?: number }).level ?? 1) === 1,
  );
  return title === undefined ? items : items.filter((item) => item.id !== title.id);
}

const sameOutline = (a: OutlineItem[], b: OutlineItem[]): boolean =>
  a.length === b.length &&
  a.every((item, i) => item.id === b[i].id && item.level === b[i].level && item.text === b[i].text);

const escapeAttr = (value: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');

/** A heading's block in the page, by the id BlockNote renders on it. */
const blockIn = (container: HTMLElement, id: string): Element | null =>
  container.querySelector(`[data-id="${escapeAttr(id)}"]`);

/** (Re)starts the wait for a jump to land: it holds until the page has been
 * still for JUMP_SETTLE_MS. */
function holdJump(jump: { current: number | null }) {
  if (jump.current !== null) window.clearTimeout(jump.current);
  jump.current = window.setTimeout(() => {
    jump.current = null;
  }, JUMP_SETTLE_MS);
}

/** Escape while the card is open, through the app's layers (CV-47): the kind
 *  a tooltip is, so a surface beneath keeps its own Escape for the next one. */
function OutlineEscape({ onEscape }: { onEscape: () => void }) {
  useEscapeLayer(onEscape, { kind: 'tooltip' });
  return null;
}

/**
 * The page's outline, on the page as Notion draws its table of contents
 * (owner, 2026-10-19): a short stack of marks at the right edge, one per
 * heading, the current section's darker, that opens into the list of headings
 * on hover or keyboard focus (`outline.css`). A click moves the caret to the
 * heading, without focusing the editor, and scrolls it under the page's top.
 *
 * Escape puts the open card away (WCAG 1.4.13): opened under the pointer, it
 * stays folded until the pointer leaves; from the keyboard, focus goes into
 * the page, at the heading the caret was last moved to.
 *
 * The host renders it in a positioned element that does not scroll, beside the
 * page's scroll container (`scrollRef`). With `skipTitle`, the H1 the page
 * shows as its title is not listed.
 */
export function DocOutline({
  editor,
  scrollRef,
  skipTitle,
}: {
  editor: CerebroEditor;
  scrollRef: RefObject<HTMLElement | null>;
  skipTitle: boolean;
}) {
  const [items, setItems] = useState<OutlineItem[]>(() =>
    outlineOf(editor.document, { skipTitle }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  // Whether the card is out (the pointer over the outline, or focus in it),
  // and whether Escape put it away until the pointer or focus leaves.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Held while a jump scrolls the page: the headings it passes on the way are
  // not where the reader is, so the one they picked stays current.
  const jumpRef = useRef<number | null>(null);

  // Rebuild on document changes, debounced — typing bursts settle first.
  useEffect(() => {
    const rebuild = () => {
      const next = outlineOf(editor.document, { skipTitle });
      setItems((prev) => (sameOutline(prev, next) ? prev : next));
    };
    rebuild();
    let timer: number | null = null;
    const unsubscribe = editor.onChange?.(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        rebuild();
      }, REBUILD_DEBOUNCE_MS);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, [editor, skipTitle]);

  // The current section: the last heading whose top has come within
  // ACTIVE_OFFSET_PX of the page's top. Measured at most once a frame.
  useEffect(() => {
    const container = scrollRef.current;
    if (container === null || items.length < MIN_HEADINGS) return;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      if (jumpRef.current !== null) return;
      const top = container.getBoundingClientRect().top;
      let current = items[0].id;
      for (const item of items) {
        const node = blockIn(container, item.id);
        if (node === null) continue;
        // Top-level blocks stack in document order: the rest are lower still.
        if (node.getBoundingClientRect().top - top > ACTIVE_OFFSET_PX) break;
        current = item.id;
      }
      setActiveId(current);
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(measure);
    };
    const onScroll = () => {
      if (jumpRef.current === null) schedule();
      else holdJump(jumpRef);
    };
    measure();
    container.addEventListener('scroll', onScroll, { passive: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resize?.observe(container);
    return () => {
      container.removeEventListener('scroll', onScroll);
      resize?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [items, scrollRef]);

  // A jump still landing ends with the outline.
  useEffect(
    () => () => {
      if (jumpRef.current !== null) window.clearTimeout(jumpRef.current);
      jumpRef.current = null;
    },
    [],
  );

  const current = items.some((item) => item.id === activeId) ? activeId : (items[0]?.id ?? null);

  // A list longer than the card keeps the current heading in view, so it
  // opens on it. Only the card scrolls; the page stays where it is.
  useEffect(() => {
    const card = cardRef.current;
    if (card === null) return;
    const row = card.querySelector<HTMLElement>('[aria-current="location"]');
    if (row === null) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < card.scrollTop) card.scrollTop = top;
    else if (bottom > card.scrollTop + card.clientHeight)
      card.scrollTop = bottom - card.clientHeight;
  }, [current]);

  if (items.length < MIN_HEADINGS) return null;

  const jumpTo = (id: string) => {
    setActiveId(id);
    holdJump(jumpRef);
    try {
      editor.setTextCursorPosition?.(id, 'start');
    } catch {
      // The heading went between the last rebuild and this click.
    }
    const container = scrollRef.current;
    const node = container === null ? null : blockIn(container, id);
    if (container === null || node === null) return;
    const offset = node.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    // Optional call: jsdom has no Element.scrollTo.
    container.scrollTo?.({
      top: Math.max(0, container.scrollTop + offset - JUMP_OFFSET_PX),
      behavior: reduced ? 'auto' : 'smooth',
    });
  };

  return (
    <nav
      ref={navRef}
      data-testid="doc-outline"
      aria-label="Outline"
      className="cb-doc-outline"
      data-dismissed={dismissed || undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false);
        setDismissed(false);
      }}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setFocused(false);
        setDismissed(false);
      }}
    >
      {(hovered || focused) && !dismissed && (
        <OutlineEscape
          onEscape={() => {
            if (navRef.current?.contains(document.activeElement) === true) editor.focus?.();
            else setDismissed(true);
          }}
        />
      )}
      <div data-testid="doc-outline-rail" className="cb-doc-outline-rail" aria-hidden="true">
        {items.slice(0, MAX_MARKS).map((item) => (
          <span
            key={item.id}
            className="cb-doc-outline-bar"
            data-level={item.level}
            data-active={item.id === current ? 'true' : undefined}
          />
        ))}
      </div>
      <div ref={cardRef} data-testid="doc-outline-card" className="cb-doc-outline-card">
        <ul>
          {items.map((item, index) => (
            // Its place in the list times its arrival (outline.css), the
            // first dozen a beat apart and the rest with the twelfth.
            <li key={item.id} style={{ '--i': Math.min(index, 12) } as CSSProperties}>
              <button
                type="button"
                className="cb-doc-outline-item"
                data-level={item.level}
                aria-current={item.id === current ? 'location' : undefined}
                style={{ paddingLeft: 10 + (item.level - 1) * 12 }}
                onClick={(event) => {
                  // A pointer leaves no focus in the list, as WebKit never
                  // focuses a clicked button, so the card closes when the
                  // pointer leaves; a key press keeps focus and the card open.
                  if (event.detail > 0) event.currentTarget.blur();
                  jumpTo(item.id);
                }}
              >
                {item.text}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
