/**
 * AskUserQuestion's form (M57.3): the shared cases question.rs replays too,
 * and the drafts a question card keeps.
 *
 * @see src-tauri/src/agent/question.rs
 */

import { describe, expect, it } from 'vitest';
import CASES from '../../src-tauri/fixtures/question-answers.json';
import {
  answersFor,
  initialDrafts,
  join,
  parseQuestions,
  problems,
  PROBLEM_COPY,
  toAnswers,
  type Draft,
  type QuestionAnswer,
  type QuestionSet,
} from './questionForm';

const SET: QuestionSet = [
  {
    question: 'Which format?',
    header: 'Format',
    options: [
      { label: 'Markdown', description: '', preview: null },
      { label: 'Plain text', description: '', preview: null },
    ],
    multiSelect: false,
  },
  {
    question: 'Which sections?',
    header: 'Sections',
    options: [
      { label: 'Summary', description: '', preview: null },
      { label: 'Risks', description: '', preview: null },
      { label: 'Next steps', description: '', preview: null },
    ],
    multiSelect: true,
  },
];

describe('the shared question cases', () => {
  it('names the pin its join rule was read from', () => {
    expect(CASES.format).toBe(1);
    expect(CASES.cli_version).toBe('2.1.250');
  });

  it('parses every case as Rust does, refusal for refusal', () => {
    expect(CASES.parse_cases.length).toBeGreaterThanOrEqual(8);
    for (const c of CASES.parse_cases) {
      const got = parseQuestions(c.input);
      if ('questions' in c) expect(got, c.why).toEqual({ ok: c.questions });
      else expect(got, c.why).toEqual({ refused: c.refused });
    }
  });

  it('maps every answer case as Rust does, refusal for refusal', () => {
    expect(CASES.answer_cases.length).toBeGreaterThanOrEqual(10);
    for (const c of CASES.answer_cases) {
      const set = parseQuestions(c.input);
      if (!('ok' in set)) throw new Error(`${c.why}: ${set.refused}`);
      const got = answersFor(set.ok, c.answers as QuestionAnswer[]);
      if ('expected' in c) expect(got, c.why).toEqual({ ok: c.expected });
      else expect(got, c.why).toEqual({ refused: c.refused });
    }
  });

  it('joins a value holding a comma and a space, or a quote, as its JSON string', () => {
    expect(join(['Plain', 'Summary, then risks', 'The "short" one'])).toBe(
      'Plain, "Summary, then risks", "The \\"short\\" one"',
    );
    expect(join(['a,b', 'c'])).toBe('a,b, c');
  });
});

describe('a question card’s drafts', () => {
  it('starts with nothing picked', () => {
    expect(initialDrafts(SET)).toEqual([
      { kind: 'single', pick: { kind: 'none' } },
      { kind: 'multi', picked: [], other: null },
    ]);
    expect(problems(SET, initialDrafts(SET))).toEqual([PROBLEM_COPY.pickOne, PROBLEM_COPY.pickAny]);
  });

  it('tells Other with no text from nothing picked', () => {
    const typed: Draft[] = [
      { kind: 'single', pick: { kind: 'other', text: '  ' } },
      { kind: 'multi', picked: [], other: '' },
    ];
    expect(problems(SET, typed)).toEqual([PROBLEM_COPY.typeOther, PROBLEM_COPY.typeOther]);
    // Other chosen beside a pick still wants its words.
    expect(problems(SET, [typed[0], { kind: 'multi', picked: ['Risks'], other: '' }])[1]).toBe(
      'Type your answer or pick an option',
    );
  });

  it('has no problem once each question is answered, and sends the answers', () => {
    const drafts: Draft[] = [
      { kind: 'single', pick: { kind: 'option', label: 'Markdown' } },
      { kind: 'multi', picked: ['Summary', 'Risks'], other: null },
    ];
    expect(problems(SET, drafts)).toEqual([null, null]);
    const answers = toAnswers(SET, drafts);
    expect(answers).toEqual([
      { question: 'Which format?', picked: ['Markdown'], other: null },
      { question: 'Which sections?', picked: ['Summary', 'Risks'], other: null },
    ]);
    expect(answersFor(SET, answers)).toEqual({
      ok: { 'Which format?': 'Markdown', 'Which sections?': 'Summary, Risks' },
    });
  });

  it('sends Other as the answer', () => {
    const drafts: Draft[] = [
      { kind: 'single', pick: { kind: 'other', text: 'HTML' } },
      { kind: 'multi', picked: ['Risks'], other: 'Owners' },
    ];
    expect(problems(SET, drafts)).toEqual([null, null]);
    expect(answersFor(SET, toAnswers(SET, drafts))).toEqual({
      ok: { 'Which format?': 'HTML', 'Which sections?': 'Risks, Owners' },
    });
  });
});
