import { afterEach, describe, expect, it, vi } from 'vitest';
import { installOpenIntent, openBesideIntent, withOpenBesideIntent } from './openIntent';
afterEach(() => vi.useRealTimers());
describe('open beside intent', () => {
  it('captures only modified primary clicks and clears even when propagation stops', () => {
    vi.useFakeTimers();
    const dispose = installOpenIntent();
    const button = document.createElement('button');
    document.body.append(button);
    button.addEventListener('click', (event) => event.stopPropagation());
    try {
      for (const init of [{ metaKey: true }, { ctrlKey: true }]) {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
        expect(openBesideIntent()).toBe(true);
        vi.runOnlyPendingTimers();
        expect(openBesideIntent()).toBe(false);
      }
      for (const init of [{}, { button: 1, metaKey: true }, { button: 2, ctrlKey: true }]) {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
        expect(openBesideIntent()).toBe(false);
      }
    } finally {
      button.remove();
      dispose();
    }
  });
  it('scopes keyboard intent to the synchronous open, including failures', () => {
    expect(() =>
      withOpenBesideIntent(true, () => {
        expect(openBesideIntent()).toBe(true);
        throw new Error('refused');
      }),
    ).toThrow('refused');
    expect(openBesideIntent()).toBe(false);
  });
  it('keeps capture installed until the last owner leaves', () => {
    const first = installOpenIntent();
    const second = installOpenIntent();
    first();
    document.dispatchEvent(new MouseEvent('click', { metaKey: true }));
    expect(openBesideIntent()).toBe(true);
    second();
    expect(openBesideIntent()).toBe(false);
    document.dispatchEvent(new MouseEvent('click', { metaKey: true }));
    expect(openBesideIntent()).toBe(false);
  });
});
