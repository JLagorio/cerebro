import { describe, expect, it } from 'vitest';
import { claimedByHostEditor } from './keys';

const key = (k: string, mod = false) => ({ key: k, metaKey: mod, ctrlKey: false });

describe('claimedByHostEditor', () => {
  it('claims every unmodified key — those are the ones BlockNote and the canvas read', () => {
    for (const k of ['a', 'Enter', 'Backspace', 'Delete', 'ArrowLeft', 'Escape', ' ']) {
      expect(claimedByHostEditor(key(k))).toBe(true);
    }
  });

  it('claims the modified keys a rich-text editor owns', () => {
    for (const k of ['z', 'Z', 'y', 'b', 'i', 'u', 'a', 'Enter']) {
      expect(claimedByHostEditor(key(k, true))).toBe(true);
    }
  });

  it('lets the app keep its own shortcuts — the whole point of not blanket-stopping', () => {
    for (const k of ['k', 'j', 'l', 'n', '[', ']', '/']) {
      expect(claimedByHostEditor(key(k, true))).toBe(false);
    }
  });

  it('reads ctrl the same as meta, for the Windows/Linux build', () => {
    expect(claimedByHostEditor({ key: 'k', metaKey: false, ctrlKey: true })).toBe(false);
    expect(claimedByHostEditor({ key: 'z', metaKey: false, ctrlKey: true })).toBe(true);
  });
});
