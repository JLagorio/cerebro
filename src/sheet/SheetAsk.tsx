import { useContext, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Popover } from '@/components/ui/Popover';
import { NotePathContext } from '@/editor/notePath';
import { askedAbout, sheetAskPrompt, type SheetAskCell } from '@/lib/prompts';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
export function SheetAsk({
  selection,
  readCells,
  beforeAsk,
  open,
  setOpen,
}: {
  selection: string;
  readCells: () => SheetAskCell[];
  beforeAsk: () => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const path = useContext(NotePathContext);
  const title = useVaultStore((state) => state.entries.find((entry) => entry.path === path)?.title);
  const anchor = useRef<HTMLDivElement>(null);
  const [question, setQuestion] = useState('');
  if (!path) return null;
  const ask = () => {
    const text = question.trim();
    if (!text) return;
    try {
      beforeAsk();
      useUiStore
        .getState()
        .askAgent(
          sheetAskPrompt(text, path, title ?? path, selection, readCells()),
          path,
          askedAbout(text, selection),
        );
      setOpen(false);
      setQuestion('');
    } catch (error) {
      useUiStore.getState().toast(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div ref={anchor}>
      <Button
        testId="sheet-ask"
        size="sm"
        variant="ghost"
        className="text-synapse-600"
        onClick={() => setOpen(!open)}
      >
        Ask about selection
      </Button>
      {open && (
        <Popover
          anchorRef={anchor}
          onClose={() => setOpen(false)}
          role="dialog"
          ariaLabel="Ask about selected cells"
          className="w-80 rounded-lg border border-n-200 bg-n-0 p-3 shadow-[var(--shadow-lg)]"
        >
          <div className="mb-2 font-mono text-xs text-n-500">{selection}</div>
          <Input
            testId="sheet-ask-input"
            ariaLabel="Question about these cells"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                ask();
              }
            }}
            autoFocus
            placeholder="What would you like to know?"
            width="100%"
          />
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="ghost" disabled={!question.trim()} onClick={ask}>
              Ask
            </Button>
          </div>
        </Popover>
      )}
    </div>
  );
}
