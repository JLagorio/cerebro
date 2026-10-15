import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortMockAnswer,
  ANSWER_THE_QUESTION,
  answeredText,
  answerMockInteraction,
  cancelMockInteraction,
  confirmMockInteraction,
  DECLINED,
  declinedText,
  EDIT_MISFIT,
  finishMockAnswer,
  listMockInteractions,
  MALFORMED_ARGUMENTS,
  markMockQuestion,
  mockAsks,
  mockQuestions,
  NO_LONGER_WAITING,
  NOT_A_QUESTION,
  registerMockInteraction,
  resetMockInteractions,
  settleMockSession,
  STALE,
} from '@/agent/mockInteractions';
import CASES from '../../src-tauri/fixtures/question-answers.json';
import type { QuestionAnswer } from '@/engine/questionForm';
import { questionMalformed } from '@/lib/policy/toolApproval';

/**
 * The browser's ask seam (M57.1) mirrors Rust's book: these are the rules
 * `src-tauri/src/agent/interaction.rs` tests, in the mock's terms, and its
 * words are Rust's own.
 */

const RUST = readFileSync(join(__dirname, '../../src-tauri/src/agent/interaction.rs'), 'utf8');

const seam = globalThis as { __cerebroMockAsk?: unknown };

beforeEach(() => resetMockInteractions());
afterEach(() => {
  delete seam.__cerebroMockAsk;
});

/** A registered, confirmed card in `vault`. */
function waiting(vault = '/v', session = 's-1', tool = 't-1', resume = vi.fn()) {
  const id = registerMockInteraction(
    vault,
    session,
    tool,
    'append_to_note',
    JSON.stringify({ path: 'notes/inbox.md', content: 'x' }),
    resume,
  );
  const card = confirmMockInteraction(id);
  if (card === null) throw new Error('a confirmed card');
  return card;
}

describe('the mock ask seam', () => {
  it('asks only for the tools the seam names', () => {
    expect(mockAsks('append_to_note')).toBe(false);
    seam.__cerebroMockAsk = ['append_to_note'];
    expect(mockAsks('append_to_note')).toBe(true);
    expect(mockAsks('mcp__cerebro__append_to_note')).toBe(true);
    expect(mockAsks('edit_note')).toBe(false);
    seam.__cerebroMockAsk = ['mcp__cerebro__edit_note'];
    expect(mockAsks('edit_note')).toBe(true);
    seam.__cerebroMockAsk = 'append_to_note';
    expect(mockAsks('append_to_note')).toBe(false);
  });

  it('draws a confirmed call as a card, once', () => {
    const card = waiting();
    expect(card).toMatchObject({
      kind: 'permission',
      tool_name: 'append_to_note',
      tool_id: 't-1',
      session_id: 's-1',
      summary: 'append to note · notes/inbox.md',
    });
    expect(card.id).toMatch(/^[0-9a-f]{32}$/);
    expect(card.input).toContain('"path": "notes/inbox.md"');
    expect(confirmMockInteraction(card.id)).toBeNull();
  });

  it('takes one answer at a time', () => {
    const resume = vi.fn();
    const card = waiting('/v', 's-1', 't-1', resume);
    const first = answerMockInteraction('/v', card.id);
    expect('resume' in first && first.resume).toBe(resume);
    expect(answerMockInteraction('/v', card.id)).toEqual({
      refused: { code: NO_LONGER_WAITING, message: STALE },
    });
    // A resume that could not start puts the card back.
    abortMockAnswer(card.id);
    expect(listMockInteractions('/v')).toEqual([card]);
    expect('resume' in answerMockInteraction('/v', card.id)).toBe(true);
    finishMockAnswer(card.id);
    expect(listMockInteractions('/v')).toEqual([]);
  });

  it('refuses a stale answer no_longer_waiting, in Rust’s words', () => {
    expect(RUST).toContain(`pub const NO_LONGER_WAITING: &str = "${NO_LONGER_WAITING}";`);
    expect(RUST).toContain(`pub const STALE: &str = "${STALE}";`);
    expect(RUST).toContain(`const DECLINED: &str = "${DECLINED}";`);
    const card = waiting();
    expect(answerMockInteraction('/elsewhere', card.id)).toEqual({
      refused: { code: NO_LONGER_WAITING, message: STALE },
    });
    expect(answerMockInteraction('/v', 'no-such-card')).toHaveProperty('refused');
    cancelMockInteraction(card.id);
    expect(answerMockInteraction('/v', card.id)).toHaveProperty('refused');
  });

  it('cancels idempotently', () => {
    const card = waiting();
    expect(cancelMockInteraction(card.id)).toBe(true);
    expect(cancelMockInteraction(card.id)).toBe(false);
    expect(cancelMockInteraction('no-such-card')).toBe(false);
    expect(listMockInteractions('/v')).toEqual([]);
  });

  it('lists the waiting cards of one vault, oldest first', () => {
    const first = waiting('/v', 's-1', 't-1');
    const elsewhere = waiting('/w', 's-2', 't-1');
    const second = waiting('/v', 's-3', 't-1');
    // Registered but never confirmed is no card.
    registerMockInteraction('/v', 's-4', 't-1', 'edit_note', '{}', vi.fn());
    expect(listMockInteractions('/v')).toEqual([first, second]);
    expect(listMockInteractions('/w')).toEqual([elsewhere]);
  });

  it('refuses an unanswered call when its thread sends again', () => {
    const left = waiting('/v', 's-1', 't-1');
    const stopped = waiting('/v', 's-1', 't-2');
    cancelMockInteraction(stopped.id);
    const other = waiting('/v', 's-2', 't-1');
    expect(settleMockSession('s-1').sort()).toEqual(['t-1', 't-2']);
    expect(listMockInteractions('/v')).toEqual([other]);
    expect(answerMockInteraction('/v', left.id)).toHaveProperty('refused');
    expect(settleMockSession('s-1')).toEqual([]);
  });

  it('words a deny as Rust does, the person’s reason after', () => {
    expect(declinedText({ kind: 'deny' })).toBe(DECLINED);
    expect(declinedText({ kind: 'deny', message: '  not today  ' })).toBe(
      `${DECLINED} They said: not today`,
    );
    expect(RUST).toContain('format!("{DECLINED} They said: {said}")');
  });
});

describe('the mock question card (M57.3)', () => {
  const FORMAT = {
    questions: [
      {
        question: 'Which format?',
        header: 'Format',
        options: [{ label: 'Markdown' }, { label: 'Plain text' }],
      },
      {
        question: 'Which sections?',
        header: 'Sections',
        multiSelect: true,
        options: [{ label: 'Summary' }, { label: 'Risks' }, { label: 'Next steps' }],
      },
    ],
  };

  /** A confirmed question card in /v, as the mock agent registers one. */
  function asked(resume = vi.fn()) {
    const read = mockQuestions(FORMAT);
    if (!('questions' in read)) throw new Error(read.deny);
    const id = registerMockInteraction(
      '/v',
      's-1',
      't-1',
      'AskUserQuestion',
      JSON.stringify(FORMAT),
      resume,
    );
    const card = confirmMockInteraction(id);
    if (card === null) throw new Error('a confirmed card');
    markMockQuestion(card, read.questions);
    return card;
  }

  const answers = (format: string[], sections: string[]): QuestionAnswer[] => [
    { question: 'Which format?', picked: format, other: null },
    { question: 'Which sections?', picked: sections, other: null },
  ];

  it('carries a question payload on its card, and the book lists it', () => {
    const card = asked();
    expect(card.kind).toBe('question');
    expect(card.questions?.map((q) => q.question)).toEqual(['Which format?', 'Which sections?']);
    expect(card.questions?.[1].multiSelect).toBe(true);
    expect(listMockInteractions('/v')).toEqual([card]);
  });

  it('refuses a malformed set in Rust’s words, so no card shows', () => {
    const refused = mockQuestions({ questions: [{ question: 'Which release?', options: [] }] });
    expect(refused).toEqual({
      deny: questionMalformed('"Which release?" offers 0 options; a question offers 2 to 4.'),
    });
    expect('deny' in refused && refused.deny).toBe(
      'Cerebro couldn\'t show this question ("Which release?" offers 0 options; a question offers 2 to 4). Ask again with 1 to 4 questions, each with 2 to 4 distinct options.',
    );
    // Every refused parse case refuses here too.
    for (const c of CASES.parse_cases) {
      if (typeof c.refused === 'string') {
        expect(mockQuestions(c.input), c.why).toEqual({ deny: questionMalformed(c.refused) });
      }
    }
  });

  it('takes answers as the shared cases say, and refuses a misfit with the card still waiting', () => {
    const card = asked();
    for (const [answer, words] of [
      [answers(['HTML'], ['Risks']), '"HTML" is not an option of "Which format?".'],
      [answers(['Markdown'], []), 'Answer every question: "Which sections?" has no answer.'],
    ] as const) {
      expect(
        answerMockInteraction('/v', card.id, { kind: 'answers', answers: [...answer] }),
      ).toEqual({ refused: { code: MALFORMED_ARGUMENTS, message: words } });
      expect(listMockInteractions('/v')).toEqual([card]);
    }
    expect(answerMockInteraction('/v', card.id, { kind: 'allow' })).toEqual({
      refused: { code: MALFORMED_ARGUMENTS, message: ANSWER_THE_QUESTION },
    });
    const taken = answerMockInteraction('/v', card.id, {
      kind: 'answers',
      answers: answers(['Markdown'], ['Summary', 'Risks']),
    });
    expect('resume' in taken).toBe(true);
    expect(RUST).toContain(`pub const ANSWER_THE_QUESTION: &str = "${ANSWER_THE_QUESTION}";`);
    expect(RUST).toContain(`pub const NOT_A_QUESTION: &str = "${NOT_A_QUESTION}";`);
  });

  it('takes no answers for a card that asks no question', () => {
    const card = waiting();
    expect(
      answerMockInteraction('/v', card.id, {
        kind: 'answers',
        answers: answers(['Markdown'], ['Risks']),
      }),
    ).toEqual({ refused: { code: MALFORMED_ARGUMENTS, message: NOT_A_QUESTION } });
    expect(answerMockInteraction('/v', card.id, { kind: 'deny' })).toHaveProperty('resume');
  });

  it('names the labels as given in what the resume tells the model', () => {
    expect(answeredText({ 'Which format?': 'Markdown', 'Which sections?': 'Summary, Risks' })).toBe(
      'User has answered your questions: "Which format?"="Markdown", "Which sections?"="Summary, Risks".',
    );
  });
});

describe('the mock edited draft (M57.4b)', () => {
  const TOOLS_RS = readFileSync(join(__dirname, '../../src-tauri/src/policy/tools.rs'), 'utf8');
  const draft = { folder: 'records/risks', slug: 'vendor-delay', body: '# Vendor delay\n' };

  /** A confirmed write card for create_note, as the mock agent marks it. */
  function writeCard(resume = vi.fn()) {
    const id = registerMockInteraction(
      '/v',
      's-1',
      't-1',
      'create_note',
      JSON.stringify(draft),
      resume,
    );
    const card = confirmMockInteraction(id);
    if (card === null) throw new Error('a confirmed card');
    Object.assign(card, { kind: 'write' });
    return card;
  }

  it('takes an edit with an Allow of a write card, and hands it to the resume', () => {
    const resume = vi.fn();
    const card = writeCard(resume);
    const updatedInput = { ...draft, body: '# Vendor delay risk\n' };
    const taken = answerMockInteraction('/v', card.id, {
      kind: 'allow',
      remember: 'once',
      updatedInput,
    });
    if ('refused' in taken) throw new Error(taken.refused.message);
    taken.resume({ kind: 'allow', updatedInput });
    expect(resume).toHaveBeenCalledWith({ kind: 'allow', updatedInput });
  });

  it('refuses a misshapen edit in Rust’s words, and the card waits on', () => {
    const card = writeCard();
    const message = 'The edited draft leaves out slug, which this tool requires.';
    expect(
      answerMockInteraction('/v', card.id, {
        kind: 'allow',
        updatedInput: { folder: '', body: '# X' },
      }),
    ).toEqual({ refused: { code: MALFORMED_ARGUMENTS, message } });
    expect(TOOLS_RS).toContain('"The edited draft leaves out {key}, which this tool requires."');
    expect(listMockInteractions('/v').map((c) => c.id)).toEqual([card.id]);
    expect(answerMockInteraction('/v', card.id, { kind: 'allow' })).toHaveProperty('resume');
  });

  it('takes no edit on a card that is no page write', () => {
    const card = waiting();
    expect(
      answerMockInteraction('/v', card.id, { kind: 'allow', updatedInput: { path: 'a.md' } }),
    ).toEqual({ refused: { code: MALFORMED_ARGUMENTS, message: EDIT_MISFIT } });
    expect(RUST).toContain(`"${EDIT_MISFIT}"`);
  });
});
