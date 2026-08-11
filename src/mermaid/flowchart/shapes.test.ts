import { describe, expect, it } from 'vitest';
import { resolveIcon } from '@/components/ui/Icon';
import {
  BRACKET_SHAPE_TO_REGISTRY,
  PALETTE_SHAPES,
  REGISTRY_TO_BRACKET,
  SHAPE_ALIASES,
  SHORT_NAME_FOR,
  VALID_SHAPES,
} from './shapes';

describe('shape registry (M29.32)', () => {
  it('every palette shape is a valid registry short name', () => {
    for (const s of PALETTE_SHAPES) expect(VALID_SHAPES.has(s.name), s.name).toBe(true);
  });

  it('every palette icon resolves to a real lucide glyph', () => {
    for (const s of PALETTE_SHAPES) expect(resolveIcon(s.icon).Comp, s.icon).not.toBeNull();
  });

  it('registry names are mermaid-legal: lowercase, no underscores', () => {
    for (const name of VALID_SHAPES) expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('ellipse is excluded on purpose — broken upstream (mermaid#5976)', () => {
    expect(VALID_SHAPES.has('ellipse')).toBe(false);
  });

  it('person is excluded on purpose — 11.16.1-only, and the app bundles 11.16.0', () => {
    expect(VALID_SHAPES.has('person')).toBe(false);
  });

  it('the undocumented-but-working doublecircle alias is accepted', () => {
    expect(VALID_SHAPES.has('doublecircle')).toBe(true);
  });

  it('the classic 8 map to the registry and back', () => {
    for (const [bracket, registry] of Object.entries(BRACKET_SHAPE_TO_REGISTRY)) {
      expect(REGISTRY_TO_BRACKET[registry]).toBe(bracket);
      expect(VALID_SHAPES.has(registry)).toBe(true);
    }
  });

  it('an inherited Object.prototype key is not a shape', () => {
    // REGISTRY_TO_BRACKET is indexed with whatever a caller hands setNodeShape.
    // A plain object literal would answer `toString`/`constructor` from the
    // prototype chain and send that value down the brackets-first path, where
    // it becomes `SHAPE_BRACKETS[<function>]` — undefined, destructured, throw.
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(REGISTRY_TO_BRACKET[key], key).toBeUndefined();
      expect(VALID_SHAPES.has(key), key).toBe(false);
    }
  });

  it('every accepted spelling canonicalizes to a palette short name', () => {
    const shortNames = new Set(PALETTE_SHAPES.map((s) => s.name));
    for (const spelling of VALID_SHAPES) {
      const canonical = SHORT_NAME_FOR[spelling];
      expect(canonical, spelling).toBeDefined();
      expect(shortNames.has(canonical!), `${spelling} -> ${String(canonical)}`).toBe(true);
    }
    // The eight bracket-Shape literals are spellings too, or setNodeShape
    // would refuse `setNodeShape(m, id, 'cylinder')` on a meta-carrying node.
    for (const [bracket, registry] of Object.entries(BRACKET_SHAPE_TO_REGISTRY)) {
      expect(SHORT_NAME_FOR[bracket], bracket).toBe(registry);
    }
    for (const key of ['toString', 'constructor', 'blob', 'person', 'ellipse']) {
      expect(SHORT_NAME_FOR[key], key).toBeUndefined();
    }
  });

  it('the palette covers the ENTIRE registry — all 48 short names, four categories', () => {
    expect(PALETTE_SHAPES).toHaveLength(48);
    expect(new Set(PALETTE_SHAPES.map((s) => s.name))).toEqual(new Set(Object.keys(SHAPE_ALIASES)));
    expect(new Set(PALETTE_SHAPES.map((s) => s.category))).toEqual(
      new Set(['Basic', 'Process', 'Technical', 'Annotation']),
    );
  });
});
