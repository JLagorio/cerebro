import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ steps: [] as string[] }));
vi.mock('@/editor/openPages', () => ({
  prepareOpenPages: () => calls.steps.push('prepare'),
  flushOpenPages: async () => {
    calls.steps.push('flush');
    return { unresolvedOwnerIds: [], outcomes: [] };
  },
}));
vi.mock('./quit', () => ({
  useQuitHost: () => {
    calls.steps.push('quit host');
  },
}));

const { Contained, RootBoundary } = await import('./Contained');

function Thrower(): never {
  throw new Error('render fault');
}

beforeEach(() => {
  calls.steps = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Contained (M93.12)', () => {
  it('saves the open pages when its section faults: prepare, then flush', () => {
    render(
      <Contained label="This page">
        <Thrower />
      </Contained>,
    );
    expect(screen.getByTestId('section-unavailable')).toBeTruthy();
    expect(calls.steps).toEqual(['prepare', 'flush']);
  });

  it('keeps answering quit while the whole window is down, and only then', () => {
    const { unmount } = render(
      <RootBoundary>
        <p>App</p>
      </RootBoundary>,
    );
    expect(calls.steps).toEqual([]);
    unmount();
    render(
      <RootBoundary>
        <Thrower />
      </RootBoundary>,
    );
    expect(screen.getByTestId('section-unavailable').textContent).toContain(
      'Cerebro stopped drawing',
    );
    expect(calls.steps).toEqual(expect.arrayContaining(['prepare', 'flush', 'quit host']));
    expect(calls.steps.indexOf('prepare')).toBeLessThan(calls.steps.indexOf('flush'));
  });
});
