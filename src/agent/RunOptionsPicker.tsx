import { ModelSelector } from '@/components/ai/ModelSelector';
import {
  CLAUDE_CODE_DEFAULT,
  effortLabel,
  isUnset,
  modelLabel,
  modelRefusal,
  type RunChoice,
} from '@/engine/runOptions';
import {
  EFFORT_CHOICES,
  MODEL_CHOICES,
  effortPick,
  modelPick,
  otherModel,
  withEffort,
  withModel,
} from '@/agent/elements/composerModel';

/** What the closed picker reads: "Claude Code default", or "Opus · High". */
export function runChoiceLabel({ model, effort }: RunChoice): string {
  const hasModel = !isUnset(model);
  const hasEffort = !isUnset(effort);
  if (!hasModel && !hasEffort) return CLAUDE_CODE_DEFAULT;
  const modelWords = hasModel ? modelLabel(model as string) : 'Default model';
  return hasEffort ? `${modelWords} · ${effortLabel(effort as string)}` : modelWords;
}

/**
 * The composer's model and effort (M56.5), drawn as the Model Selector
 * (M91.12a): Claude Code's default, the aliases `run-options.v1.json`
 * suggests or any full model name (Other), and the effort levels, as two
 * radio groups in one panel that stays open through a pick. The pick belongs
 * to the conversation, persists with it and beats an addressed agent's
 * record; Rust checks it before a run starts.
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
  appearance = 'label',
  reportedModel = null,
}: {
  value: RunChoice;
  onChange: (next: RunChoice) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  appearance?: 'label' | 'icon';
  reportedModel?: string | null;
}) {
  return (
    <ModelSelector
      testId="run-options"
      label={runChoiceLabel(value)}
      models={MODEL_CHOICES}
      model={modelPick(value)}
      onModelChange={(pick) => onChange(withModel(value, pick))}
      efforts={EFFORT_CHOICES}
      effort={effortPick(value)}
      onEffortChange={(pick) => onChange(withEffort(value, pick))}
      other={{
        defaultValue: otherModel(value),
        validate: modelRefusal,
        onUse: (model) => onChange({ ...value, model }),
        testId: 'run-model-other',
        useTestId: 'run-model-other-use',
      }}
      open={open}
      onOpenChange={onOpenChange}
      appearance={appearance}
      disabled={disabled}
      // WebKit leaves a native button with no explicit tab stop out of the
      // Tab order (the rail's rule, AppRail).
      tabIndex={0}
      className="cb-run-options"
      // M56.5: the model Claude Code last reported answering, as the fold
      // named it, never the one asked for.
      note={
        reportedModel === null ? undefined : (
          <span data-testid="turn-model">
            Last answered by <span className="font-mono">{reportedModel}</span>
          </span>
        )
      }
    />
  );
}
