import { afterEach, describe, expect, it } from 'vitest';
import {
  hasLayers,
  hasModalLayers,
  isTopLayer,
  ownsEscape,
  popLayer,
  pushLayer,
  resetLayers,
} from './layers';

afterEach(resetLayers);

describe('modal layers (M65.1)', () => {
  it('a surface is modal by default', () => {
    pushLayer('dialog');
    expect(hasLayers()).toBe(true);
    expect(hasModalLayers()).toBe(true);
  });

  it('a modal:false surface counts for hasLayers and isTopLayer, not hasModalLayers', () => {
    pushLayer('peek', { modal: false });
    expect(hasLayers()).toBe(true);
    expect(isTopLayer('peek')).toBe(true);
    expect(ownsEscape('peek')).toBe(true);
    expect(hasModalLayers()).toBe(false);
  });

  it('a modal surface over the peek is modal again, and closing it is not', () => {
    pushLayer('peek', { modal: false });
    pushLayer('menu');
    expect(hasModalLayers()).toBe(true);
    popLayer('menu');
    expect(hasModalLayers()).toBe(false);
  });

  it('a tooltip or a gesture is never modal', () => {
    pushLayer('tip', { kind: 'tooltip' });
    pushLayer('drag', { kind: 'gesture' });
    expect(hasModalLayers()).toBe(false);
  });
});
