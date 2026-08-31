// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { afterEach, describe, expect, it } from 'vitest';
import { COLUMN_WIDTH_PROPERTY, syncColumnWidths } from './columnLayout';
import { cerebroSchema } from './MarkdownEditor';

/**
 * The ratio has to travel two levels UP the DOM to reach the element the
 * browser lays out, and CSS cannot go that way. If this stops working every
 * column silently renders at ratio 1: `width=2` on disk does nothing, no error
 * is raised anywhere, and the page still shows every word — which is exactly
 * the kind of failure that survives a release.
 *
 * Built against the real editor DOM rather than a hand-written fixture, so a
 * BlockNote upgrade that moves the nesting fails here instead of in the app.
 */
const hosts: HTMLElement[] = [];

function mountedEditor(children: unknown[]): HTMLElement {
  const editor = BlockNoteEditor.create({
    schema: cerebroSchema,
    initialContent: [{ type: 'columnList', children }] as never,
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  hosts.push(host);
  return host;
}

afterEach(() => {
  while (hosts.length > 0) hosts.pop()?.remove();
});

/* By POSITION, not by `[data-width=…]`: BlockNote omits a prop that is still
   at its default, so the column this feature has to get right — the ordinary
   one nobody resized — is the one that attribute selector cannot find. */
const propertyOf = (host: HTMLElement, index: number): string | undefined => {
  const column = host.querySelectorAll('[data-content-type="column"]')[index];
  const outer = column?.closest('[data-node-type="blockOuter"]');
  return outer instanceof HTMLElement
    ? outer.style.getPropertyValue(COLUMN_WIDTH_PROPERTY)
    : undefined;
};

describe('carrying a column width up to its flex item', () => {
  it('puts each ratio on the block outer that is the flex item', () => {
    const host = mountedEditor([
      { type: 'column', props: { width: 2 }, children: [{ type: 'paragraph', content: 'left' }] },
      { type: 'column', props: { width: 3 }, children: [{ type: 'paragraph', content: 'right' }] },
    ]);
    expect(syncColumnWidths(host)).toBe(2);
    expect(propertyOf(host, 0)).toBe('2');
    expect(propertyOf(host, 1)).toBe('3');
  });

  it('carries the default too, so a column never falls back to an unset property', () => {
    const host = mountedEditor([
      { type: 'column', children: [{ type: 'paragraph', content: 'only' }] },
    ]);
    syncColumnWidths(host);
    expect(propertyOf(host, 0)).toBe('1');
  });

  /* The count is the point of the return value: a page with no columns and a
     DOM whose shape moved under us both write zero properties, and only one of
     those is fine. */
  it('reports how many it moved, so nothing-to-do reads differently from nothing-found', () => {
    const plain = document.createElement('div');
    document.body.appendChild(plain);
    hosts.push(plain);
    expect(syncColumnWidths(plain)).toBe(0);
  });

  it('is idempotent', () => {
    const host = mountedEditor([
      { type: 'column', props: { width: 2 }, children: [{ type: 'paragraph', content: 'left' }] },
    ]);
    syncColumnWidths(host);
    syncColumnWidths(host);
    expect(propertyOf(host, 0)).toBe('2');
  });
});
