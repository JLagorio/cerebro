// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { kindFor, type FileKind } from '@/engine/fileKinds';
import { lookFor } from '@/workspace/fileIcons';
import './conversation.css';

/**
 * A file the person attached (M91.8, shadcn's Attachment, its parts named as
 * Prompt Input's attachments are): the file's kind or its picture, its name
 * and a line about it, and a button that takes it off.
 *
 * The kind's icon comes from the file-kinds table by its name. An image
 * file in a root shows the thumbnail its caller draws (FileThumb, the
 * derived-image boundary, CV-61), handed in so the element reads no store
 * and calls no IPC (CV-64); anything else shows its icon.
 */

/** One attachment, as the chip draws it. */
export interface AttachmentData {
  /** Stable: the chip's key. */
  id: string;
  /** The file's name as the person reads it. */
  label: string;
  /** Its path in a root, when it is in one: its icon comes from it, and for
   *  an image its preview's `thumbnail`. */
  path?: string;
  /** The root `path` is in ('0' is the vault). Without one, no thumbnail. */
  rootId?: string;
  /** The kind, when the caller knows it better than the name's extension. */
  kind?: FileKind;
  /** A line under the name: its kind and size, or why it failed. */
  description?: string;
}

/** Where the file is on its way in: shadcn's states. `error` keeps its
 *  reason in the description, so the state is never colour alone. */
export type AttachmentState = 'idle' | 'uploading' | 'processing' | 'error' | 'done';
export type AttachmentSize = 'default' | 'sm';

interface AttachmentContextValue {
  data: AttachmentData;
  state: AttachmentState;
  onRemove?: () => void;
}

const AttachmentContext = createContext<AttachmentContextValue | null>(null);
/** Whether an attachment sits in an Attachments list. */
const InAttachments = createContext(false);

function useAttachment(part: string): AttachmentContextValue {
  const value = useContext(AttachmentContext);
  if (value === null) throw new Error(`${part} must sit inside an Attachment`);
  return value;
}

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

/** A list of attachments, wrapping onto more rows. */
export function Attachments({ className, ...props }: ComponentProps<'div'>) {
  return (
    <InAttachments value>
      <div
        data-slot="attachments"
        role="list"
        {...props}
        className={classes('cb-ai-attachments', className)}
      />
    </InAttachments>
  );
}

export type AttachmentProps = ComponentProps<'div'> & {
  data: AttachmentData;
  /** Takes the file off; without it there is no remove button. */
  onRemove?: () => void;
  state?: AttachmentState;
  size?: AttachmentSize;
};

/** One file. Without children it draws its preview, its name and its
 *  remove button. */
export function Attachment({
  data,
  onRemove,
  state = 'done',
  size = 'default',
  className,
  children,
  ...props
}: AttachmentProps) {
  const listed = useContext(InAttachments);
  return (
    <AttachmentContext value={{ data, state, onRemove }}>
      <div
        data-slot="attachment"
        role={listed ? 'listitem' : undefined}
        {...props}
        data-state={state}
        data-size={size}
        className={classes('cb-ai-attachment', className)}
      >
        {children ?? (
          <>
            <AttachmentPreview />
            <AttachmentInfo />
            <AttachmentRemove />
          </>
        )}
      </div>
    </AttachmentContext>
  );
}

export type AttachmentPreviewProps = ComponentProps<'div'> & {
  /** Draws an image in a root as its thumbnail, given where it is and the
   *  kind's icon to fall back on: the caller's FileThumb (CV-61). Without
   *  it, the icon. */
  thumbnail?: (file: { rootId: string; path: string }, icon: ReactNode) => ReactNode;
};

/** The file's kind as its icon, or an image's thumbnail. Decoration: the
 *  name beside it is what is read. */
export function AttachmentPreview({ thumbnail, className, ...props }: AttachmentPreviewProps) {
  const { data } = useAttachment('AttachmentPreview');
  const name = data.path ?? data.label;
  const kind = data.kind ?? kindFor(name).kind;
  const look = lookFor(name, false);
  const icon = <Icon name={look.icon} size={16} color={look.color ?? undefined} />;
  const { rootId, path } = data;
  return (
    <div
      data-slot="attachment-preview"
      aria-hidden="true"
      {...props}
      data-kind={kind}
      className={classes('cb-ai-attachment-preview', className)}
    >
      {kind === 'image' && rootId !== undefined && path !== undefined && thumbnail !== undefined
        ? thumbnail({ rootId, path }, icon)
        : icon}
    </div>
  );
}

export type AttachmentInfoProps = ComponentProps<'div'> & {
  /** Show the description line, when there is one. */
  showDescription?: boolean;
};

/** The name, and the line under it. The name shimmers while the file is
 *  on its way in. */
export function AttachmentInfo({
  showDescription = true,
  className,
  ...props
}: AttachmentInfoProps) {
  const { data, state } = useAttachment('AttachmentInfo');
  const working = state === 'uploading' || state === 'processing';
  return (
    <div
      data-slot="attachment-info"
      {...props}
      className={classes('cb-ai-attachment-info', className)}
    >
      <span
        data-slot="attachment-title"
        title={data.label}
        className={classes('cb-ai-attachment-title', working && 'cb-ai-shimmer')}
      >
        {data.label}
      </span>
      {showDescription && data.description !== undefined && data.description !== '' && (
        <span data-slot="attachment-description" className="cb-ai-attachment-description">
          {data.description}
        </span>
      )}
    </div>
  );
}

export interface AttachmentRemoveProps {
  /** The button's name: "Remove <label>" unless the caller says better. */
  label?: string;
  disabled?: boolean;
  className?: string;
}

/** Takes the file off. Drawn only when the attachment has `onRemove`. */
export function AttachmentRemove({ label, disabled, className }: AttachmentRemoveProps) {
  const { data, onRemove } = useAttachment('AttachmentRemove');
  if (onRemove === undefined) return null;
  return (
    <IconButton
      icon="x"
      size="sm"
      label={label ?? `Remove ${data.label}`}
      disabled={disabled}
      onClick={onRemove}
      className={classes('cb-ai-attachment-remove', className)}
    />
  );
}
