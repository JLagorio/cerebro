import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { ConversationState } from '@/agent/useConversations';

/**
 * Pick, rename, or delete a conversation (M9.5).
 *
 * The panel used to have one thread and a reset button that erased it. The
 * transcript of "help me clear the Inbox" is worth keeping around at least
 * as long as the Inbox is not clear.
 */
export function ConversationSwitcher({ state }: { state: ConversationState }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // M15: deleting was one hover-revealed click, 4px from the rename pencil,
  // against the only copy of a transcript (localStorage — deliberately not the
  // vault). The row asks first now; there is nothing to undo it with.
  const [confirming, setConfirming] = useState<string | null>(null);

  const commit = (id: string) => {
    state.rename(id, draft);
    setRenaming(null);
  };

  return (
    <span className="relative inline-flex min-w-0">
      <button
        type="button"
        data-testid="conversation-switcher"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex min-w-0 items-center gap-1 rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-n-600 hover:bg-n-50 hover:text-n-900"
      >
        <span className="max-w-[150px] truncate">{state.active?.title ?? 'Assistant'}</span>
        <Icon name="chevron-down" size={11} />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close conversations"
            onClick={() => setOpen(false)}
            onWheel={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
          />
          <div className="cb-menu-in absolute left-0 top-6 z-50 w-[260px] rounded-lg border border-n-200 bg-n-0 p-1 shadow-[var(--shadow-lg)]">
            <button
              type="button"
              onClick={() => {
                state.start();
                setOpen(false);
              }}
              className="mb-1 flex w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1 text-left text-sm text-n-700 hover:bg-n-50"
            >
              <Icon name="plus" size={12} color="var(--n-500)" />
              New conversation
            </button>
            <div className="max-h-[280px] overflow-y-auto border-t border-n-100 pt-1">
              {state.conversations.map((c) => (
                <div
                  key={c.id}
                  data-testid="conversation-row"
                  className={[
                    'group flex items-center gap-1 rounded-md px-2 py-1',
                    c.id === state.activeId ? 'bg-cortex-50' : 'hover:bg-n-50',
                  ].join(' ')}
                >
                  {confirming === c.id ? (
                    <>
                      <span className="min-w-0 flex-1 truncate text-xs text-n-600">
                        Delete “{c.title}”?
                      </span>
                      <button
                        type="button"
                        data-testid="confirm-delete"
                        aria-label={`Confirm delete ${c.title}`}
                        onClick={() => {
                          setConfirming(null);
                          state.remove(c.id);
                        }}
                        className="flex-none rounded border-0 bg-transparent px-1 py-0.5 text-xs font-medium text-danger-600 hover:bg-danger-50"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        aria-label="Keep conversation"
                        onClick={() => setConfirming(null)}
                        className="flex-none rounded border-0 bg-transparent px-1 py-0.5 text-xs text-n-500 hover:bg-n-100"
                      >
                        Keep
                      </button>
                    </>
                  ) : renaming === c.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commit(c.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commit(c.id);
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      aria-label={`Rename ${c.title}`}
                      className="min-w-0 flex-1 rounded border border-cortex-400 bg-n-0 px-1 py-0.5 text-xs outline-none"
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          state.select(c.id);
                          setOpen(false);
                        }}
                        className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-sm text-n-800"
                      >
                        {c.title}
                        {c.messages.length > 0 && (
                          <span className="ml-1.5 text-2xs text-n-400">
                            {c.messages.filter((m) => m.role === 'user').length}
                          </span>
                        )}
                      </button>
                      <span className="hidden gap-0.5 group-hover:inline-flex">
                        <button
                          type="button"
                          aria-label={`Rename ${c.title}`}
                          onClick={() => {
                            setDraft(c.title);
                            setRenaming(c.id);
                          }}
                          className="rounded border-0 bg-transparent p-0.5 text-n-400 hover:text-n-800"
                        >
                          <Icon name="pencil" size={11} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${c.title}`}
                          onClick={() => setConfirming(c.id)}
                          className="rounded border-0 bg-transparent p-0.5 text-n-400 hover:text-danger-500"
                        >
                          <Icon name="trash-2" size={11} />
                        </button>
                      </span>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
  );
}
