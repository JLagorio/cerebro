// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusRevealed, revealStep, useStepRevealStore } from '@/agent/stepReveal';

/**
 * The reveal (M92.4): a rail row asks for its call's line, and the line
 * takes the latest ask once. Where it lands takes focus, a line that is no
 * control of its own only for as long as it holds it. The line's own side,
 * opening, the settling jump and focus, is drawn in toolRenderers.test.tsx.
 */

afterEach(() => {
  useStepRevealStore.setState({ asked: null });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const asked = () => useStepRevealStore.getState().asked;

describe('the reveal store', () => {
  it('holds the latest ask, and a line spends only its own', () => {
    revealStep('agent-1');
    const first = asked();
    revealStep('agent-2');
    const second = asked();
    expect(second?.toolId).toBe('agent-2');
    // The line the first ask named comes too late: the newer ask stands.
    useStepRevealStore.getState().taken(first?.ask ?? -1);
    expect(asked()).toBe(second);
    useStepRevealStore.getState().taken(second?.ask ?? -1);
    expect(asked()).toBeNull();
  });

  it('asks again for a call already shown, as a new ask', () => {
    revealStep('agent-1');
    const first = asked();
    revealStep('agent-1');
    expect(asked()?.toolId).toBe('agent-1');
    expect(asked()?.ask).not.toBe(first?.ask);
  });
});

describe('focusRevealed', () => {
  it('focuses a control as it is, scrolling only where nothing placed it', () => {
    const button = document.body.appendChild(document.createElement('button'));
    const focus = vi.spyOn(button, 'focus');
    focusRevealed(button);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(button);
    expect(button.hasAttribute('tabindex')).toBe(false);
    focusRevealed(button, false);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: false });
  });

  it('lends a line with no control a tab index only while it holds focus', () => {
    const line = document.body.appendChild(document.createElement('div'));
    focusRevealed(line);
    expect(document.activeElement).toBe(line);
    expect(line.getAttribute('tabindex')).toBe('-1');
    line.blur();
    expect(line.hasAttribute('tabindex')).toBe(false);
  });

  it('leaves a tab index the element holds of its own', () => {
    const own = document.body.appendChild(document.createElement('div'));
    own.tabIndex = 0;
    focusRevealed(own);
    own.blur();
    expect(own.getAttribute('tabindex')).toBe('0');
  });
});
