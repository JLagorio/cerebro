import type { ImportInput } from '@/engine/inlets';
import { IcsImportDialog } from './IcsImportDialog';

/** Each local file owns a preview. Nothing is written by opening it. */
export function ImportInlet({
  input,
  onClose,
  shouldNavigate,
}: {
  input: ImportInput;
  onClose: () => void;
  shouldNavigate?: () => boolean;
}) {
  switch (input.kind) {
    case 'calendar':
      return <IcsImportDialog input={input} onClose={onClose} shouldNavigate={shouldNavigate} />;
  }
}
