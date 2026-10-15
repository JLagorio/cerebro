import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { STEER_BY_RESTART, UP_NEXT_CAP, isTyped, type UpNextEntry } from './upNextQueue';

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

const ROW_BUTTON =
  'flex-none rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-2xs text-n-600 hover:border-n-400 hover:text-n-900';

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
      className="min-w-0 flex-1 resize-none rounded-md border border-n-300 bg-n-0 px-1.5 py-1 text-xs leading-[16px] text-n-800 outline-none focus:border-cortex-500"
    />
  );
}

/**
 * Up next (M57.5): the messages this conversation holds for after its turn,
 * in run order, next first. Steer stops the running turn and starts an entry
 * next (only while `STEER_BY_RESTART` holds); Run now starts one while Up next
 * is on hold; a typed entry can be edited (a handoff and review notes
 * cannot); any entry can be removed.
 * Nothing at all when nothing waits.
 */
export function UpNext({ upNext }: { upNext: UpNextView }) {
  const { entries, held, steering, editing, full, busy } = upNext;
  if (entries.length === 0) return null;
  return (
    <section
      data-testid="up-next"
      aria-label="Up next"
      className="mb-1.5 flex flex-col gap-1 rounded-lg border border-n-200 bg-n-25 px-2 py-1.5"
    >
      <h3
        className="m-0 text-2xs font-medium text-n-500"
        title={`Up next holds up to ${UP_NEXT_CAP} messages.`}
      >
        Up next
      </h3>
      {held && (
        <div
          data-testid="up-next-held"
          className="flex items-center gap-2 text-2xs leading-[15px] text-n-600"
        >
          <span className="min-w-0 flex-1">Up next is on hold because the last turn stopped.</span>
          <button
            type="button"
            data-testid="up-next-resume"
            onClick={upNext.resume}
            className={ROW_BUTTON}
          >
            Resume
          </button>
        </div>
      )}
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {entries.map((entry) => {
          const starting = steering === entry.id;
          const typed = isTyped(entry);
          return (
            <li
              key={entry.id}
              data-testid="up-next-entry"
              data-id={entry.id}
              className="flex items-start gap-1.5"
            >
              <Icon name="corner-down-right" size={11} color="var(--n-400)" />
              {editing === entry.id && typed ? (
                <EntryEditor
                  entry={entry}
                  onSave={(text) => {
                    upNext.edit(entry.id, text);
                    upNext.endEdit();
                  }}
                  onCancel={upNext.endEdit}
                />
              ) : (
                <span
                  data-testid="up-next-text"
                  className="min-w-0 flex-1 truncate text-xs leading-[16px] text-n-700"
                  title={entry.text}
                >
                  {entry.text}
                </span>
              )}
              {starting ? (
                <span className="flex-none text-2xs text-n-500">Starting…</span>
              ) : (
                editing !== entry.id && (
                  <>
                    {busy && STEER_BY_RESTART && steering === null && (
                      <button
                        type="button"
                        data-testid="up-next-steer"
                        title="Stop this turn and run this message next"
                        onClick={() => upNext.steer(entry.id)}
                        className={ROW_BUTTON}
                      >
                        Steer
                      </button>
                    )}
                    {held && !busy && (
                      <button
                        type="button"
                        data-testid="up-next-run-now"
                        onClick={() => upNext.steer(entry.id)}
                        className={ROW_BUTTON}
                      >
                        Run now
                      </button>
                    )}
                    {typed && (
                      <button
                        type="button"
                        data-testid="up-next-edit"
                        aria-label="Edit"
                        onClick={() => upNext.beginEdit(entry.id)}
                        className={ROW_BUTTON}
                      >
                        <Icon name="pencil" size={10} />
                      </button>
                    )}
                    <button
                      type="button"
                      data-testid="up-next-remove"
                      aria-label="Remove from Up next"
                      onClick={() => upNext.remove(entry.id)}
                      className={ROW_BUTTON}
                    >
                      <Icon name="x" size={10} />
                    </button>
                  </>
                )
              )}
            </li>
          );
        })}
      </ol>
      {full && (
        <p data-testid="up-next-full" className="m-0 text-2xs leading-[15px] text-warn-600">
          Up next holds {UP_NEXT_CAP} messages. Remove one, or wait for this turn to finish.
        </p>
      )}
    </section>
  );
}
