import { useContext, useRef, useState } from 'react';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai/PromptInput';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { NotePathContext } from '@/editor/notePath';
import { askedAbout, sheetAskPrompt, type SheetAskCell } from '@/lib/prompts';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import './sheetAsk.css';

/**
 * Ask about the selected cells: a question, written in a Prompt Input
 * (M91.14), that hands off to the assistant with the range's cells and the
 * page. It runs nothing itself, so it is the input's anatomy only — the
 * field and its Ask — and the conversation shows the turn.
 */
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
          <PromptInput onSubmit={ask} className="cb-sheet-ask-field">
            <PromptInputBody>
              <PromptInputTextarea
                data-testid="sheet-ask-input"
                aria-label="Question about these cells"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                autoFocus
                placeholder="What would you like to know?"
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputSubmit
                aria-label="Ask"
                disabled={!question.trim()}
                className="cb-sheet-ask-submit"
              >
                Ask
              </PromptInputSubmit>
            </PromptInputFooter>
          </PromptInput>
        </Popover>
      )}
    </div>
  );
}
