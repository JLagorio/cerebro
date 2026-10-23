// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Reasoning, reasoningTitle } from './Reasoning';

/**
 * Reasoning (M91.9): "Thinking" while it streams, then "Thought", with how
 * long only when it was measured (CV-05). Withheld thinking says so.
 */

afterEach(cleanup);

const TEXT = 'The deploy log has three phases.\n\nImage optimization reruns every time.';

const title = () => document.querySelector('[data-slot="trace-title"]') as HTMLElement;

describe('Reasoning', () => {
  it('thinks open and lit while it streams, and says so', () => {
    render(<Reasoning text={TEXT} isStreaming />);
    const trigger = screen.getByRole('button', { name: 'Thinking' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(title().classList.contains('cb-ai-shimmer')).toBe(true);
    expect(document.querySelector('[data-slot="trace-line"]')?.getAttribute('data-status')).toBe(
      'running',
    );
    expect(document.querySelector('.cb-ai-reasoning-text')?.textContent).toBe(TEXT);
  });

  it('closes when it ends, unless the reader chose', () => {
    const { rerender } = render(<Reasoning text={TEXT} isStreaming />);
    rerender(<Reasoning text={TEXT} durationMs={12_000} />);
    const trigger = screen.getByRole('button', { name: 'Thought for 12s' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(title().classList.contains('cb-ai-shimmer')).toBe(false);
    fireEvent.click(trigger);
    rerender(<Reasoning text={`${TEXT} More.`} durationMs={12_000} />);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the reader’s choice while it streams', () => {
    const { rerender } = render(<Reasoning text={TEXT} isStreaming />);
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }));
    rerender(<Reasoning text={`${TEXT} More.`} isStreaming />);
    expect(screen.getByRole('button', { name: 'Thinking' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('says how long only when it was measured (CV-05)', () => {
    expect(reasoningTitle({})).toBe('Thought');
    expect(reasoningTitle({ durationMs: 400 })).toBe('Thought for under a second');
    expect(reasoningTitle({ durationMs: 1390 })).toBe('Thought for 1.4s');
    expect(reasoningTitle({ durationMs: 75_000 })).toBe('Thought for 1m 15s');
    expect(reasoningTitle({ durationMs: 0 })).not.toMatch(/\b0/);
    render(<Reasoning text={TEXT} />);
    expect(screen.getByRole('button', { name: 'Thought' })).toBeTruthy();
  });

  it('has nothing to open with no text, and draws no line once it is done', () => {
    const { rerender, container } = render(<Reasoning text="" isStreaming />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(title().textContent).toBe('Thinking');
    rerender(<Reasoning text={'  \n'} durationMs={12_000} />);
    expect(container.firstChild).toBeNull();
  });

  it('opens once its first words arrive', () => {
    const { rerender } = render(<Reasoning text="" isStreaming />);
    rerender(<Reasoning text="The deploy" isStreaming />);
    expect(screen.getByRole('button', { name: 'Thinking' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('says thinking Claude Code withheld, with nothing to open', () => {
    render(<Reasoning text="" redacted isStreaming data-testid="reasoning" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(title().textContent).toBe('Reasoning hidden by Claude Code');
    expect(title().classList.contains('cb-ai-shimmer')).toBe(false);
    expect(screen.getByTestId('reasoning').hasAttribute('data-redacted')).toBe(true);
  });

  it('draws its text as text: no link, to the web or the vault (CV-16)', () => {
    render(<Reasoning text="See https://example.com and [[notes/a]]." defaultOpen />);
    expect(document.querySelector('.cb-ai-reasoning-text')?.textContent).toBe(
      'See https://example.com and [[notes/a]].',
    );
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('hears a controlling caller', () => {
    const onOpenChange = vi.fn();
    render(<Reasoning text={TEXT} open={false} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thought' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(document.querySelector('.cb-ai-reasoning-text')).toBeNull();
  });
});
