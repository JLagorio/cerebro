import { useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import {
  CLAUDE_CODE_DEFAULT,
  EFFORT_LEVELS,
  effortLabel,
  isUnset,
  MODEL_SUGGESTIONS,
  modelLabel,
  modelRefusal,
  type RunChoice,
} from '@/engine/runOptions';

/** What the closed picker reads: "Claude Code default", or "Opus · High". */
export function runChoiceLabel({ model, effort }: RunChoice): string {
  const hasModel = !isUnset(model);
  const hasEffort = !isUnset(effort);
  if (!hasModel && !hasEffort) return CLAUDE_CODE_DEFAULT;
  const modelWords = hasModel ? modelLabel(model as string) : 'Default model';
  return hasEffort ? `${modelWords} · ${effortLabel(effort as string)}` : modelWords;
}

/**
 * The composer's model and effort (M56.5): Claude Code's default, the
 * aliases `run-options.v1.json` suggests or any full model name (Other), and
 * the effort levels. The pick belongs to the conversation, persists with it
 * and beats an addressed agent's record; Rust checks it before a run starts.
 *
 * Open state is the caller's, so a failure card's "Choose another model"
 * (M56.4's `choose_model`) can open it.
 */
export function RunOptionsPicker({
  value,
  onChange,
  open,
  onOpenChange,
  disabled = false,
}: {
  value: RunChoice;
  onChange: (next: RunChoice) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const suggested = isUnset(value.model) || MODEL_SUGGESTIONS.some((m) => m.id === value.model);
  const [other, setOther] = useState(suggested ? '' : (value.model ?? ''));
  const refusal = other.trim() === '' ? null : modelRefusal(other.trim());

  const option = (
    testId: string,
    label: string,
    selected: boolean,
    pick: () => void,
  ): React.ReactNode => (
    <button
      key={testId}
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      onClick={pick}
      className={`flex w-full items-center gap-1.5 rounded-md border-0 px-2 py-1 text-left text-xs ${
        selected ? 'bg-surface-selected text-cortex-700' : 'bg-transparent text-n-700'
      } hover:bg-n-50`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && <Icon name="check" size={11} />}
    </button>
  );

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-testid="run-options"
        aria-expanded={open}
        aria-label={`Model and effort: ${runChoiceLabel(value)}`}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        className="inline-flex h-6 max-w-[160px] items-center gap-1 rounded-md border-0 bg-transparent px-1.5 text-2xs text-n-500 hover:bg-n-50 hover:text-n-800 disabled:opacity-50"
      >
        <Icon name="cpu" size={11} />
        <span className="min-w-0 truncate">{runChoiceLabel(value)}</span>
      </button>
      {open && (
        <Popover
          anchorRef={anchorRef}
          onClose={() => onOpenChange(false)}
          ariaLabel="Model and effort"
          className="w-[240px] rounded-lg border border-n-200 bg-n-0 p-1 shadow-[var(--shadow-lg)]"
        >
          <div className="px-2 pb-0.5 pt-1 text-2xs font-medium uppercase tracking-wide text-n-400">
            Model
          </div>
          {option('run-model-default', CLAUDE_CODE_DEFAULT, isUnset(value.model), () =>
            onChange({ ...value, model: null }),
          )}
          {MODEL_SUGGESTIONS.map((m) =>
            option(`run-model-${m.id}`, m.label, value.model === m.id, () =>
              onChange({ ...value, model: m.id }),
            ),
          )}
          <form
            className="flex items-center gap-1 px-2 py-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (other.trim() !== '' && refusal === null) {
                onChange({ ...value, model: other.trim() });
              }
            }}
          >
            <input
              data-testid="run-model-other"
              aria-label="Other model"
              value={other}
              placeholder="Other: a full model name"
              onChange={(e) => setOther(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 font-mono text-2xs text-n-800 outline-none focus-visible:border-cortex-400"
            />
            <button
              type="submit"
              data-testid="run-model-other-use"
              disabled={other.trim() === '' || refusal !== null}
              className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-2xs text-n-700 disabled:opacity-40"
            >
              Use
            </button>
          </form>
          {refusal !== null && (
            <p className="m-0 px-2 pb-1 text-2xs leading-[15px] text-danger-600">{refusal}</p>
          )}
          <div className="mt-1 border-t border-n-100 px-2 pb-0.5 pt-1.5 text-2xs font-medium uppercase tracking-wide text-n-400">
            Effort
          </div>
          {option('run-effort-default', CLAUDE_CODE_DEFAULT, isUnset(value.effort), () =>
            onChange({ ...value, effort: null }),
          )}
          {EFFORT_LEVELS.map((level) =>
            option(`run-effort-${level.id}`, level.label, value.effort === level.id, () =>
              onChange({ ...value, effort: level.id }),
            ),
          )}
        </Popover>
      )}
    </>
  );
}
