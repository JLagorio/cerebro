import { useLayoutEffect, useState, type RefObject } from 'react';
import { create } from 'zustand';
import { useMessageScrollerIfAny } from '@/components/ai/MessageScroller';

/**
 * A step a person asked to see (M92.4): a rail row's jump to its call's line
 * in the conversation's transcript. The row asks (`revealStep`) and the line
 * takes the ask once: it opens (the step's `useStepOpen` honours the `open`
 * it is handed), the transcript's scroller brings it to the top in one
 * settling jump, and it takes focus. Only a line the transcript's scroller
 * holds takes an ask: a run's detail (RunTranscript) draws the same calls
 * with no scroller, and its lines neither throw nor move. Memory only.
 */

interface StepRevealState {
  /** The call to show, and which ask this is, so asking for the same call
   *  twice shows it twice. A newer ask replaces it. */
  asked: { toolId: string; ask: number } | null;
  reveal: (toolId: string) => void;
  /** The line took `ask`: it is spent. */
  taken: (ask: number) => void;
}

let asks = 0;

export const useStepRevealStore = create<StepRevealState>((set) => ({
  asked: null,
  reveal: (toolId) => {
    asks += 1;
    set({ asked: { toolId, ask: asks } });
  },
  taken: (ask) => set((state) => (state.asked?.ask === ask ? { asked: null } : state)),
}));

/** Ask the transcript to show the line of the call `toolId`. */
export function revealStep(toolId: string): void {
  useStepRevealStore.getState().reveal(toolId);
}

/** What takes focus without help: a link, a control, or an element given a
 *  tab index of its own. */
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';

/**
 * Focus `target` as a jump lands on it. Where the transcript's scroller
 * `placed` it, without scrolling, since the browser's own scroll into view
 * would move it again; where nothing placed it, the browser brings it into
 * view. A target that is no control of its own (a line with nothing to open,
 * a card whose answers are on their way) takes focus through a tab index it
 * holds only until focus leaves it, so it never becomes a stop the reader
 * tabs through.
 */
export function focusRevealed(target: HTMLElement, placed = true): void {
  if (!target.matches(FOCUSABLE)) {
    target.setAttribute('tabindex', '-1');
    target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
  }
  target.focus({ preventScroll: placed });
}

/** A step line's own control: the fold its row opens with, first in it. */
const LINE_CONTROL = '[data-slot="trace-collapsible-trigger"]';

/**
 * The step `toolId`'s side of a reveal, for the renderer that draws it, with
 * `line` its root: the open state to hand the step, which an ask opens and
 * the reader's own fold changes from then on (left unset, the step keeps
 * its own rule), and, after the render that opened it, one settling jump to
 * the line and focus on its fold, or on the line where it has none.
 */
export function useRevealedStep(
  toolId: string,
  line: RefObject<HTMLElement | null>,
): { open: boolean | undefined; onOpenChange: (open: boolean) => void } {
  const scroller = useMessageScrollerIfAny();
  const ask = useStepRevealStore((state) =>
    scroller !== null && state.asked?.toolId === toolId ? state.asked.ask : null,
  );
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  // The ask opens the line in the render it arrives in, so the jump below
  // lands on a line already drawn open.
  const [opened, setOpened] = useState<number | null>(null);
  if (ask !== null && ask !== opened) {
    setOpened(ask);
    setOpen(true);
  }
  useLayoutEffect(() => {
    if (ask === null || scroller === null) return;
    const element = line.current;
    if (element !== null) {
      const placed = scroller.scrollToElement(element);
      focusRevealed(element.querySelector<HTMLElement>(LINE_CONTROL) ?? element, placed);
    }
    useStepRevealStore.getState().taken(ask);
  }, [ask, scroller, line]);
  return { open, onOpenChange: setOpen };
}
