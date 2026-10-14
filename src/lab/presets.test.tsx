import { cleanup, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { armedFaults, resetFaults } from '@/lib/mockFaults';
import { LAB_NOW } from './clock';
import {
  applyPreset,
  collectSections,
  LAB_STATES,
  labSections,
  labUrl,
  parseLabUrl,
  presetIndex,
  unmetExpectations,
  type LabSection,
  type LabState,
} from './presets';

/**
 * Every preset renders the state it names (M64.1). This is the vitest half of
 * the loop; `e2e/state-lab.spec.ts` replays the same presets in a browser.
 */

beforeAll(() => {
  vi.setSystemTime(LAB_NOW);
});
afterAll(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  resetFaults();
});

const sections = labSections();
const all = sections.flatMap((section) => LAB_STATES.map((state) => ({ section, state })));

/** Apply, mount, and wait until the stage either meets the preset or settles. */
async function mounted(section: LabSection, state: LabState): Promise<HTMLElement> {
  await applyPreset(section, state);
  const { container } = render(<div data-testid="stage">{section.render()}</div>);
  const expectations = section.states[state].expect;
  await waitFor(() => expect(unmetExpectations(container, expectations)).toEqual([]));
  return container;
}

describe('the sections', () => {
  it('are registered, sorted by id, each with the five states in order', () => {
    expect(sections.map((s) => s.id)).toEqual(
      expect.arrayContaining(['agent-spend', 'fleet-runs']),
    );
    expect(sections.map((s) => s.id)).toEqual([...sections.map((s) => s.id)].sort());
    for (const section of sections) {
      expect(Object.keys(section.states)).toEqual([...LAB_STATES]);
    }
  });

  it('refuse a section that lacks a state, naming it', () => {
    const ready = { note: '', expect: { present: [] } };
    const partial = { id: 'half', title: 'Half', surface: 'x', render: () => null };
    expect(() =>
      collectSections({
        './sections/half.tsx': {
          section: { ...partial, states: { ready } as unknown as LabSection['states'] },
        },
      }),
    ).toThrow(
      'state lab: section half has no preset for empty, not-recorded, partial, unavailable',
    );
  });

  it('refuse a module with no section and two sections with one id', () => {
    expect(() => collectSections({ './sections/none.tsx': {} })).toThrow('exports no section');
    const one = sections[0];
    expect(() =>
      collectSections({ './a.tsx': { section: one }, './b.tsx': { sections: [one] } }),
    ).toThrow(`two sections share the id ${one.id}`);
  });
});

describe('every preset renders the state it names', () => {
  it.each(all.map(({ section, state }) => [section.id, state, section] as const))(
    '%s · %s',
    async (_id, state, section) => {
      await mounted(section, state);
    },
  );

  it('fails each unavailable preset into section-unavailable, never an empty state', async () => {
    for (const section of sections) {
      const preset = section.states.unavailable;
      expect(preset.failNext?.length ?? 0).toBeGreaterThan(0);
      const stage = await mounted(section, 'unavailable');
      expect(stage.querySelector('[data-testid="section-unavailable"]')).not.toBeNull();
      expect(stage.querySelector('[data-testid$="-empty"]')).toBeNull();
      cleanup();
    }
  });

  it('gives the same results applied in reverse order, so no preset leaks', async () => {
    for (const { section, state } of [...all].reverse()) {
      await mounted(section, state);
      cleanup();
      // A spent burst disarms on the next macrotask; let it before the next apply.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it('arms its failures only after the vault opens, and an aborted apply arms none', async () => {
    const section = sections.find((s) => s.id === 'fleet-runs') as LabSection;
    const controller = new AbortController();
    const pending = applyPreset(section, 'unavailable', controller.signal);
    expect(armedFaults()).toEqual({});
    controller.abort();
    await pending;
    expect(armedFaults()).toEqual({});
    await applyPreset(section, 'unavailable');
    expect(armedFaults()).toEqual({ fleet_runs: 1 });
  });
});

describe('a preset is a URL', () => {
  it('round-trips every section and state', () => {
    for (const { section, state } of all) {
      expect(parseLabUrl(labUrl(section.id, state), sections)).toEqual({
        section,
        state,
        notice: null,
      });
    }
  });

  it('opens on the first ready preset with no query, silently', () => {
    expect(parseLabUrl('', sections)).toEqual({
      section: sections[0],
      state: 'ready',
      notice: null,
    });
  });

  it('falls back with a notice on a name it does not know', () => {
    const unknownSection = parseLabUrl('?section=nope&state=empty', sections);
    expect(unknownSection.section).toBe(sections[0]);
    expect(unknownSection.state).toBe('ready');
    expect(unknownSection.notice).toContain('No section "nope"');
    const unknownState = parseLabUrl(`?section=${sections[1]?.id}&state=sideways`, sections);
    expect(unknownState.section).toBe(sections[0]);
    expect(unknownState.notice).toContain('No state "sideways"');
  });

  it('indexes every section × state for e2e', () => {
    const index = presetIndex(sections);
    expect(index).toHaveLength(sections.length * LAB_STATES.length);
    expect(index[0]).toEqual({
      section: sections[0].id,
      state: 'ready',
      url: `/state-lab.html?section=${sections[0].id}&state=ready`,
      expect: sections[0].states.ready.expect,
    });
  });
});
