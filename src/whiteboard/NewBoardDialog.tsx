import { useEffect, useRef, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { newBoardFile } from './newBoardFile';

export function NewBoardDialog({ onClose }: { onClose(): void }) {
  const capture = useVaultActionGuard('new-whiteboard');
  const [title, setTitle] = useState(''),
    [submitting, setSubmitting] = useState(false);
  const busy = useRef(false),
    live = useRef(true),
    open = useOpenPath();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const create = async () => {
    const vault = useVaultStore.getState().vaultPath;
    if (!vault || !title.trim() || busy.current) return;
    const current = capture();
    busy.current = true;
    setSubmitting(true);
    try {
      const path = await newBoardFile(vault, `${slugify(title.trim()) || 'whiteboard'}.canvas`);
      if (current()) {
        onClose();
        open(path);
      }
    } catch (error) {
      if (current())
        useUiStore
          .getState()
          .toast(
            `Couldn't create whiteboard: ${error instanceof Error ? error.message : String(error)}`,
          );
    } finally {
      busy.current = false;
      if (live.current) setSubmitting(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="New whiteboard"
      primaryAction={{
        label: 'Create whiteboard',
        onClick: () => void create(),
        disabled: !title.trim() || submitting,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <label className="flex flex-col gap-1 text-xs text-n-600">
        Title
        <Input
          autoFocus
          placeholder="Whiteboard title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          width="100%"
        />
      </label>
    </Dialog>
  );
}
