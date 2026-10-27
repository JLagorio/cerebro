// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPreset, LAB_STATES, unmetExpectations } from './presets';
import { section } from './sections/agentRunHistory';
import { resetFaults } from '@/lib/mockFaults';

afterEach(() => {
  cleanup();
  resetFaults();
});
describe('scoped agent history lab states', () => {
  it.each(LAB_STATES)('%s stays distinct', async (state) => {
    await applyPreset(section, state);
    const { container } = render(<>{section.render()}</>);
    await waitFor(() =>
      expect(unmetExpectations(container, section.states[state].expect)).toEqual([]),
    );
  });
});
