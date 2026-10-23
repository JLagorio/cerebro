import { useLayoutEffect, useRef, useState } from 'react';
import { Queue, QueueItem, QueueItemAction, QueueList, QueueSection } from '@/components/ai/Queue';
import { Icon } from '@/components/ui/Icon';
import { Arrival, useDrawn } from '@/components/ui/motion';
import { UP_NEXT_STARTING, upNextRow, type UpNextAction } from './elements/composerQueue';
import { UP_NEXT_CAP, type UpNextEntry } from './upNextQueue';

/** What the rows read and do: `useUpNext`'s answer, or a test's. */
export interface UpNextView {
  entries: UpNextEntry[];
  held: boolean;
  steering: string | null;
  editing: string | null;
  full: boolean;
  /** A turn is in flight, stopping, or waiting on a card. */
  busy: boolean;
  edit(id: string, text: string): boolean;
  beginEdit(id: string): void;
  endEdit(): void;
  remove(id: string): void;
  steer(id: string): void;
  resume(): void;
}

/** One entry's editor: Enter and blur save, Escape cancels. */
function EntryEditor({
  entry,
  onSave,
  onCancel,
}: {
  entry: UpNextEntry;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(entry.text);
  // Enter and blur can both land for one save; the first one wins.
  const [closed, setClosed] = useState(false);
  const save = () => {
    if (closed) return;
    setClosed(true);
    onSave(value);
  };
  return (
    <textarea
      data-testid="up-next-editor"
      aria-label="Edit this message"
      autoFocus
      rows={2}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        // The Enter that commits an IME composition is the composition's,
        // as the composer's is: `isComposing`, or WebKit's 229 after it.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          save();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setClosed(true);
          onCancel();
        }
      }}
      className="block w-full resize-none rounded-md border border-n-300 bg-n-0 px-1.5 py-1 text-xs leading-[16px] text-n-800 outline-none focus:border-cortex-500"
    />
  );
}

/** An entry's actions, beside its line in the order its row offers them. */
function EntryAction({
  action,
  entry,
  upNext,
}: {
  action: UpNextAction;
  entry: UpNextEntry;
  upNext: UpNextView;
}) {
  switch (action) {
    case 'steer':
      return (
        <QueueItemAction
          data-testid="up-next-steer"
          title="Stop this turn and run this message next"
          onClick={() => upNext.steer(entry.id)}
        >
          Steer
        </QueueItemAction>
      );
    case 'run-now':
      return (
        <QueueItemAction data-testid="up-next-run-now" onClick={() => upNext.steer(entry.id)}>
          Run now
        </QueueItemAction>
      );
    case 'edit':
      return (
        <QueueItemAction
          data-testid="up-next-edit"
          aria-label="Edit"
          onClick={() => upNext.beginEdit(entry.id)}
        >
          <Icon name="pencil" size={10} />
        </QueueItemAction>
      );
    case 'remove':
      return (
        <QueueItemAction
          data-testid="up-next-remove"
          aria-label="Remove from Up next"
          onClick={() => upNext.remove(entry.id)}
        >
          <Icon name="x" size={10} />
        </QueueItemAction>
      );
  }
}

/**
 * Up next (M57.5): the messages this conversation holds for after its turn,
 * in run order, next first, drawn as a Queue (M91.12a). Steer stops the
 * running turn and starts an entry next (only while `STEER_BY_RESTART`
 * holds); Run now starts one while Up next is on hold, and Resume beside its
 * heading lets the hold go; a typed entry can be edited (a handoff and
 * review notes cannot); any entry can be removed (elements/composerQueue).
 * Nothing at all when nothing waits.
 */
export function UpNext({ upNext }: { upNext: UpNextView }) {
  const { entries, held, full } = upNext;
  // Drawn with its conversation (AiPanel keys it by the thread): what that
  // held is simply there. A list that comes to hold something comes in, and
  // an entry joining one already shown comes in on its own (chat.css).
  const drawn = useDrawn();
  const shown = useRef(false);
  useLayoutEffect(() => {
    shown.current = entries.length > 0;
  });
  if (entries.length === 0) return null;
  const joining = drawn && shown.current;
  return (
    <Arrival when={drawn}>
      <Queue className="cb-up-next" render={<section data-testid="up-next" aria-label="Up next" />}>
        <QueueSection
          label={<span title={`Up next holds up to ${UP_NEXT_CAP} messages.`}>Up next</span>}
          collapsible={false}
          headingLevel={3}
          actions={
            held && (
              <QueueItemAction data-testid="up-next-resume" onClick={upNext.resume}>
                Resume
              </QueueItemAction>
            )
          }
        >
          {held && (
            <p data-testid="up-next-held" className="cb-up-next-note">
              Up next is on hold because the last turn stopped.
            </p>
          )}
          <QueueList>
            {entries.map((entry) => {
              const row = upNextRow(entry, upNext);
              return (
                <Arrival key={entry.id} when={joining}>
                  <QueueItem
                    data-testid="up-next-entry"
                    data-id={entry.id}
                    // Being edited, the editor stands in for the whole line,
                    // under the other entries' words (chat.css).
                    icon={row.editing ? undefined : 'corner-down-right'}
                    // Steered, the row says so before its words, and the
                    // working light stands where its actions were.
                    status={row.starting ? 'in_progress' : undefined}
                    statusText={row.starting ? UP_NEXT_STARTING : undefined}
                    title={row.editing ? undefined : entry.text}
                    titleProps={{ 'data-testid': 'up-next-text', title: entry.text }}
                    actions={
                      row.starting ? (
                        <span aria-hidden="true" className="cb-working-text">
                          {UP_NEXT_STARTING}
                        </span>
                      ) : (
                        row.actions.length > 0 &&
                        row.actions.map((action) => (
                          <EntryAction key={action} action={action} entry={entry} upNext={upNext} />
                        ))
                      )
                    }
                  >
                    {row.editing && (
                      <EntryEditor
                        entry={entry}
                        onSave={(text) => {
                          upNext.edit(entry.id, text);
                          upNext.endEdit();
                        }}
                        onCancel={upNext.endEdit}
                      />
                    )}
                  </QueueItem>
                </Arrival>
              );
            })}
          </QueueList>
          {full && (
            <p data-testid="up-next-full" className="cb-up-next-note" data-tone="warn">
              Up next holds {UP_NEXT_CAP} messages. Remove one, or wait for this turn to finish.
            </p>
          )}
        </QueueSection>
      </Queue>
    </Arrival>
  );
}
