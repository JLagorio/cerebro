import type { Concept } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import {
  ASK_BASE_LABEL,
  askBasePrompt,
  askedAbout,
  AUGMENT_LABEL,
  augmentDocPrompt,
  conceptAsk,
  DISTILL_LABEL,
  distillPrompt,
} from '@/lib/prompts';

/**
 * The empty conversation's starters (M50.4, M91.12a), for its Suggestions:
 * what each row says, and what pressing it sends. Pure.
 */

/** A starter: what its row says, and — when it is not the same — what is
 *  sent (a structured prompt the label summarizes) and what the bubble says
 *  it was (M52.3: the act and the page, as every surface names it). */
export interface Starter {
  label: string;
  prompt?: string;
  asked?: string;
}

/** Where nothing is open: the same three everywhere. */
export const STARTERS: readonly Starter[] = [
  { label: 'What is at risk right now?' },
  { label: 'Help me clear the Inbox' },
  { label: 'What do you know about this vault?' },
];

/** A page's starter: the act's one label on the row, the page's title in
 *  the bubble it leaves — the same words the surface's own button sends. */
function pageAct(page: Entry, label: string, prompt: string): Starter {
  return { label, prompt, asked: askedAbout(label, page.title) };
}

/**
 * Starters from the page you are on (M50.4). The panel offered the same three
 * everywhere, so opening it beside a concept asked about the Inbox. A page
 * gets the questions its own surfaces already ask — what Knowledge says about
 * it, what it is missing, learning from it — and a concept gets its own:
 * the one ask its review bar offers (M52.3 — a recheck only when it is due,
 * and none once it has been replaced).
 */
export function pageStarters(page: Entry | null, concept: Concept | null): readonly Starter[] {
  if (page === null) return STARTERS;
  if (concept !== null) {
    const act =
      concept.supersededBy === null
        ? conceptAsk({ path: page.path, title: concept.title, stale: concept.stale })
        : null;
    return [
      pageAct(
        page,
        'What supports this concept?',
        `What in this vault supports or contradicts the concept at ${page.path} ("${concept.title}")? Cite the pages.`,
      ),
      ...(act === null ? [] : [pageAct(page, act.label, act.text)]),
      { label: 'What do you know about this vault?' },
    ];
  }
  return [
    pageAct(page, ASK_BASE_LABEL, askBasePrompt(page.path, page.title)),
    pageAct(page, AUGMENT_LABEL, augmentDocPrompt(page.path, page.title)),
    pageAct(page, DISTILL_LABEL, distillPrompt(page.path, page.title)),
  ];
}

/** What pressing a starter sends: the bubble's words, and the prompt the
 *  agent reads when it is not the label. The row shows the label alone. */
export function starterSend(starter: Starter): { text: string; prompt?: string } {
  const text = starter.asked ?? starter.label;
  return starter.prompt === undefined ? { text } : { text, prompt: starter.prompt };
}
