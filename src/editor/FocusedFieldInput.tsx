import { useEffect, useId, useRef } from 'react';
import type { DocumentKey } from './documentOwner';
import type { FieldValidator, FieldWriter } from './fieldSaveParticipant';
import { useFieldSaveParticipant, fieldPresentationCount } from './useFieldSaveParticipant';
import { AnchoredFieldStatus } from '@/detail/AnchoredFieldStatus';

/** A presentation of a retained field participant. It owns no additional writer. */
type FieldInputProps = {
  identity: DocumentKey;
  initial: string;
  validate: FieldValidator;
  write: FieldWriter;
  label: string;
  onEnd: () => void;
  floating?: boolean;
  inputType?: 'text' | 'email' | 'tel';
  pendingText?: string;
  className?: string;
};
export function FocusedFieldInput(props: FieldInputProps) {
  const field = useFieldSaveParticipant(props.identity, props.initial, props.validate, props.write);
  if (field.kind === 'deferred') return <span role="status">{field.message}</span>;
  return <ReadyFieldInput {...props} field={field} />;
}
function ReadyFieldInput({
  label,
  onEnd,
  floating = true,
  inputType = 'text',
  pendingText = 'Saving…',
  className,
  field,
}: FieldInputProps & {
  field: Extract<ReturnType<typeof useFieldSaveParticipant>, { kind: 'ready' }>;
}) {
  const { owner, state, error } = field;
  const input = useRef<HTMLInputElement>(null),
    ended = useRef(false);
  const end = useRef(onEnd);
  end.current = onEnd;
  const status = useId();
  const pending = state.inFlightGeneration !== null;
  const finish = () => {
    if (!ended.current) {
      ended.current = true;
      end.current();
    }
  };
  useEffect(() => {
    if (
      state.generation > 0 &&
      state.generation === state.acknowledgedGeneration &&
      !pending &&
      state.failure === null
    ) {
      if (!ended.current) {
        ended.current = true;
        end.current();
      }
    }
  }, [state, pending]);
  const commit = (keyboard = false) => {
    if (ended.current) return;
    const field = input.current,
      grid = field?.closest<HTMLElement>('[role="grid"]');
    void owner.flush().then((result) => {
      if (result.kind === 'clean' || result.kind === 'committed') {
        finish();
        if (
          keyboard &&
          (document.activeElement === field || document.activeElement === document.body)
        )
          queueMicrotask(() => grid?.focus());
      }
    });
  };
  return (
    <span className="relative flex min-w-0 max-w-full flex-1 flex-col gap-1" aria-busy={pending}>
      <span className="flex min-w-0 max-w-full items-center gap-2">
        <input
          ref={input}
          autoFocus
          type={inputType}
          aria-label={label}
          aria-invalid={error !== null || undefined}
          aria-busy={pending || undefined}
          aria-describedby={pending || error !== null ? status : undefined}
          readOnly={pending}
          value={state.latestDraft}
          onChange={(event) => owner.edit(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onBlur={() => {
            if (owner.snapshot().failure === null) commit();
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              commit(true);
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              if (
                owner.snapshot().inFlightGeneration === null &&
                (fieldPresentationCount(owner) > 1 || owner.discard())
              ) {
                const grid = input.current?.closest<HTMLElement>('[role="grid"]');
                finish();
                grid?.focus();
              }
            }
          }}
          className={
            className ??
            'min-h-7 w-full min-w-0 rounded-md border border-cortex-500 bg-surface-raised px-1.5 text-ui text-n-900 shadow-[var(--ring)] outline-none'
          }
        />
        {error !== null && (
          <button
            type="button"
            aria-label={`Retry saving ${label}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              commit();
            }}
            className="flex-none text-xs text-n-700 underline"
          >
            Retry
          </button>
        )}
      </span>
      <AnchoredFieldStatus anchor={input} id={status} error={error !== null} floating={floating}>
        {pending ? pendingText : error}
      </AnchoredFieldStatus>
    </span>
  );
}
