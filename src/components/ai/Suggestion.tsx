// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { useId, type ComponentProps } from 'react';
import { Icon } from '@/components/ui/Icon';
import './conversation.css';

/**
 * A prompt sent in one press (M91.8, shadcn's Suggestion). shadcn draws a
 * scrolling row of outlined pills; Cerebro's starters are borderless rows,
 * one under another, each with an arrow — a deliberate deviation the
 * assistant's e2e pins (border 0). A suggestion's name is its label; a
 * description, when there is one, is read as its description.
 */

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

/** The suggestions, as a named group: name it with `aria-label`. */
export function Suggestions({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="suggestions"
      role="group"
      {...props}
      className={classes('cb-ai-suggestions', className)}
    />
  );
}

export type SuggestionProps = Omit<ComponentProps<'button'>, 'onClick' | 'type'> & {
  /** The prompt, which is also the label unless children replace it. */
  suggestion: string;
  /** A quieter line under the label. */
  description?: string;
  /** Hears the suggestion when it is pressed. */
  onClick?: (suggestion: string) => void;
  /** The trailing lucide icon; null for none. */
  icon?: string | null;
};

export function Suggestion({
  suggestion,
  description,
  onClick,
  icon = 'arrow-up-right',
  children,
  className,
  ...props
}: SuggestionProps) {
  const id = useId();
  const described = description !== undefined && description !== '';
  return (
    <button
      type="button"
      data-slot="suggestion"
      aria-labelledby={described ? `${id}-label` : undefined}
      aria-describedby={described ? `${id}-description` : undefined}
      {...props}
      onClick={() => onClick?.(suggestion)}
      className={classes('cb-ai-suggestion', className)}
    >
      <span className="cb-ai-suggestion-text">
        <span id={`${id}-label`} className="cb-ai-suggestion-label">
          {children ?? suggestion}
        </span>
        {described && (
          <span id={`${id}-description`} className="cb-ai-suggestion-description">
            {description}
          </span>
        )}
      </span>
      {icon !== null && <Icon name={icon} size={14} />}
    </button>
  );
}
