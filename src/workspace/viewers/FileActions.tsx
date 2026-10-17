import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { FileProbe } from '@/engine/fileBytes';
import { fileActionWords, type FileActionResult } from '@/engine/fileActions';
import {
  desktopFileActions,
  openFileOutside,
  quickLookFile,
  revealFile,
  saveFileCopy,
} from '@/lib/rootsIpc';
import { useUiStore } from '@/stores/uiStore';

export function FileActions({
  rootId,
  path,
  probe,
}: {
  rootId: string;
  path: string;
  probe: FileProbe;
}) {
  const [busy, setBusy] = useState(false);
  const desktop = desktopFileActions();
  const act = async (action: (root: string, path: string) => Promise<FileActionResult>) => {
    setBusy(true);
    try {
      const words = fileActionWords(await action(rootId, path));
      if (words !== null) useUiStore.getState().toast(words);
    } catch {
      useUiStore.getState().toast("Couldn't complete this file action");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="file-actions"
      role="group"
      aria-label="File actions"
      data-testid="file-actions"
      title={desktop ? undefined : 'Desktop app only'}
    >
      {probe.open !== 'deny' && (
        <Button size="sm" disabled={!desktop || busy} onClick={() => void act(openFileOutside)}>
          {probe.open === 'confirm' ? 'Open…' : 'Open'}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={!desktop || busy}
        onClick={() => void act(revealFile)}
      >
        Reveal in Finder
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!desktop || busy}
        onClick={() => void act(quickLookFile)}
      >
        Quick Look
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!desktop || busy}
        onClick={() => void act(saveFileCopy)}
      >
        Save a copy…
      </Button>
      {!desktop && <span className="file-viewer-hint">Desktop app only</span>}
    </div>
  );
}
