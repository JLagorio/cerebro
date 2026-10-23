import { describe, expect, it, vi } from 'vitest';
import {
  askBaseAsk,
  augmentAsk,
  conceptAskOf,
  distillAsk,
  fetchRefsAsk,
  organizeAsk,
  pageKnowledgeAsks,
  quickOpenAsk,
  sendAsk,
} from '@/agent/elements/decisionsAsks';
import {
  ASK_BASE_LABEL,
  askBasePrompt,
  AUGMENT_LABEL,
  augmentDocPrompt,
  DISTILL_LABEL,
  distillPrompt,
  fetchRefsPrompt,
  ORGANIZE_LABEL,
  organizePrompt,
  RECHECK_LABEL,
  REVISE_LABEL,
  reviewConceptPrompt,
  reviseConceptPrompt,
} from '@/lib/prompts';

/**
 * The asks' view model (M91.14): a Suggestion shows the label and sends the
 * prompt, the page it is about rides along as its subject, and the bubble
 * names the act and the page — never the prompt behind them.
 */

const PAGE = { path: 'records/plan.md', title: 'The plan' };

describe('an ask', () => {
  it('shows its label and sends its prompt, about its page', () => {
    const ask = askBaseAsk(PAGE);
    expect(ask).toEqual({
      label: ASK_BASE_LABEL,
      prompt: askBasePrompt(PAGE.path, PAGE.title),
      subject: PAGE.path,
      bubble: `${ASK_BASE_LABEL} · The plan`,
    });
    expect(ask.prompt).not.toBe(ask.label);
  });

  it('goes through the one door with its subject and bubble, sending what the press hands back', () => {
    const askAgent = vi.fn();
    const ask = distillAsk(PAGE);
    sendAsk(ask, askAgent)(ask.prompt);
    expect(askAgent).toHaveBeenCalledWith(
      distillPrompt(PAGE.path, PAGE.title),
      PAGE.path,
      `${DISTILL_LABEL} · The plan`,
    );
  });

  it('lists a page’s Knowledge asks with the two that read before the one that writes', () => {
    expect(pageKnowledgeAsks(PAGE).map((ask) => ask.label)).toEqual([
      ASK_BASE_LABEL,
      AUGMENT_LABEL,
      DISTILL_LABEL,
    ]);
    expect(augmentAsk(PAGE).prompt).toBe(augmentDocPrompt(PAGE.path, PAGE.title));
  });

  it('asks a concept for a recheck once it is due, and a revision otherwise', () => {
    const concept = { path: 'knowledge/a.md', title: 'A' };
    const due = conceptAskOf({ ...concept, stale: true });
    expect(due.label).toBe(RECHECK_LABEL);
    expect(due.prompt).toBe(reviewConceptPrompt(concept.path, concept.title));
    expect(due.bubble).toBe(`${RECHECK_LABEL} · A`);
    const current = conceptAskOf({ ...concept, stale: false });
    expect(current.label).toBe(REVISE_LABEL);
    expect(current.prompt).toBe(reviseConceptPrompt(concept.path, concept.title));
    expect(current.subject).toBe(concept.path);
  });

  it('files a capture by the plain ask, or a transcript by the meeting ask', () => {
    expect(organizeAsk(PAGE)).toMatchObject({
      label: ORGANIZE_LABEL,
      prompt: organizePrompt(PAGE.path),
      bubble: `${ORGANIZE_LABEL} · The plan`,
    });
    const meeting = { title: 'Standup', speakers: null };
    expect(organizeAsk(PAGE, meeting).prompt).toBe(organizePrompt(PAGE.path, meeting));
  });

  it('counts the references a fetch asks for in its label', () => {
    const one = fetchRefsAsk(PAGE, ['ENG-1']);
    expect(one.label).toBe('Fetch 1 reference');
    expect(one.bubble).toBe('Fetch 1 reference · The plan');
    const two = fetchRefsAsk(PAGE, ['ENG-1', 'https://x.test/a'], [null, 'A page']);
    expect(two.label).toBe('Fetch 2 references');
    expect(two.prompt).toBe(
      fetchRefsPrompt(PAGE.path, ['ENG-1', 'https://x.test/a'], [null, 'A page']),
    );
  });

  it('sends the person’s own words from Quick Open, about no page', () => {
    expect(quickOpenAsk('why is it late')).toEqual({
      label: 'Ask the Assistant: why is it late',
      prompt: 'why is it late',
      subject: null,
      bubble: null,
    });
  });
});
