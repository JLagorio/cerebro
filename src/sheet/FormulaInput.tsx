import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Popover } from '@/components/ui/Popover';
import { sheetComplete } from '@/lib/ipc';
import {
  catalogEntries,
  completionFor,
  insertFunction,
  toChars,
  type CatalogEntry,
  type CompletionContext,
} from '@/engine/sheet/formulaComplete';
export interface FormulaCursor {
  context: CompletionContext;
  text: string;
  cursor: number;
}
interface Props {
  names: string[];
  sheet: number;
  row: number;
  column: number;
  value: string;
  readOnly?: boolean;
  testId: string;
  label: string;
  className?: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onContext?: (cursor: FormulaCursor | null) => void;
}
let catalog: Promise<CatalogEntry[]> | undefined;
function loadCatalog() {
  return (catalog ??= import('@/engine/sheet/functions.json').then((raw) =>
    catalogEntries(raw.default),
  ));
}
export function FormulaInput(props: Props) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const input = props.inputRef ?? ownRef;
  const latest = useRef(props);
  latest.current = props;
  const sequence = useRef(0);
  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState(props.value.length);
  const [answer, setAnswer] = useState<{ at: FormulaCursor; entries: CatalogEntry[] } | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, dismiss] = useState('');
  const id = useId();
  const queryKey = JSON.stringify([
    props.names,
    props.sheet,
    props.row,
    props.column,
    props.value,
    cursor,
  ]);
  useLayoutEffect(() => {
    sequence.current += 1;
    latest.current.onContext?.(null);
    setAnswer(null);
  }, [queryKey, focused, props.readOnly]);
  useEffect(() => {
    if (!focused || props.readOnly || !props.value.startsWith('=')) return;
    const current = sequence.current;
    const timer = setTimeout(() => {
      void Promise.all([
        sheetComplete(
          props.names,
          props.sheet,
          props.row,
          props.column,
          props.value,
          toChars(props.value, cursor),
        ),
        loadCatalog(),
      ])
        .then(([context, entries]) => {
          if (sequence.current !== current || latest.current.readOnly) return;
          const at = { context, text: props.value, cursor };
          setAnswer({ at, entries });
          setActive(0);
          latest.current.onContext?.(at);
        })
        .catch(() => {
          /* Completion is optional; editing and commit remain available. */
        });
    }, 60);
    return () => {
      clearTimeout(timer);
      sequence.current += 1;
    };
  }, [
    queryKey,
    focused,
    props.readOnly,
    props.names,
    props.sheet,
    props.row,
    props.column,
    props.value,
    cursor,
  ]);
  const completion =
    !props.readOnly && answer && answer.at.text === props.value
      ? completionFor(answer.at.context, answer.entries)
      : null;
  const open = focused && dismissed !== queryKey && completion?.kind === 'functions';
  const insert = (name: string) => {
    if (!answer || latest.current.readOnly) return;
    const next = insertFunction(props.value, cursor, answer.at.context, name);
    props.onChange(next.text);
    setCursor(next.cursor);
    dismiss('');
    requestAnimationFrame(() => {
      if (latest.current.readOnly) return;
      input.current?.focus();
      input.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };
  const key = useRef<(event: KeyboardEvent) => void>(() => {});
  key.current = (event) => {
    if (!open || completion?.kind !== 'functions' || event.isComposing || event.keyCode === 229)
      return;
    if (
      ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key) &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp')
        setActive(
          (n) =>
            (n + (event.key === 'ArrowDown' ? 1 : -1) + completion.entries.length) %
            completion.entries.length,
        );
      else insert(completion.entries[active].name);
    }
  };
  useEffect(() => {
    const node = input.current;
    if (!node) return;
    const handle = (event: KeyboardEvent) => key.current(event);
    node.addEventListener('keydown', handle);
    return () => node.removeEventListener('keydown', handle);
  }, [input]);
  return (
    <>
      <span className="contents">
        <textarea
          ref={input}
          rows={1}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-activedescendant={open ? `${id}-${active}` : undefined}
          data-testid={props.testId}
          aria-label={props.label}
          data-key-claim="editor"
          className={props.className}
          value={props.value}
          readOnly={props.readOnly}
          onFocus={() => {
            setFocused(true);
            setCursor(input.current?.selectionStart ?? props.value.length);
            props.onFocus?.();
          }}
          onBlur={() => {
            setFocused(false);
            props.onBlur?.();
          }}
          onChange={(event) => {
            props.onChange(event.target.value);
            setCursor(event.target.selectionStart);
            dismiss('');
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
        />
      </span>
      {open && completion?.kind === 'functions' && (
        <Popover
          anchorRef={input}
          onClose={() => dismiss(queryKey)}
          role="listbox"
          ariaLabel="Sheet functions"
          id={id}
          className="max-h-56 min-w-64 overflow-auto rounded-lg border border-n-200 bg-n-0 shadow-[var(--shadow-lg)]"
        >
          <div data-testid="sheet-completions">
            {completion.entries.map((entry, index) => (
              <button
                type="button"
                role="option"
                tabIndex={-1}
                key={entry.name}
                id={`${id}-${index}`}
                aria-selected={index === active}
                className={`block w-full px-3 py-2 text-left font-mono text-xs ${index === active ? 'bg-cortex-50 text-cortex-700' : 'text-n-700'}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insert(entry.name);
                }}
              >
                {entry.name}
              </button>
            ))}
          </div>
        </Popover>
      )}
      {focused && dismissed !== queryKey && completion?.kind === 'argument' && (
        <Popover
          anchorRef={input}
          onClose={() => dismiss(queryKey)}
          role="group"
          ariaLabel="Function argument"
          className="max-w-80 rounded-lg border border-n-200 bg-n-0 p-2 text-xs text-n-600 shadow-[var(--shadow-lg)]"
        >
          <div data-testid="sheet-arg-hint">
            <span className="font-mono text-n-800">
              {completion.entry.name} · {completion.argument.name}
            </span>{' '}
            — {completion.argument.description}
          </div>
        </Popover>
      )}
    </>
  );
}
