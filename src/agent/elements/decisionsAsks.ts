import {
  ASK_BASE_LABEL,
  askAssistantLabel,
  askBasePrompt,
  askedAbout,
  AUGMENT_LABEL,
  augmentDocPrompt,
  conceptAsk,
  DISTILL_LABEL,
  distillPrompt,
  fetchRefsLabel,
  fetchRefsPrompt,
  ORGANIZE_LABEL,
  organizePrompt,
  type MeetingAsk,
} from '@/lib/prompts';

/**
 * The asks a surface offers (M91.14), as the Suggestion element draws them:
 * one press hands the Assistant a prompt. The label is what the person sees,
 * on the button and in the bubble the ask leaves in the transcript; the
 * prompt, often pages long, is what the agent is sent (`lib/prompts.ts`
 * defines each label beside its prompt). A page the ask is about travels with
 * it as a context chip (M17.6), so the agent reads that page rather than
 * whatever the person happened to be standing on.
 *
 * Nothing here sends: `askAgent` is the one door an ask goes through, and an
 * ask is only ever a person's press (M8.1: nothing speaks first).
 */

/** One ask: what it says, what it sends, and what it is about. */
export interface Ask {
  /** The button's words. */
  label: string;
  /** What the agent is sent. */
  prompt: string;
  /** The page the ask is about, carried as a context chip; null for none. */
  subject: string | null;
  /** The transcript's bubble: the act and the page's name. Null when the
   *  words are the person's own, and the bubble is the prompt itself. */
  bubble: string | null;
}

/** `uiStore.askAgent`, the one door an ask goes through. */
export type AskAgent = (text: string, subject?: string | null, label?: string | null) => void;

/** A page an ask is about: its path, and the name the bubble calls it. */
export interface AskedPage {
  path: string;
  title: string;
}

/**
 * What a Suggestion hears when pressed: it hands back the prompt it was
 * given, and that prompt goes through the door with the ask's subject and
 * bubble.
 */
export function sendAsk(ask: Ask, askAgent: AskAgent): (prompt: string) => void {
  return (prompt) => askAgent(prompt, ask.subject, ask.bubble);
}

/** An ask about one page, named in the bubble by the act and the page. */
function pageAsk(label: string, prompt: string, page: AskedPage): Ask {
  return { label, prompt, subject: page.path, bubble: askedAbout(label, page.title) };
}

/**
 * The one ask a concept offers (M52.3): a recheck once its date has passed, a
 * revision otherwise. The review bar and the concept page's menu both offer
 * it, so the two name and send one act.
 */
export function conceptAskOf(concept: AskedPage & { stale: boolean }): Ask {
  const act = conceptAsk(concept);
  return pageAsk(act.label, act.text, concept);
}

/** What the base holds about a page, asked of the base (M33a.5). */
export function askBaseAsk(page: AskedPage): Ask {
  return pageAsk(ASK_BASE_LABEL, askBasePrompt(page.path, page.title), page);
}

/** What a draft is missing against what the vault holds (M8.3). */
export function augmentAsk(page: AskedPage): Ask {
  return pageAsk(AUGMENT_LABEL, augmentDocPrompt(page.path, page.title), page);
}

/** Learn from a page: the distil step, the one ask that writes (M52.3). */
export function distillAsk(page: AskedPage): Ask {
  return pageAsk(DISTILL_LABEL, distillPrompt(page.path, page.title), page);
}

/**
 * A page's Knowledge asks (M52.3), in the order its rows draw them: the two
 * that only read first, the one that writes last.
 */
export function pageKnowledgeAsks(page: AskedPage): readonly [Ask, Ask, Ask] {
  return [askBaseAsk(page), augmentAsk(page), distillAsk(page)];
}

/** An Inbox capture's filing ask (M7); a meeting transcript gets the meeting
 *  ask, with its speakers as matched now (M64.7). */
export function organizeAsk(capture: AskedPage, meeting?: MeetingAsk): Ask {
  return pageAsk(ORGANIZE_LABEL, organizePrompt(capture.path, meeting), capture);
}

/**
 * The fetch a capture's uncached references offer (M8.2): one ask for all of
 * them, counted in its label. `labels[i]`, when set, is the name `ids[i]`'s
 * own link carries (M69.2).
 */
export function fetchRefsAsk(
  capture: AskedPage,
  ids: readonly string[],
  labels: readonly (string | null | undefined)[] = [],
): Ask {
  return pageAsk(fetchRefsLabel(ids.length), fetchRefsPrompt(capture.path, ids, labels), capture);
}

/**
 * Quick Open's ask row (M42.5): the typed words are the prompt AND the
 * bubble, because they are the person's own; the row's label says where they
 * go. It is about no page.
 */
export function quickOpenAsk(query: string): Ask {
  return { label: askAssistantLabel(query), prompt: query, subject: null, bubble: null };
}
