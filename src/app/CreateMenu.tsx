import { useEffect, useRef, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Tooltip } from '@/components/ui/Tooltip';
import { useNavStore } from '@/stores/navStore';
import type { CreationContext } from '@/engine/creationDestination';
import { CreationDestinationField } from './CreationDestinationField';
import { CreationDraftRecovery } from './CreationDraftRecovery';
import { CreationTransferChoice } from './CreationTransferChoice';
import { useCreationSession } from './useCreationSession';
import { useVaultStore, useSchema } from '@/stores/vaultStore';
import { useLauncherStore } from '@/stores/launcherStore';
import { RecordComposer } from '@/app/RecordComposer';

/** The sidebar door; the launcher itself lives at the app root. */
export function CreateMenu() {
  const open = useLauncherStore((s) => s.open);
  const openLauncher = useLauncherStore((s) => s.openLauncher);
  return (
    <Tooltip label="New" command="create.launcher" disabled={open}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.currentTarget.focus();
          openLauncher();
        }}
        className="cb-context-create flex h-8 w-full items-center gap-[9px] rounded-md border border-n-200 bg-n-0 px-2 text-left text-sm font-medium text-n-800 hover:bg-n-100"
      >
        <Icon name="plus" size={15} color="var(--n-500)" />
        New
      </button>
    </Tooltip>
  );
}

/** The shared composer also accepts the Knowledge page's suggested title. */
export function NewRecordDialog({
  defaultTitle = '',
  onClose,
  context,
}: {
  context?: CreationContext;
  defaultTitle?: string;
  onClose: () => void;
}) {
  return <RecordComposer defaultTitle={defaultTitle} onClose={onClose} context={context} />;
}

export function NewDocDialog({
  onClose,
  sheet = false,
  context: suppliedContext,
}: {
  onClose: () => void;
  sheet?: boolean;
  context?: CreationContext;
}) {
  const openPath = useOpenPath();
  const vault = useVaultStore((state) => state.vaultPath);
  const entries = useVaultStore((state) => state.entries);
  const folders = useVaultStore((state) => state.folders);
  const schema = useSchema();
  const titleBox = useRef<HTMLLabelElement>(null);
  const [origin] = useState<CreationContext>(
    () =>
      suppliedContext ?? {
        vault: vault ?? '',
        pane: useNavStore.getState().active,
        destination: {
          kind: 'page',
          folder: '',
          recipe: sheet ? { kind: 'sheet', sheetName: 'Sheet1' } : { kind: 'blank' },
        },
      },
  );
  const session = useCreationSession(
    origin,
    () => ({ title: '', values: {} }),
    (submission) => {
      if (submission.snapshot.createMore) titleBox.current?.querySelector('input')?.focus();
      else if (submission.path !== null) {
        onClose();
        openPath(submission.path);
      }
    },
  );
  useEffect(() => {
    if (origin.vault !== vault) onClose();
  }, [origin, vault, onClose]);
  const isSheet =
    session.context.destination.kind === 'page' &&
    session.context.destination.recipe.kind === 'sheet';
  const error =
    session.saved?.revision === session.draft.revision
      ? session.saved.formError
      : session.draft.formError;
  return (
    <div
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' &&
          !event.nativeEvent.isComposing &&
          (event.metaKey || event.ctrlKey)
        ) {
          event.preventDefault();
          event.stopPropagation();
          session.submit();
        }
      }}
    >
      <Dialog
        open
        onClose={onClose}
        title={isSheet ? 'New sheet' : 'New page'}
        footerNote="Drafts last for this session, until the app closes."
        primaryAction={{
          label: session.pending ? 'Creating…' : isSheet ? 'Create' : 'Create page',
          onClick: session.submit,
          disabled:
            session.draft.title.trim() === '' ||
            session.pending ||
            session.recovering ||
            !session.claimed ||
            session.transfer !== null,
        }}
        secondaryAction={{ label: 'Cancel', onClick: onClose }}
      >
        {session.recovering || !session.claimed ? (
          <CreationDraftRecovery
            pending={session.pending}
            occupied={!session.claimed}
            onResume={session.resume}
            onDiscard={session.discard}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <CreationDestinationField
              destination={session.context.destination}
              entries={entries}
              folders={folders}
              schema={schema}
              disabled={session.pending}
              onChange={session.changeDestination}
            />
            <CreationTransferChoice session={session} />
            <label ref={titleBox} className="flex flex-col gap-1 text-xs text-n-600">
              {isSheet ? 'Name' : 'Title'}
              <Input
                autoFocus
                placeholder={isSheet ? 'Name the page' : 'Page title'}
                value={session.draft.title}
                disabled={session.pending}
                onChange={(event) => session.update({ title: event.target.value, formError: null })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.stopPropagation();
                    session.submit();
                  }
                }}
                width="100%"
              />
            </label>
            {error !== null && (
              <p role="alert" className="m-0 text-xs text-danger-600">
                {error}
              </p>
            )}
            <label className="flex items-center gap-2 text-sm text-n-600">
              <input
                type="checkbox"
                checked={session.draft.createMore}
                disabled={session.pending}
                onChange={(event) => session.update({ createMore: event.target.checked })}
              />
              Create more
            </label>
          </div>
        )}
      </Dialog>
    </div>
  );
}
