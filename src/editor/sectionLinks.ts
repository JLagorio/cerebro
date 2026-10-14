/**
 * Landing on a section (M55.8): what a `[[page#Heading]]` click asks of the
 * page it opens, and how that page finds and shows the heading.
 *
 * A click and the editor that answers it are far apart. A link to another
 * page navigates, and the page's editor mounts and loads its blocks some time
 * later; a link into the page it sits on has an editor already. So a click
 * leaves a request here, keyed by the page's path, and the editor showing
 * that path takes it: at once when one is watching, else once its blocks have
 * loaded. A request nobody takes in `SECTION_REQUEST_TTL_MS` lapses, so a
 * page opened much later never jumps to a heading the reader stopped asking
 * for.
 *
 * No BlockNote import: the editor hands its blocks in, and the DOM it reveals
 * is located by the classes BlockNote renders.
 */
import { inlineText } from './DocOutline';

/** How long a request waits for an editor to take it. */
export const SECTION_REQUEST_TTL_MS = 10_000;

type Listener = (section: string) => void;

interface Pending {
  path: string;
  section: string;
  at: number;
}

const watchers = new Map<string, Set<Listener>>();
let pending: Pending | null = null;

/**
 * Ask the editor showing `path` to land on `section`. Every editor watching
 * that path is told now; with none watching, the request waits for one, and
 * a newer request replaces it.
 */
export function requestSection(path: string, section: string, now = Date.now()): void {
  const live = watchers.get(path);
  if (live !== undefined && live.size > 0) {
    pending = null;
    for (const listener of [...live]) listener(section);
    return;
  }
  pending = { path, section, at: now };
}

/**
 * Watch for section requests on `path`. A request still waiting for that path
 * is delivered once, now; later ones as they are made. Returns the
 * unsubscribe.
 */
export function watchSections(path: string, listener: Listener, now = Date.now()): () => void {
  let set = watchers.get(path);
  if (set === undefined) {
    set = new Set();
    watchers.set(path, set);
  }
  set.add(listener);
  const waiting = pending;
  if (waiting !== null && waiting.path === path) {
    pending = null;
    if (now - waiting.at <= SECTION_REQUEST_TTL_MS) listener(waiting.section);
  }
  return () => {
    const current = watchers.get(path);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) watchers.delete(path);
  };
}

/** Test seam, like openPages.ts's reset: no watchers and nothing waiting. */
export function __resetSectionLinks(): void {
  watchers.clear();
  pending = null;
}

/** The slice of a BlockNote block `findSectionBlock` reads. */
export interface SectionSourceBlock {
  id: string;
  type: string;
  content?: unknown;
  children?: SectionSourceBlock[];
}

const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The id of the first heading, depth-first through every block's children
 * (columns, toggles, AI answers), whose text is `section`'s: trimmed,
 * whitespace collapsed and case folded on both sides. Chips add no text,
 * as in the outline. Null when no heading matches.
 */
export function findSectionBlock(blocks: SectionSourceBlock[], section: string): string | null {
  const wanted = normalize(section);
  if (wanted === '') return null;
  const walk = (list: SectionSourceBlock[]): string | null => {
    for (const block of list) {
      if (block.type === 'heading' && Array.isArray(block.content)) {
        if (normalize(block.content.map(inlineText).join('')) === wanted) return block.id;
      }
      const inner = Array.isArray(block.children) ? walk(block.children) : null;
      if (inner !== null) return inner;
    }
    return null;
  };
  return walk(blocks);
}

const escapeId = (id: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(id)
    : id.replace(/["\\]/g, '\\$&');

/** The rendered block `blockId`, inside `host`. */
export function blockElement(host: ParentNode, blockId: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`.bn-block[data-id="${escapeId(blockId)}"]`);
}

/**
 * A block's own content element: the trap-1 form, since the browser wraps a
 * React block in an element jsdom does not.
 */
export function blockContent(block: Element): HTMLElement | null {
  return block.querySelector<HTMLElement>(
    ':scope > .bn-block-content, :scope > * > .bn-block-content',
  );
}

/**
 * Open every closed toggle around `block`, outermost first (the M55.4
 * contract). BlockNote hides a closed toggle's children and marks it
 * `data-show-children="false"`; its own button is the only thing that opens
 * it, and opening one also records the choice the way a click would.
 */
function openTogglesAround(block: HTMLElement): void {
  const closed: HTMLElement[] = [];
  for (
    let outer = block.parentElement?.closest<HTMLElement>('.bn-block');
    outer != null;
    outer = outer.parentElement?.closest<HTMLElement>('.bn-block')
  ) {
    const wrapper = blockContent(outer)?.querySelector<HTMLElement>(
      ':scope > div > .bn-toggle-wrapper',
    );
    if (wrapper?.getAttribute('data-show-children') === 'false') closed.push(wrapper);
  }
  for (const wrapper of closed.reverse()) {
    wrapper.querySelector<HTMLButtonElement>(':scope > .bn-toggle-button')?.click();
  }
}

/**
 * Bring block `blockId` into view at the top of its scroller, opening the
 * toggles that hide it first. The node view may not be mounted yet, so it is
 * looked for again on the next few frames; false once it gives up.
 */
export function revealBlock(
  host: HTMLElement,
  blockId: string,
  tries = 10,
  done?: (found: boolean) => void,
): void {
  const block = blockElement(host, blockId);
  if (block !== null) {
    openTogglesAround(block);
    block.scrollIntoView({ block: 'start', behavior: 'smooth' });
    done?.(true);
    return;
  }
  if (tries > 0) {
    window.requestAnimationFrame(() => revealBlock(host, blockId, tries - 1, done));
    return;
  }
  done?.(false);
}
