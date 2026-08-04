import { useState } from 'react';
import {
  FormattingToolbar,
  FormattingToolbarController,
  getFormattingToolbarItems,
  useComponentsContext,
} from '@blocknote/react';
import { Icon } from '@/components/ui/Icon';

/**
 * The AI controls you can actually see (M18).
 *
 * M17.16 built the rewrite surface and bound it to Cmd-K, and nothing on
 * screen said so. An affordance whose only advertisement is a keystroke is one
 * that exists for the person who wrote it: selecting a paragraph looked exactly
 * as it had before the assistant was built.
 *
 * ## Inside BlockNote's toolbar, not beside it
 *
 * The first version of this floated its own dark pill on selection — and
 * BlockNote already floats one, so selecting a sentence produced TWO bars
 * fighting for the same few pixels. Bold and Ask AI are the same kind of act
 * ("do this to what I selected"), so they belong on the same bar, with AI
 * first because it is the one you came for.
 *
 * ## Why the presets are here and not only in the popover
 *
 * "Improve writing" and "Make it shorter" are the overwhelming majority of what
 * anyone asks of selected text, and each is one word typed into a box that then
 * has to be submitted. Putting them on the bar collapses three actions into one
 * and, more usefully, TEACHES the feature: someone who has never opened the
 * popover can see what it is for without composing an instruction first.
 *
 * Every preset lands in the same per-hunk decision surface — a preset is a
 * pre-written instruction, never a different path with fewer safeguards.
 */

export interface Preset {
  label: string;
  icon: string;
  /** Sent verbatim as the instruction, so what a preset does is readable. */
  instruction: string;
}

export const PRESETS: Preset[] = [
  {
    label: 'Improve writing',
    icon: 'wand-sparkles',
    instruction: 'Improve the writing. Keep the meaning, the voice and the formatting.',
  },
  {
    label: 'Make it shorter',
    icon: 'minimize-2',
    instruction: 'Make it shorter without dropping a fact or a caveat.',
  },
  {
    label: 'Fix spelling & grammar',
    icon: 'spell-check',
    instruction:
      'Fix spelling, grammar and punctuation. Change nothing else — not the wording, not the tone.',
  },
  {
    label: 'As action items',
    icon: 'list-checks',
    instruction:
      'Rewrite this as a markdown checklist of concrete action items, one per line, starting each with "- [ ] ". Drop anything that is not something to do.',
  },
  {
    label: 'Summarize',
    icon: 'text-quote',
    instruction: 'Replace the passage with a two-sentence summary of it.',
  },
];

/**
 * The formatting toolbar, with AI at its head.
 *
 * `ask` receives the preset the user chose, or undefined for "open the box and
 * let me type". The caller captures the selection — this component never reads
 * it, because by the time a click handler runs the range still exists but the
 * moment focus moves it will not.
 */
export function AiFormattingToolbar({ onAsk }: { onAsk: (preset?: Preset) => void }) {
  return (
    <FormattingToolbarController
      formattingToolbar={() => (
        <FormattingToolbar>
          <AiToolbarButtons key="cerebro-ai" onAsk={onAsk} />
          {/* Everything BlockNote would have rendered on its own. Listed after
              the AI group rather than replaced: this is an addition to the
              editor's toolbar, not a fork of it. */}
          {getFormattingToolbarItems()}
        </FormattingToolbar>
      )}
    />
  );
}

function AiToolbarButtons({ onAsk }: { onAsk: (preset?: Preset) => void }) {
  const Components = useComponentsContext();
  const [more, setMore] = useState(false);
  if (Components === undefined) return null;
  const Button = Components.FormattingToolbar.Button;

  return (
    <>
      <Button
        className="bn-button"
        data-testid="selection-ask-ai"
        label="Ask AI"
        mainTooltip="Ask AI about the selection"
        onClick={() => onAsk()}
      >
        {/* The icon is in the children rather than in `icon`, which the
            Mantine button only honours for a label-only button. */}
        <span className="inline-flex items-center gap-1.5">
          <Icon name="sparkles" size={14} color="var(--synapse-500)" />
          Ask AI
        </span>
      </Button>
      {PRESETS.slice(0, 2).map((preset) => (
        <Button
          key={preset.label}
          className="bn-button"
          data-testid="selection-preset"
          label={preset.label}
          mainTooltip={preset.instruction}
          icon={<Icon name={preset.icon} size={14} />}
          onClick={() => onAsk(preset)}
        />
      ))}
      <span className="relative inline-flex">
        <Button
          className="bn-button"
          label="More AI actions"
          mainTooltip="More AI actions"
          icon={<Icon name="chevron-down" size={13} />}
          isSelected={more}
          onClick={() => setMore((v) => !v)}
        />
        {more && (
          <div
            data-testid="selection-more"
            className="absolute left-0 top-full z-[60] mt-1 flex min-w-[204px] flex-col rounded-lg border border-n-200 bg-n-0 p-1 shadow-[var(--shadow-lg)]"
          >
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                data-testid="selection-preset"
                title={preset.instruction}
                // The selection has to survive the click, and mousedown is
                // where it would be lost.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setMore(false);
                  onAsk(preset);
                }}
                className="flex h-7 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-xs text-n-700 hover:bg-n-50"
              >
                <Icon name={preset.icon} size={13} color="var(--synapse-500)" />
                {preset.label}
              </button>
            ))}
          </div>
        )}
      </span>
      <span className="mx-1 h-4 w-px flex-none self-center bg-n-200" aria-hidden="true" />
    </>
  );
}
