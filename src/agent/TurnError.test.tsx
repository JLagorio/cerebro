// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnError } from '@/agent/TurnError';

afterEach(cleanup);

const CATALOGUE = Array.from({ length: 400 }, (_, i) => `mcp__cerebro__tool_${i}`).join(', ');
const NOT_FOUND = `<tool_use_error>Error calling tool (mcp__cerebro__get_note): Error: MCP tool not found. Available MCP tools: ${CATALOGUE}</tool_use_error>`;

const summary = () => screen.getByTestId('turn-error-summary');

describe('a failed turn Rust could not type', () => {
  it('shows a short failure in its own words, with inspection and nothing to unfold', () => {
    const onReviewRecovery = vi.fn();
    render(
      <TurnError
        error="API Error: 400 the request was not one Claude could take"
        onReviewRecovery={onReviewRecovery}
      />,
    );
    expect(summary().textContent).toBe('API Error: 400 the request was not one Claude could take');
    expect(screen.queryByTestId('turn-error-full')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review what happened' }));
    expect(onReviewRecovery).toHaveBeenCalledOnce();
  });

  it('draws no inspection action without its handler', () => {
    render(<TurnError error="Stopped." />);
    expect(screen.queryByRole('button', { name: 'Review what happened' })).toBeNull();
  });

  it('summarises a long failure in three clamped lines, and keeps all of it a click away', () => {
    render(<TurnError error={NOT_FOUND} onReviewRecovery={() => undefined} />);
    const box = screen.getByTestId('turn-error');
    // The tags are not the error; the words are.
    expect(box.textContent).not.toContain('tool_use_error');
    expect(summary().textContent!.startsWith('Error calling tool (mcp__cerebro__get_note)')).toBe(
      true,
    );
    expect(summary().textContent!.endsWith('…')).toBe(true);
    expect(summary().textContent).not.toContain('mcp__cerebro__tool_399');
    // Three lines on screen however wide the panel is.
    expect(summary().className).toContain('line-clamp-3');

    const fold = screen.getByTestId('turn-error-full');
    expect(fold.tagName).toBe('DETAILS');
    expect(fold.hasAttribute('open')).toBe(false);
    expect(fold.querySelector('summary')?.textContent).toBe('Show the full error');
    const whole = fold.querySelector('pre')!;
    expect(whole.textContent!.startsWith('Error calling tool')).toBe(true);
    expect(whole.textContent!.endsWith('mcp__cerebro__tool_399')).toBe(true);
    // Unfolded, it scrolls in its own box rather than filling the thread.
    expect(whole.className).toContain('max-h-[200px]');
    expect(whole.className).toContain('overflow-auto');
    expect(screen.getByRole('button', { name: 'Review what happened' })).toBeTruthy();
  });

  it('shows the stack a failure printed as a Stack Trace, a frame in the vault opening its page', () => {
    const onOpenPath = vi.fn();
    const error = [
      'TypeError: owner is not defined',
      '    at render (notes/plan.md:6:9)',
      '    at main (/Users/someone/vault/render.mjs:34:3)',
    ].join('\n');
    render(<TurnError error={error} onOpenPath={onOpenPath} />);
    expect(summary().textContent).toContain('TypeError: owner is not defined');
    const trace = screen.getByTestId('turn-error').querySelector('[data-slot="stack-trace"]')!;
    fireEvent.click(trace.querySelector('button')!);
    fireEvent.click(screen.getByRole('button', { name: /notes\/plan\.md:6/ }));
    expect(onOpenPath).toHaveBeenCalledWith('notes/plan.md');
    // An absolute path is text, never a way out (CV-16).
    expect(screen.queryByRole('button', { name: /render\.mjs/ })).toBeNull();
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('draws no stack trace for words that print none', () => {
    render(<TurnError error="API Error: 400 the request was not one Claude could take" />);
    expect(screen.getByTestId('turn-error').querySelector('[data-slot="stack-trace"]')).toBeNull();
  });

  it('offers the whole of a short failure that wraps past the clamp', () => {
    // Under errorText's caps, so nothing is cut, but in a narrow panel its
    // words run past three lines and the clamp hides the reason at the end.
    const error =
      "Could not read night-owl's instructions at library/agents/night-owl.md, so the turn was not sent: the file changed on disk while it was being read and no longer parses.";
    const tall = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(68);
    const box = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(51);
    try {
      render(<TurnError error={error} />);
      expect(summary().textContent).toBe(error);
      const fold = screen.getByTestId('turn-error-full');
      expect(fold.querySelector('pre')?.textContent).toBe(error);
    } finally {
      tall.mockRestore();
      box.mockRestore();
    }
  });
});
