import { vi } from 'vitest';

// jsdom shims for BlockNote/mantine (M2 Task 9). All are missing-API
// no-ops; none change behavior existing tests rely on.

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
}

if (typeof window !== 'undefined' && typeof window.matchMedia === 'undefined') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

// Node 22 ships an experimental global localStorage that is undefined
// without --localstorage-file and shadows jsdom's implementation (window is
// globalThis in the vitest jsdom env). Back it with a Map so store
// persistence code runs for real in tests.
if (typeof window !== 'undefined' && window.localStorage === undefined) {
  const backing = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key) => backing.get(key) ?? null,
    key: (index) => [...backing.keys()][index] ?? null,
    removeItem: (key) => void backing.delete(key),
    setItem: (key, value) => void backing.set(key, String(value)),
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}

// ProseMirror touches these DOM APIs that jsdom leaves unimplemented.
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
}
if (typeof document !== 'undefined' && !document.elementFromPoint) {
  document.elementFromPoint = () => null;
}
