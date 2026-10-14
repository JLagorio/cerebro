import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __seedFleet } from '@/lib/mockIpc';
import { resetFaults } from '@/lib/mockFaults';
import { LAB_NOW, unpin } from './clock';
import { LAB_STATES, labSections, unmetExpectations, type LabState } from './presets';
import { mountStateLab, REFUSAL, StateLab } from './StateLab';

/** The lab page itself (M64.1): listing, links, Reset, the fail box, the gate. */

beforeAll(() => {
  vi.setSystemTime(LAB_NOW);
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  window.history.replaceState(null, '', '/state-lab.html');
});
afterEach(() => {
  cleanup();
  resetFaults();
  unpin();
});

const sections = labSections();

const stage = () => screen.getByTestId('lab-stage');

/** Wait for the stage to hold this preset, applied and showing its state. */
async function showing(sectionId: string, state: LabState) {
  const section = sections.find((s) => s.id === sectionId);
  if (section === undefined) throw new Error(sectionId);
  await waitFor(() => {
    expect(stage().dataset.section).toBe(sectionId);
    expect(stage().dataset.state).toBe(state);
    expect(stage().dataset.ready).toBe('');
    expect(unmetExpectations(stage(), section.states[state].expect)).toEqual([]);
  });
}

function lab() {
  return render(
    <StrictMode>
      <StateLab />
    </StrictMode>,
  );
}

describe('StateLab', () => {
  it('lists every section with its five states, and opens on the first ready preset', async () => {
    lab();
    for (const section of sections) {
      for (const state of LAB_STATES) {
        expect(screen.getByTestId(`lab-state-${section.id}-${state}`)).toBeTruthy();
      }
    }
    await showing(sections[0].id, 'ready');
  });

  it('names the pinned clock in its header', () => {
    lab();
    expect(screen.getByTestId('lab-clock').textContent).toBe(
      'Clock pinned to 28 Jul 2026, 12:00 UTC',
    );
  });

  it('pushes ?section=&state= on a state click and mounts that preset', async () => {
    lab();
    fireEvent.click(screen.getByTestId('lab-state-agent-spend-partial'));
    expect(window.location.search).toBe('?section=agent-spend&state=partial');
    await showing('agent-spend', 'partial');
    expect(stage().textContent).toContain('12,940 tokens · 1 run unmetered');
  });

  it('re-applies the preset the URL names on popstate', async () => {
    lab();
    fireEvent.click(screen.getByTestId('lab-state-fleet-runs-empty'));
    await showing('fleet-runs', 'empty');
    act(() => {
      window.history.pushState(null, '', '?section=fleet-runs&state=not-recorded');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await showing('fleet-runs', 'not-recorded');
  });

  it('opens a preset from the URL, and falls back with a notice on an unknown one', async () => {
    window.history.replaceState(null, '', '/state-lab.html?section=fleet-runs&state=partial');
    const first = lab();
    await showing('fleet-runs', 'partial');
    expect(screen.queryByTestId('lab-fallback')).toBeNull();
    first.unmount();

    window.history.replaceState(null, '', '/state-lab.html?section=gone&state=ready');
    lab();
    await showing(sections[0].id, 'ready');
    expect(screen.getByTestId('lab-fallback').textContent).toContain('No section "gone"');
  });

  it('puts the preset back on Reset', async () => {
    window.history.replaceState(null, '', '/state-lab.html?section=fleet-runs&state=ready');
    lab();
    await showing('fleet-runs', 'ready');
    __seedFleet([]);
    fireEvent.click(screen.getByTestId('lab-remount'));
    await waitFor(() =>
      expect(stage().querySelector('[data-testid="section-empty"]')).not.toBeNull(),
    );
    fireEvent.click(screen.getByTestId('lab-reset'));
    await showing('fleet-runs', 'ready');
  });

  it('fails the next read on Fail next then Remount, and the next Remount reads again', async () => {
    window.history.replaceState(null, '', '/state-lab.html?section=fleet-runs&state=ready');
    lab();
    await showing('fleet-runs', 'ready');
    fireEvent.change(screen.getByTestId('lab-fail-command'), { target: { value: 'fleet_runs' } });
    fireEvent.click(screen.getByTestId('lab-fail-next'));
    expect(screen.getByTestId('lab-armed').textContent).toBe('Armed: fleet_runs');
    fireEvent.click(screen.getByTestId('lab-remount'));
    await waitFor(() =>
      expect(stage().querySelector('[data-testid="section-unavailable"]')).not.toBeNull(),
    );
    await waitFor(() => expect(screen.getByTestId('lab-armed').textContent).toBe('Nothing armed'));
    // The burst disarms on the next macrotask; StrictMode's double effect met it once.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.click(screen.getByTestId('lab-remount'));
    await showing('fleet-runs', 'ready');
  });

  it('copies the preset link, and shows the link when the clipboard refuses', async () => {
    window.history.replaceState(null, '', '/state-lab.html?section=agent-spend&state=empty');
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValueOnce();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    lab();
    fireEvent.click(screen.getByTestId('lab-copy'));
    await waitFor(() => expect(screen.getByTestId('lab-copied').textContent).toBe('Link copied'));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(window.location.search).toBe('?section=agent-spend&state=empty');
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByTestId('lab-copy'));
    await waitFor(() =>
      expect(screen.getByTestId('lab-copied').textContent).toContain('Copy failed'),
    );
  });

  it('offers every command a preset fails in the fail box', () => {
    lab();
    const options = [...document.querySelectorAll('#lab-fail-commands option')].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toEqual(['fleet_actor_summaries', 'fleet_runs']);
  });

  it('toggles this document between light and dark without touching storage', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    lab();
    fireEvent.click(screen.getByTestId('lab-theme'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(screen.getByTestId('lab-theme'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});

describe('mountStateLab', () => {
  type LabWindow = { __cerebroLabPresets?: unknown[] };

  it('refuses outside dev: one line, nothing mounted, no presets, no pinned clock', () => {
    delete (window as LabWindow).__cerebroLabPresets;
    const RealDate = Date;
    const root = document.createElement('div');
    expect(mountStateLab(root, false)).toBeNull();
    expect(root.textContent).toBe(REFUSAL);
    expect(root.children).toHaveLength(0);
    expect((window as LabWindow).__cerebroLabPresets).toBeUndefined();
    expect(Date).toBe(RealDate);
  });

  it('in dev pins the clock, lists every section × state, and mounts the lab', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let mounted: ReturnType<typeof mountStateLab> = null;
    act(() => {
      mounted = mountStateLab(root, true);
    });
    expect(Date.now()).toBe(new Date(LAB_NOW).getTime());
    expect((window as LabWindow).__cerebroLabPresets).toHaveLength(
      sections.length * LAB_STATES.length,
    );
    await waitFor(() =>
      expect(root.querySelector('[data-testid="lab-stage"][data-ready]')).not.toBeNull(),
    );
    act(() => mounted?.unmount());
    root.remove();
  });

  it('refuses a page with no root', () => {
    expect(() => mountStateLab(null, true)).toThrow('no #root');
  });
});
