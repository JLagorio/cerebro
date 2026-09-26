// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownsEscape, pushLayer, resetLayers } from '@/components/ui/layers';
import { BlockGrip, measureBlocks, measureParentage } from './BlockDragLayer';

/**
 * The DOM half of the block drag (M48.4).
 *
 * Built on a hand-written tree rather than a mounted editor on purpose: what
 * these two functions know is the SHAPE BlockNote renders — `blockOuter`
 * nesting and `data-id` — and a fixture states that shape out loud. The real
 * editor's DOM is asserted separately, in a browser, where the geometry can
 * actually be measured (`e2e/block-drag.spec.ts`).
 */

const el = (className: string, attrs: Record<string, string> = {}): HTMLElement => {
  const node = document.createElement('div');
  node.className = className;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

/** One block outer, with its inner `.bn-block` and an optional child group. */
function blockOuter(id: string, children: HTMLElement[] = []): HTMLElement {
  const outer = el('bn-block-outer', { 'data-node-type': 'blockOuter', 'data-id': id });
  outer.appendChild(el('bn-block', { 'data-node-type': 'blockContainer' }));
  if (children.length > 0) {
    const group = el('bn-block-group', { 'data-node-type': 'blockGroup' });
    for (const child of children) group.appendChild(child);
    outer.appendChild(group);
  }
  return outer;
}

/** `a`, then `b` holding `c`, then `d` — so depth has something to count. */
function tree(): HTMLElement {
  const root = document.createElement('div');
  root.append(blockOuter('a'), blockOuter('b', [blockOuter('c')]), blockOuter('d'));
  document.body.appendChild(root);
  return root;
}

// jsdom lays nothing out, so every rect it reports is zero — and a zero-height
// block is skipped by design. One stub, stating what each box would be.
const BOXES: Record<string, { top: number; bottom: number; left: number; right: number }> = {
  a: { top: 0, bottom: 40, left: 0, right: 600 },
  b: { top: 50, bottom: 150, left: 0, right: 600 },
  c: { top: 60, bottom: 100, left: 24, right: 600 },
  d: { top: 160, bottom: 200, left: 0, right: 600 },
};

const asRect = (box: { top: number; bottom: number; left: number; right: number }): DOMRect =>
  ({
    ...box,
    width: box.right - box.left,
    height: box.bottom - box.top,
    x: box.left,
    y: box.top,
    toJSON: () => '',
  }) as DOMRect;

function stubRects(root: HTMLElement) {
  for (const node of root.querySelectorAll('[data-node-type="blockOuter"]')) {
    const box = BOXES[node.getAttribute('data-id') ?? ''];
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(asRect(box));
  }
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  resetLayers();
});

describe('measuring the blocks a drag can land between', () => {
  it('reads every block in document order, with its depth counted from the DOM', () => {
    const root = tree();
    stubRects(root);
    expect(measureBlocks(root, null).map((b) => `${b.id}@${b.depth}`)).toEqual([
      'a@0',
      'b@0',
      'c@1',
      'd@0',
    ]);
  });

  it('carries each block’s box through unchanged', () => {
    const root = tree();
    stubRects(root);
    expect(measureBlocks(root, null).find((b) => b.id === 'c')).toMatchObject({
      top: 60,
      bottom: 100,
      left: 24,
      right: 600,
    });
  });

  /* A block cannot land inside itself, and offering the line would be
     offering to delete the subtree that came with it. */
  it('leaves out the dragged block AND everything inside it', () => {
    const root = tree();
    stubRects(root);
    expect(measureBlocks(root, 'b').map((b) => b.id)).toEqual(['a', 'd']);
  });

  it('leaves out a block with no height, which is a block with nowhere to aim', () => {
    const root = tree();
    stubRects(root);
    const hidden = root.querySelector('[data-id="d"]');
    if (hidden !== null) {
      vi.spyOn(hidden, 'getBoundingClientRect').mockReturnValue(
        asRect({ top: 0, bottom: 0, left: 0, right: 0 }),
      );
    }
    expect(measureBlocks(root, null).map((b) => b.id)).toEqual(['a', 'b', 'c']);
  });

  it('answers nothing for a tree with no blocks in it', () => {
    const empty = document.createElement('div');
    document.body.appendChild(empty);
    expect(measureBlocks(empty, null)).toEqual([]);
  });

  /* The id goes into an attribute selector. Ids are uuids today, and a `"` in
     one would otherwise be a broken selector rather than a missed match. */
  it('does not break on an id that would need escaping', () => {
    const root = document.createElement('div');
    root.append(blockOuter('od"d'), blockOuter('a'));
    document.body.appendChild(root);
    for (const node of root.querySelectorAll('[data-node-type="blockOuter"]')) {
      vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(asRect(BOXES.a));
    }
    expect(measureBlocks(root, 'od"d').map((b) => b.id)).toEqual(['a']);
  });
});

describe('measuring which block holds which', () => {
  it('names each block’s parent, and null at the top level', () => {
    expect(measureParentage(tree())).toEqual([
      { id: 'a', parentId: null },
      { id: 'b', parentId: null },
      { id: 'c', parentId: 'b' },
      { id: 'd', parentId: null },
    ]);
  });
});

/* jsdom has no `PointerEvent`. A `MouseEvent` under the pointer type reaches
   the same listeners — React's included — with the `button` and coordinates
   the grip reads. */
const pointer = (type: string, init: MouseEventInit = {}) =>
  act(() => {
    const event = new MouseEvent(type, { bubbles: true, ...init });
    if (type === 'pointerdown') screen.getByRole('button', { name: 'grip' }).dispatchEvent(event);
    else window.dispatchEvent(event);
  });

/** Picks `a` up and carries it down past `d`, where it has somewhere to land. */
function dragAPastD(onDrop = vi.fn()) {
  const root = tree();
  stubRects(root);
  render(
    <BlockGrip blockId="a" hostRef={{ current: root }} onDrop={onDrop}>
      <button type="button">grip</button>
    </BlockGrip>,
  );
  pointer('pointerdown', { button: 0, clientX: 10, clientY: 20 });
  pointer('pointermove', { clientX: 300, clientY: 190 });
  return { root, onDrop };
}

describe('the grip’s pointer loop', () => {
  // The control for the case below: this same drag, released, DOES land.
  it('drops the block where the line was when the pointer comes up', () => {
    const { onDrop } = dragAPastD();
    expect(screen.getByTestId('block-drop-line').getAttribute('data-block')).toBe('d');
    pointer('pointerup');
    expect(onDrop).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: 'd', placement: 'after' }),
    );
  });

  /* A `pointercancel` is the browser taking the pointer back — a touch that
     turned into a scroll, the OS claiming the gesture. It is not a release.
     Left live, the next `pointerup` anywhere dropped the block on the last
     line painted, and the drag held Escape until then. */
  it('abandons on pointercancel: nothing lands, even on a later pointerup', () => {
    pushLayer('beneath', { kind: 'surface' });
    const { root, onDrop } = dragAPastD();
    expect(root.classList.contains('cb-block-dragging')).toBe(true);
    expect(ownsEscape('beneath')).toBe(false);
    pointer('pointercancel');
    expect(root.classList.contains('cb-block-dragging')).toBe(false);
    expect(screen.queryByTestId('block-drop-line')).toBeNull();
    expect(ownsEscape('beneath')).toBe(true);
    pointer('pointerup');
    expect(onDrop).not.toHaveBeenCalled();
  });
});
