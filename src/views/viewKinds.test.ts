import { describe, expect, it } from 'vitest';
import { VIEW_TYPES } from '@/engine/types';
import {
  VIEW_KINDS,
  VIEW_SEGMENTS,
  axesFor,
  hasDependencies,
  isZoomable,
  needsDate,
  showsChips,
  viewKind,
} from '@/views/viewKinds';
import { parseListYaml } from '@/engine/views';

/**
 * The registration contract for a view kind (M16.3).
 *
 * Adding one used to be four silent traps: the ViewCanvas switch had no
 * default and no return type, LAYOUTS was a hand-written set whose omission
 * downgraded saved files to `list`, and two plain Set<string> in the settings
 * panel decided which config pages a kind got. Three of those are now
 * compile-time errors; this file pins the parts a compiler cannot see.
 */
describe('view kind registration', () => {
  it('describes every declared type exactly once', () => {
    expect(VIEW_KINDS.map((k) => k.value)).toEqual([...VIEW_TYPES]);
  });

  it('gives each kind a distinct icon, so pickers can tell them apart', () => {
    // Gantt and Timeline both shipped as `chart-gantt`, which made them
    // indistinguishable everywhere they were offered side by side.
    const icons = VIEW_KINDS.map((k) => k.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('gives each kind a distinct label and test id', () => {
    expect(new Set(VIEW_KINDS.map((k) => k.label)).size).toBe(VIEW_KINDS.length);
    expect(new Set(VIEW_SEGMENTS.map((s) => s.testId)).size).toBe(VIEW_KINDS.length);
  });

  // The trap this replaced: a kind missing from LAYOUTS parsed as `list`, so
  // opening a saved view silently changed its layout and the next write
  // persisted the downgrade.
  it('round-trips every declared kind through the parser', () => {
    for (const type of VIEW_TYPES) {
      const list = parseListYaml(
        't',
        `name: T\nviews:\n  - id: v\n    name: V\n    presentation:\n      type: ${type}\n`,
      );
      expect(list.definition.views[0]?.presentation.type).toBe(type);
    }
  });

  it('reads capabilities off the kind rather than comparing strings', () => {
    for (const kind of VIEW_KINDS) {
      expect(needsDate(kind.value)).toBe(kind.dated === true);
      expect(isZoomable(kind.value)).toBe(kind.zoomable === true);
      expect(hasDependencies(kind.value)).toBe(kind.dependencies === true);
      expect(showsChips(kind.value)).toBe(kind.chips === true);
      expect(axesFor(kind.value).group).toBe(kind.groupable === true);
    }
  });

  it('only lets a dated kind zoom or draw dependencies', () => {
    for (const kind of VIEW_KINDS) {
      if (kind.zoomable === true || kind.dependencies === true) {
        expect(kind.dated).toBe(true);
      }
    }
  });

  it('falls back to the first kind for an unknown type', () => {
    expect(viewKind('nope' as never)).toBe(VIEW_KINDS[0]);
  });
});
