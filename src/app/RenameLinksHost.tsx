import { useEffect } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { useRenamePromptStore } from '@/stores/renamePromptStore';
import { useVaultStore } from '@/stores/vaultStore';

/** The review of everything a rename can update and everything it must leave. */
export function RenameLinksHost() {
  const pending = useRenamePromptStore((state) => state.pending);
  const answer = useRenamePromptStore((state) => state.answer);
  const vault = useVaultStore((state) => state.vaultPath);
  useEffect(() => {
    if (pending !== null && pending.vault !== vault) answer(false, pending.id);
  }, [pending, vault, answer]);
  useEffect(() => () => useRenamePromptStore.getState().cancel(), []);
  if (pending === null || pending.vault !== vault) return null;
  const count = pending.pages.reduce((total, page) => total + page.count, 0);
  const pageCount = pending.pages.length;
  const anchors = pending.anchors.length;
  const updates = count > 0 || anchors > 0;
  const boards = [
    ...new Map(
      pending.sources.filter((source) => source.board).map((source) => [source.path, source]),
    ).values(),
  ];
  const sources = pending.sources.filter((source) => !source.board);
  const refused = pending.refused.length > 0 || sources.length > 0;
  const reply = (accepted: boolean) => answer(accepted, pending.id);
  return (
    <Dialog
      open
      title={`Rename “${pending.from}” to “${pending.to}”?`}
      onClose={() => reply(false)}
      primaryAction={{
        label: updates ? 'Rename and update' : 'Rename anyway',
        onClick: () => reply(true),
      }}
      secondaryAction={{ label: 'Cancel', onClick: () => reply(false) }}
    >
      <div data-testid="rename-links-prompt" className="flex flex-col gap-3">
        {count > 0 && (
          <p className="m-0" data-testid="rename-links-summary">
            Updates {count} {count === 1 ? 'link' : 'links'} in {pageCount}{' '}
            {pageCount === 1 ? 'page' : 'pages'}.
          </p>
        )}
        {pageCount > 0 && (
          <ul className="m-0 list-none space-y-1 p-0">
            {pending.pages.slice(0, 8).map((page) => (
              <li key={page.path} title={page.path}>
                {page.title}
              </li>
            ))}
            {pageCount > 8 && <li>and {pageCount - 8} more</li>}
          </ul>
        )}
        {anchors > 0 && (
          <p className="m-0" data-testid="rename-links-anchors">
            Points {anchors} knowledge {anchors === 1 ? 'concept' : 'concepts'} at the new name.
            Knowledge records it as your edit.
          </p>
        )}
        {boards.length > 0 && (
          <div data-testid="rename-links-boards">
            <p className="m-0">
              {boards.length} {boards.length === 1 ? 'whiteboard keeps' : 'whiteboards keep'} cards
              pointing at {pending.fromPath ?? pending.from}.
            </p>
            <ul className="m-0 mt-1 list-none space-y-1 p-0">
              {boards.map((board) => (
                <li key={board.path}>{board.path}</li>
              ))}
            </ul>
          </div>
        )}
        {refused && (
          <>
            <p className="m-0">Left as they are, still naming the old page:</p>
            <ul className="m-0 list-none space-y-1 p-0" data-testid="rename-links-refused">
              {pending.refused.map((page) => (
                <li key={page.path}>
                  {page.title} — {page.count} {page.count === 1 ? 'link' : 'links'} in its text
                </li>
              ))}
              {sources.map((source, index) => (
                <li key={`${source.path}:${index}`}>
                  {source.title} — its source still names {source.resource}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Dialog>
  );
}
