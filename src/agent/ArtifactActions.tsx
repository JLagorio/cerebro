import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CreationDestinationField } from '@/app/CreationDestinationField';
import { MessageToolbar } from '@/components/ai/Message';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import type { CreationDestination } from '@/engine/creationDestination';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import {
  answerPreview,
  saveAnswerPage,
  type AnswerPreview,
  type AnswerSaveResult,
} from './artifacts';

/** The same completed-answer actions in every chat presentation. The answer
 * preview is frozen at the person's click and never renders generated HTML. */
export function ArtifactActions({
  attemptId,
  text,
  onPreview,
}: {
  attemptId: string;
  text: string;
  onPreview: (preview: AnswerPreview) => void;
}) {
  const vault = useVaultStore((state) => state.vaultPath);
  const ready = useVaultStore(
    (state) => state.status === 'ready' && state.entriesVault === state.vaultPath,
  );
  return (
    <MessageToolbar
      aria-label="Answer actions"
      copy={text}
      onSave={
        vault !== null && ready ? () => onPreview(answerPreview(attemptId, vault, text)) : undefined
      }
    />
  );
}

export function AnswerSaveDialog({
  preview,
  onClose,
  onOpenPath,
}: {
  preview: AnswerPreview;
  onClose: () => void;
  onOpenPath: (path: string) => void;
}) {
  const entries = useVaultStore((state) => state.entries);
  const folders = useVaultStore((state) => state.folders);
  const schema = useSchema();
  const [title, setTitle] = useState('');
  const [destination, setDestination] = useState<CreationDestination>({
    kind: 'page',
    folder: '',
    recipe: { kind: 'blank' },
  });
  const [pending, setPending] = useState(false);
  const [retired, setRetired] = useState(false);
  const [result, setResult] = useState<AnswerSaveResult | null>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const invalid = useRef(false);
  const ready = () => {
    const state = useVaultStore.getState();
    return (
      state.vaultPath === preview.vault &&
      state.entriesVault === preview.vault &&
      state.status === 'ready'
    );
  };
  useLayoutEffect(() => {
    const check = () => {
      if (!ready()) {
        invalid.current = true;
        setRetired(true);
      }
    };
    check();
    return useVaultStore.subscribe(check);
    // The preview owns the original opening, even across A → B → A.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.vault]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const save = async () => {
    if (busy.current || invalid.current || !ready() || destination.kind !== 'page') return;
    busy.current = true;
    setPending(true);
    setResult(null);
    const saved = await saveAnswerPage(
      preview,
      title,
      destination.folder,
      () => alive.current && !invalid.current && ready(),
    );
    busy.current = false;
    if (!alive.current) return;
    setResult(saved);
    setPending(false);
  };
  const close = pending ? undefined : onClose;
  const saved = result?.kind === 'saved' ? result : null;
  return (
    <Dialog
      open
      title="Save answer as page"
      onClose={close}
      footerNote="This copy will not change when the answer is regenerated."
      primaryAction={
        saved
          ? {
              label: 'Open page',
              disabled: retired,
              onClick: () => {
                if (!invalid.current && ready()) {
                  onClose();
                  onOpenPath(saved.path);
                }
              },
            }
          : {
              label: pending ? 'Saving…' : 'Save page',
              onClick: () => void save(),
              disabled: pending || retired || title.trim() === '',
            }
      }
      secondaryAction={{ label: saved ? 'Done' : 'Cancel', onClick: close, disabled: pending }}
    >
      <div className="flex flex-col gap-4">
        {retired && (
          <p role="status">
            The original vault is no longer open. Close this preview and choose the answer again.
          </p>
        )}
        {saved ? (
          <p role="status">Saved to {saved.path}</p>
        ) : (
          <>
            <CreationDestinationField
              destination={destination}
              entries={entries}
              folders={folders}
              schema={schema}
              disabled={pending || retired}
              onChange={(next) => {
                setDestination(next);
                setResult(null);
              }}
            />
            <label className="flex flex-col gap-1 text-xs text-n-600">
              Page title
              <Input
                autoFocus
                value={title}
                disabled={pending || retired}
                width="100%"
                onChange={(event) => {
                  setTitle(event.target.value);
                  setResult(null);
                }}
              />
            </label>
          </>
        )}
        <details open>
          <summary className="text-xs text-n-600">Answer preview</summary>
          <pre
            data-testid="answer-save-preview"
            className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm"
            style={{ fontFamily: 'inherit' }}
          >
            {preview.text}
          </pre>
        </details>
        {result?.kind === 'refused' && (
          <p role="alert" className="m-0 text-sm text-danger-600">
            {result.message}
          </p>
        )}
      </div>
    </Dialog>
  );
}
