import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';

/**
 * The AI controls you can actually see (M18).
 *
 * M17.16 built the rewrite surface and bound it to Cmd-K, and nothing on
 * screen said so. An affordance whose only advertisement is a keystroke is one
 * that exists for the person who wrote it: selecting a paragraph looked exactly
 * like it had before the assistant was built. This is the missing half — the
 * Google-Docs/Notion floating toolbar, which appears when you select prose and
 * disappears when you do not.
 *
 * ## Why the presets are here and not in the popover
 *
 * "Improve writing" and "Make it shorter" are the overwhelming majority of what
 * anyone asks of selected text, and each is one word typed into a box that then
 * has to be submitted. Putting them on the bar collapses three actions into one
 * and, more usefully, TEACHES the feature: a person who has never opened the
 * popover can see what it is for without composing an instruction first.
 *
 * The popover still exists behind "Ask AI" for everything else, and every
 * preset lands in the same per-hunk decision surface — a preset is a
 * pre-written instruction, never a different code path with fewer safeguards.
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
];

export interface SelectionAnchor {
  text: string;
  /** Viewport coordinates of the selection's own box. */
  left: number;
  top: number;
  bottom: number;
}

/**
 * Track the live text selection inside `container`.
 *
 * Null whenever there is nothing useful to act on — collapsed, whitespace, or
 * outside this editor. The last condition is why the container is required:
 * the record panel and a doc are both on screen at once, and a toolbar over
 * the wrong one is worse than none.
 */
export function useSelectionAnchor(
  container: HTMLElement | null,
  enabled: boolean,
): SelectionAnchor | null {
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);

  useEffect(() => {
    if (!enabled || container === null) {
      setAnchor(null);
      return;
    }
    const read = () => {
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        setAnchor(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setAnchor(null);
        return;
      }
      const text = selection.toString();
      if (text.trim() === '') {
        setAnchor(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setAnchor({ text, left: rect.left, top: rect.top, bottom: rect.bottom });
    };
    // `selectionchange` on the document rather than mouseup on the editor:
    // keyboard selection (shift-arrow, Cmd-A) is a selection too, and a
    // mouseup binding is the reason so many editors only show their toolbar
    // for mouse users.
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [container, enabled]);

  return anchor;
}

export function SelectionToolbar({
  anchor,
  onAsk,
  onPreset,
}: {
  anchor: SelectionAnchor;
  onAsk: () => void;
  onPreset: (preset: Preset) => void;
}) {
  const [more, setMore] = useState(false);
  // Above the selection when there is room, below it when there is not —
  // a toolbar covering the text you are about to change is a toolbar you
  // have to move the selection to read past.
  const above = anchor.top > 56;
  return (
    <div
      data-testid="selection-toolbar"
      role="toolbar"
      aria-label="Selection actions"
      // Selecting text and then clicking must not collapse the selection
      // before the handler runs — the whole feature depends on the range
      // still being there when the popover reads it.
      onMouseDown={(e) => e.preventDefault()}
      className="fixed z-[58] flex items-center gap-0.5 rounded-lg bg-n-900 p-1 shadow-[var(--shadow-lg)]"
      style={{
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - 320)),
        top: above ? anchor.top - 42 : anchor.bottom + 8,
      }}
    >
      <button
        type="button"
        data-testid="selection-ask-ai"
        onClick={onAsk}
        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs font-medium text-n-0 hover:bg-n-700"
      >
        <Icon name="sparkles" size={13} color="var(--synapse-400)" />
        Ask AI
      </button>
      <span className="mx-0.5 h-4 w-px bg-n-700" />
      {PRESETS.slice(0, 2).map((preset) => (
        <button
          key={preset.label}
          type="button"
          data-testid="selection-preset"
          title={preset.instruction}
          onClick={() => onPreset(preset)}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs font-medium text-n-0 hover:bg-n-700"
        >
          <Icon name={preset.icon} size={13} />
          {preset.label.replace('Make it ', '')}
        </button>
      ))}
      <button
        type="button"
        aria-label="More AI actions"
        aria-expanded={more}
        onClick={() => setMore((v) => !v)}
        className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-n-0 hover:bg-n-700"
      >
        <Icon name="ellipsis" size={14} />
      </button>
      {more && (
        <div className="absolute right-0 top-full mt-1 flex min-w-[196px] flex-col rounded-lg border border-n-200 bg-n-0 p-1 shadow-[var(--shadow-lg)]">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              data-testid="selection-preset"
              onClick={() => onPreset(preset)}
              className="flex h-7 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-xs text-n-700 hover:bg-n-50"
            >
              <Icon name={preset.icon} size={13} color="var(--synapse-500)" />
              {preset.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
