// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import type { ComponentProps } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/IconButton';
import { CodeBlockCopyButton } from './CodeBlock';
import './conversation.css';

/**
 * One turn (M91.8, shadcn's Message with its Bubble): the person's message
 * at the end in a filled bubble, the agent's reply at the start as prose,
 * an optional avatar beside either, and the turn's actions under it.
 *
 * The actions are Copy, Retry, Edit and Branch, each drawn only when the
 * caller gives it something to do. shadcn's Good and Bad response toggles
 * are left out on purpose: there is nowhere to record them.
 */

export type MessageFrom = 'user' | 'assistant';
export type MessageAlign = 'start' | 'end';

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

/** Consecutive messages from one speaker. */
export function MessageGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-group"
      {...props}
      className={classes('cb-ai-message-group', className)}
    />
  );
}

export type MessageProps = ComponentProps<'div'> & {
  /** Who spoke: the person's message sits at the end. */
  from?: MessageFrom;
  /** Where it sits, when that is not where `from` puts it. */
  align?: MessageAlign;
};

export function Message({ from = 'assistant', align, className, ...props }: MessageProps) {
  return (
    <div
      data-slot="message"
      {...props}
      data-role={from}
      data-align={align ?? (from === 'user' ? 'end' : 'start')}
      className={classes('cb-ai-message', className)}
    />
  );
}

export type MessageAvatarProps = ComponentProps<'div'> & {
  /** Whose initials to draw, when the avatar holds no icon of its own. */
  name?: string;
  /** A vault or data image (the DS Avatar draws nothing else, CV-61). */
  src?: string;
};

/** A round mark beside the message: the speaker's initials, or the
 *  caller's own icon. Decoration: the message names its speaker. */
export function MessageAvatar({ name, src, children, className, ...props }: MessageAvatarProps) {
  return (
    <div
      data-slot="message-avatar"
      aria-hidden="true"
      {...props}
      className={classes('cb-ai-message-avatar', className)}
    >
      {children ?? (name !== undefined && <Avatar name={name} src={src} size={28} />)}
    </div>
  );
}

/** The body: the bubble or the reply, then the footer. */
export function MessageContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-content"
      {...props}
      className={classes('cb-ai-message-content', className)}
    />
  );
}

/** A line above the body: who, when. */
export function MessageHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-header"
      {...props}
      className={classes('cb-ai-message-header', className)}
    />
  );
}

/** A line under the body, which follows the message to its side: the
 *  actions, a model, a time. */
export function MessageFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-footer"
      {...props}
      className={classes('cb-ai-message-footer', className)}
    />
  );
}

/** `default` is the person's filled bubble (the action ink); `muted` a quiet
 *  fill; `ghost` none, for prose. */
export type BubbleVariant = 'default' | 'muted' | 'ghost';

export type BubbleProps = ComponentProps<'div'> & {
  variant?: BubbleVariant;
  align?: MessageAlign;
};

/** A message's text in a bubble. Its text keeps its line breaks. */
export function Bubble({ variant = 'default', align, className, ...props }: BubbleProps) {
  return (
    <div
      data-slot="bubble"
      {...props}
      data-variant={variant}
      data-align={align}
      className={classes('cb-ai-bubble', className)}
    />
  );
}

export function BubbleContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="bubble-content"
      {...props}
      className={classes('cb-ai-bubble-content', className)}
    />
  );
}

/** The actions on a turn, named as a group. */
export function MessageActions({
  className,
  'aria-label': label = 'Message actions',
  ...props
}: ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-actions"
      role="group"
      aria-label={label}
      {...props}
      className={classes('cb-ai-message-actions', className)}
    />
  );
}

export interface MessageActionProps {
  /** lucide icon name. */
  icon: string;
  /** Its name and its tooltip. */
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

/** One action: an icon button with its name as its tooltip. */
export function MessageAction({ icon, label, onClick, disabled, className }: MessageActionProps) {
  return (
    <IconButton
      icon={icon}
      label={label}
      size="sm"
      disabled={disabled}
      onClick={onClick}
      className={classes('cb-ai-message-action', className)}
    />
  );
}

/** What Copy, Retry, Edit and Branch are called, unless the caller names
 *  them better. */
export const MESSAGE_ACTION_WORDS = {
  copy: 'Copy',
  retry: 'Retry',
  edit: 'Edit',
  branch: 'Branch from here',
} as const;

export type MessageToolbarProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The text Copy writes to the clipboard; no Copy without it. */
  copy?: string;
  /** Runs the turn again. */
  onRetry?: () => void;
  /** Puts the person's text back in the field. */
  onEdit?: () => void;
  /** Save the selected completed answer through the caller's human writer. */
  onSave?: () => void;
  /** Starts a new conversation from this turn. */
  onBranch?: () => void;
  /** Branch's name, when "Branch from here" needs its turn: "Branch the
   *  conversation from …". */
  branchLabel?: string;
  disabled?: boolean;
};

/**
 * The turn's actions in their order: Copy, Retry, Edit, Branch. Each is
 * drawn only when it has something to do. Copy says how it went, to the eye
 * and to a screen reader, as the code block's copy button does.
 */
export function MessageToolbar({
  copy,
  onRetry,
  onEdit,
  onSave,
  onBranch,
  branchLabel = MESSAGE_ACTION_WORDS.branch,
  disabled,
  ...props
}: MessageToolbarProps) {
  if (
    copy === undefined &&
    onRetry === undefined &&
    onEdit === undefined &&
    onSave === undefined &&
    onBranch === undefined
  ) {
    return null;
  }
  return (
    <MessageActions {...props}>
      {copy !== undefined && (
        <CodeBlockCopyButton value={copy} label={MESSAGE_ACTION_WORDS.copy} disabled={disabled} />
      )}
      {onRetry !== undefined && (
        <MessageAction
          icon="rotate-ccw"
          label={MESSAGE_ACTION_WORDS.retry}
          onClick={onRetry}
          disabled={disabled}
        />
      )}
      {onEdit !== undefined && (
        <MessageAction
          icon="pencil"
          label={MESSAGE_ACTION_WORDS.edit}
          onClick={onEdit}
          disabled={disabled}
        />
      )}
      {onSave !== undefined && (
        <MessageAction icon="file-plus" label="Save answer" onClick={onSave} disabled={disabled} />
      )}
      {onBranch !== undefined && (
        <MessageAction
          icon="git-branch"
          label={branchLabel}
          onClick={onBranch}
          disabled={disabled}
        />
      )}
    </MessageActions>
  );
}
