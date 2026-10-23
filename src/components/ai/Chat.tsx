// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import {
  Children,
  useImperativeHandle,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from 'react';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  type MessageScrollerCommands,
  type MessageScrollerDefaultScrollPosition,
} from './MessageScroller';
import './conversation.css';

/**
 * The thread (M91.8, shadcn's Chat): the conversation's rows in a Message
 * Scroller that follows the reply while the reader stays at the live edge,
 * a jump to the latest row, and the composer under it all. With no rows it
 * shows `empty` in the thread's place.
 *
 * The composer keeps its place in the tree whether the thread is empty or
 * not, so a field typed into before the first turn is the same field after
 * it. Mark the person's rows `scrollAnchor` (MessageScrollerItem) so each
 * new question settles near the top with its reply growing under it. A host
 * that moves the thread from outside it (a rail beside it) takes its scroll
 * commands through `scrollerRef`.
 */

export type ChatProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The rows: one MessageScrollerItem each. */
  children?: ReactNode;
  /** What the thread shows while it holds no rows. */
  empty?: ReactNode;
  /** The field under the thread: a PromptInput, its chips and its notes. */
  composer?: ReactNode;
  /** A turn is streaming: the log holds its announcement until it lands. */
  busy?: boolean;
  /** The transcript region's name. */
  label?: string;
  /** Follow the reply while the reader is at the live edge. */
  autoScroll?: boolean;
  /** Where a thread opens: by default its last turn, its reply below it. */
  defaultScrollPosition?: MessageScrollerDefaultScrollPosition;
  /** Classes for the log, which holds the rows. */
  contentClassName?: string;
  /** A test id for the jump to the latest row. */
  jumpTestId?: string;
  /** Takes the thread's scroll commands, for a host outside the thread:
   *  they outlive its empty state, queuing a jump until a row is drawn. */
  scrollerRef?: Ref<MessageScrollerCommands>;
};

/** Hands the provider's commands to the host's ref. */
function ScrollerHandle({ handle }: { handle: Ref<MessageScrollerCommands> }) {
  const commands = useMessageScroller();
  useImperativeHandle(handle, () => commands, [commands]);
  return null;
}

export function Chat({
  children,
  empty,
  composer,
  busy = false,
  label = 'Messages',
  autoScroll = true,
  defaultScrollPosition = 'last-anchor',
  contentClassName,
  jumpTestId,
  scrollerRef,
  className,
  ...props
}: ChatProps) {
  // toArray, not count: a `false` or a `null` slot is not a row.
  const showEmpty = empty !== undefined && Children.toArray(children).length === 0;
  return (
    <MessageScrollerProvider autoScroll={autoScroll} defaultScrollPosition={defaultScrollPosition}>
      {scrollerRef !== undefined && <ScrollerHandle handle={scrollerRef} />}
      <div
        data-slot="chat"
        {...props}
        data-empty={showEmpty ? '' : undefined}
        className={['cb-ai-chat', className].filter(Boolean).join(' ')}
      >
        {showEmpty ? (
          <div data-slot="chat-empty" className="cb-ai-chat-empty">
            {empty}
          </div>
        ) : (
          <MessageScroller className="cb-ai-chat-thread">
            <MessageScrollerViewport aria-label={label}>
              <MessageScrollerContent aria-busy={busy || undefined} className={contentClassName}>
                {children}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton data-testid={jumpTestId} />
          </MessageScroller>
        )}
        {composer !== undefined && (
          <div data-slot="chat-composer" className="cb-ai-chat-composer">
            {composer}
          </div>
        )}
      </div>
    </MessageScrollerProvider>
  );
}
