import { afterEach, describe, expect, it } from 'vitest';
import { claimedByHostEditor, claimsKey, claimsOf, isEditableTarget } from './claims';

const key = (k: string, init: Partial<KeyboardEventInit> = {}) =>
  new KeyboardEvent('keydown', { key: k, ...init });

afterEach(() => {
  document.body.replaceChildren();
});

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

describe('isEditableTarget', () => {
  it('is true for text inputs, textareas, selects, contenteditable and textboxes', () => {
    const host = mount(
      '<input id="t"><input id="c" type="checkbox"><textarea id="a"></textarea>' +
        '<select id="s"></select><div contenteditable="true"><p id="p">x</p></div>' +
        '<div role="textbox"><span id="r">x</span></div>',
    );
    const at = (id: string) => host.querySelector(`#${id}`);
    expect(isEditableTarget(at('t'))).toBe(true);
    expect(isEditableTarget(at('a'))).toBe(true);
    expect(isEditableTarget(at('s'))).toBe(true);
    expect(isEditableTarget(at('p'))).toBe(true);
    expect(isEditableTarget(at('r'))).toBe(true);
    expect(isEditableTarget(at('c'))).toBe(false);
    expect(isEditableTarget(document.body)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
  });

  it('is false inside a contenteditable="false" island in an editor', () => {
    const host = mount(
      '<div contenteditable="true"><div contenteditable="false"><button id="b">Edit</button></div></div>',
    );
    expect(isEditableTarget(host.querySelector('#b'))).toBe(false);
  });
});

describe('claimsOf', () => {
  it('unions every ancestor claim', () => {
    const host = mount(
      '<div data-key-claim="typing"><div data-key-claim="editor"><button id="b"></button></div></div>',
    );
    expect([...claimsOf(host.querySelector('#b'))].sort()).toEqual(['editor', 'typing']);
  });

  it('gives an editable target the editor claim unasked', () => {
    const host = mount('<textarea id="a"></textarea>');
    expect([...claimsOf(host.querySelector('#a'))]).toEqual(['editor']);
    expect(claimsOf(document.body).size).toBe(0);
  });
});

describe('claimsKey', () => {
  it('typing keeps every key without ⌘ ⌃ ⌥, and no modified one', () => {
    const typing = new Set(['typing'] as const);
    expect(claimsKey(typing, key('j'))).toBe(true);
    expect(claimsKey(typing, key('G', { shiftKey: true }))).toBe(true);
    expect(claimsKey(typing, key('Enter'))).toBe(true);
    expect(claimsKey(typing, key('z', { metaKey: true }))).toBe(false);
    expect(claimsKey(typing, key('k', { metaKey: true }))).toBe(false);
  });

  it('editor also keeps history, the marks, select-all and ⌘Enter', () => {
    const editor = new Set(['editor'] as const);
    for (const k of ['z', 'Z', 'y', 'b', 'i', 'u', 'a', 'Enter']) {
      expect(claimsKey(editor, key(k, { metaKey: true }))).toBe(true);
    }
    expect(claimsKey(editor, key('z', { ctrlKey: true }))).toBe(true);
    for (const k of ['k', 'j', '[', 'e']) {
      expect(claimsKey(editor, key(k, { metaKey: true }))).toBe(false);
    }
  });

  it('nothing claimed keeps nothing', () => {
    expect(claimsKey(new Set(), key('j'))).toBe(false);
  });
});

// M29.53's cases, unchanged by the move out of src/mermaid/keys.ts.
describe('claimedByHostEditor', () => {
  const k = (name: string, mod = false) => ({ key: name, metaKey: mod, ctrlKey: false });

  it('claims every unmodified key', () => {
    for (const name of ['a', 'Enter', 'Backspace', 'Delete', 'ArrowLeft', 'Escape', ' ']) {
      expect(claimedByHostEditor(k(name))).toBe(true);
    }
  });

  it('claims the modified keys a rich-text editor owns', () => {
    for (const name of ['z', 'Z', 'y', 'b', 'i', 'u', 'a', 'Enter']) {
      expect(claimedByHostEditor(k(name, true))).toBe(true);
    }
  });

  it('lets the app keep its own shortcuts', () => {
    for (const name of ['k', 'j', 'l', 'n', '[', ']', '/']) {
      expect(claimedByHostEditor(k(name, true))).toBe(false);
    }
  });
});
