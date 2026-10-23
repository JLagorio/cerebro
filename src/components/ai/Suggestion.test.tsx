// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Suggestion, Suggestions } from './Suggestion';

/**
 * Suggestion (M91.8): Cerebro's starters, borderless rows under a named
 * group, each a button named by its label and sending its suggestion.
 */

afterEach(cleanup);

describe('Suggestion', () => {
  it('draws a named group of buttons, each sending its suggestion', () => {
    const ask = vi.fn();
    render(
      <Suggestions aria-label="Conversation starters">
        <Suggestion
          suggestion="What is at risk right now?"
          onClick={ask}
          data-testid="ai-suggestion"
        />
        <Suggestion
          suggestion="Help me clear the Inbox"
          onClick={ask}
          data-testid="ai-suggestion"
        />
      </Suggestions>,
    );
    const group = screen.getByRole('group', { name: 'Conversation starters' });
    const rows = within(group).getAllByTestId('ai-suggestion');
    expect(rows.map((row) => row.textContent)).toEqual([
      'What is at risk right now?',
      'Help me clear the Inbox',
    ]);
    expect(rows[0].className).toBe('cb-ai-suggestion');
    expect(rows[0].getAttribute('type')).toBe('button');
    fireEvent.click(screen.getByRole('button', { name: 'Help me clear the Inbox' }));
    expect(ask).toHaveBeenCalledWith('Help me clear the Inbox');
  });

  it('reads a description as a description, the label alone as the name', () => {
    render(
      <Suggestion
        suggestion="Learn from this page"
        description="Distil what it says into Knowledge"
      />,
    );
    expect(
      screen.getByRole('button', {
        name: 'Learn from this page',
        description: 'Distil what it says into Knowledge',
      }),
    ).toBeTruthy();
  });

  it('sends its suggestion whatever its children say, and draws its arrow unless told not to', () => {
    const ask = vi.fn();
    const { rerender } = render(
      <Suggestion suggestion="Full prompt sent to the agent" onClick={ask}>
        Short label
      </Suggestion>,
    );
    const button = screen.getByRole('button', { name: 'Short label' });
    expect(button.querySelector('[data-icon="arrow-up-right"]')).toBeTruthy();
    fireEvent.click(button);
    expect(ask).toHaveBeenCalledWith('Full prompt sent to the agent');
    rerender(<Suggestion suggestion="Plain" icon={null} disabled />);
    const plain = screen.getByRole('button', { name: 'Plain' }) as HTMLButtonElement;
    expect(plain.querySelector('svg')).toBeNull();
    expect(plain.disabled).toBe(true);
  });
});
