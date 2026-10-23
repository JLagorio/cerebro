// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type RefObject,
} from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton, type IconButtonProps } from '@/components/ui/IconButton';
import { useMergedRefs } from './mergeRefs';
import './conversation.css';

/**
 * The field the person writes to the agent in (M91.8, shadcn's Prompt Input
 * on its Input Group): an attachments row, the text, the tools and the send
 * button that turns into Stop while a turn runs.
 *
 * Enter sends and Shift+Enter starts a new line, from the textarea's own
 * key handler (no window or document listener, CV-47); a field whose text
 * runs to paragraphs, a comment's, sends on ⌘/Ctrl+Enter instead and keeps
 * Enter for the new line (`submitOn`). An Enter that ends an IME composition
 * is the composition's: it never sends. And it is not a
 * `<form>`: a form here would catch the submit of a form portalled out of a
 * control inside it (the model picker's), so sending is a call, never a
 * submit event.
 */

/** Where the turn is: idle, asked, answering, or being stopped. */
export type PromptInputStatus = 'ready' | 'submitted' | 'streaming' | 'stopping';

interface PromptInputState {
  /** Send: what Enter and the send button both ask for. */
  submit: () => void;
  disabled: boolean;
  textarea: RefObject<HTMLTextAreaElement | null>;
}

const PromptInputContext = createContext<PromptInputState | null>(null);

function usePromptInput(part: string): PromptInputState {
  const state = useContext(PromptInputContext);
  if (state === null) throw new Error(`${part} must sit inside a PromptInput`);
  return state;
}

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

/** What a click may land on and keep: a press on anything else in the pill
 *  puts the caret in the field, as an Input Group's addons do. */
const OWN_CLICKS = 'button, a, input, textarea, select, label, [role="button"], [contenteditable]';

export type PromptInputProps = Omit<ComponentProps<'div'>, 'onSubmit'> & {
  /** Send what is written. Enter asks for it as the send button does; an
   *  empty draft is the caller's to refuse. */
  onSubmit: () => void;
  /** Nothing can be written or sent. */
  disabled?: boolean;
};

export function PromptInput({
  onSubmit,
  disabled = false,
  onClick,
  className,
  children,
  ...props
}: PromptInputProps) {
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const state: PromptInputState = { submit: onSubmit, disabled, textarea };
  return (
    <PromptInputContext value={state}>
      <div
        data-slot="prompt-input"
        {...props}
        data-disabled={disabled ? '' : undefined}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || disabled) return;
          const target = event.target;
          // A click in a surface portalled out of a control here (the model
          // picker's panel) reaches this handler through React, not through
          // the pill: it keeps its focus.
          if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
          if (target.closest(OWN_CLICKS) !== null) return;
          textarea.current?.focus();
        }}
        className={classes('cb-ai-prompt-input', className)}
      >
        {children}
      </div>
    </PromptInputContext>
  );
}

/** The row above the text, across the whole field: attachments. */
export function PromptInputHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="prompt-input-header"
      {...props}
      className={classes('cb-ai-prompt-input-header', className)}
    />
  );
}

/** The text's place in the row: it takes what the tools leave. */
export function PromptInputBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="prompt-input-body"
      {...props}
      className={classes('cb-ai-prompt-input-body', className)}
    />
  );
}

export type PromptInputTextareaProps = ComponentProps<'textarea'> & {
  /** The Enter that sends: a bare one (Shift+Enter is the new line), or only
   *  ⌘/Ctrl+Enter, leaving a bare Enter the new line. */
  submitOn?: 'enter' | 'mod+enter';
};

/**
 * The text. It grows with what is written, up to its stylesheet's height,
 * and scrolls after. A caller's `onKeyDown` runs first, and an Enter it
 * prevents is not a send — a completion menu that picks its row on Enter
 * keeps it.
 */
export function PromptInputTextarea({
  submitOn = 'enter',
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onInput,
  rows = 1,
  disabled,
  placeholder = 'Ask anything…',
  className,
  ref,
  'aria-label': label = 'Message',
  ...props
}: PromptInputTextareaProps) {
  const state = usePromptInput('PromptInputTextarea');
  const composing = useRef(false);
  const attach = useMergedRefs(state.textarea, ref);
  const { value } = props;

  useLayoutEffect(() => {
    grow(state.textarea.current);
  }, [state.textarea, value]);

  return (
    <textarea
      data-slot="prompt-input-textarea"
      {...props}
      ref={attach}
      rows={rows}
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled ?? state.disabled}
      onInput={(event) => {
        onInput?.(event);
        grow(event.currentTarget);
      }}
      onCompositionStart={(event) => {
        composing.current = true;
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        onCompositionEnd?.(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey) return;
        if (submitOn === 'mod+enter' && !event.metaKey && !event.ctrlKey) return;
        // The Enter that commits an IME composition: `isComposing`, or the
        // 229 WebKit sends after compositionend has already fired.
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (!state.disabled && disabled !== true) state.submit();
      }}
      className={classes('cb-ai-prompt-input-textarea', className)}
    />
  );
}

/** Fits the field to its text; the stylesheet's max-height caps it. */
function grow(field: HTMLTextAreaElement | null) {
  if (field === null) return;
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}

/** The row of tools and the send button, after the text, or under it when
 *  they do not fit beside it. */
export function PromptInputFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="prompt-input-footer"
      {...props}
      className={classes('cb-ai-prompt-input-footer', className)}
    />
  );
}

/** A group of tools in the footer: attach, the model picker, context. */
export function PromptInputTools({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="prompt-input-tools"
      {...props}
      className={classes('cb-ai-prompt-input-tools', className)}
    />
  );
}

/** A tool: an icon button whose name is its tooltip. */
export function PromptInputButton({ size = 'md', className, ...props }: IconButtonProps) {
  return (
    <IconButton
      size={size}
      {...props}
      className={classes('cb-ai-prompt-input-button', className)}
    />
  );
}

/** The send button's name in each status. */
export const PROMPT_INPUT_WORDS = {
  send: 'Send',
  stop: 'Stop',
  stopping: 'Stopping…',
} as const;

export type PromptInputSubmitProps = Omit<ComponentProps<'button'>, 'type'> & {
  status?: PromptInputStatus;
  /** Stops the turn. Without it, a running turn's button still sends: the
   *  caller queues what is sent. */
  onStop?: () => void;
};

/**
 * Send, or Stop while a turn runs and the caller can stop it, or Stopping…
 * once asked. Its name is the word, so a screen reader hears which.
 */
export function PromptInputSubmit({
  status = 'ready',
  onStop,
  onClick,
  disabled,
  children,
  className,
  ...props
}: PromptInputSubmitProps) {
  const state = usePromptInput('PromptInputSubmit');
  const stopping = status === 'stopping';
  const stops = stopping || ((status === 'submitted' || status === 'streaming') && !!onStop);
  const label = stopping
    ? PROMPT_INPUT_WORDS.stopping
    : stops
      ? PROMPT_INPUT_WORDS.stop
      : PROMPT_INPUT_WORDS.send;
  return (
    <button
      type="button"
      data-slot="prompt-input-submit"
      aria-label={label}
      {...props}
      data-status={status}
      disabled={disabled ?? (stopping || (!stops && state.disabled))}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (stops) {
          if (!stopping) onStop?.();
          return;
        }
        state.submit();
      }}
      className={classes('cb-ai-prompt-input-submit', className)}
    >
      {children ?? <Icon name={stops ? 'square' : 'arrow-up'} size={16} />}
    </button>
  );
}
