import { SOURCES_DIR } from '@/engine/ingest';

/**
 * The prompts cerebro hands the agent when the user asks for something from a
 * surface rather than by typing (M8.2).
 *
 * They live together because they are a contract, not copy: each one names the
 * exact tools and fields the rest of the app depends on the agent producing.
 * A distilled concept without `about` is unreachable from the work it
 * describes, and a distillation that never cites the note it read cannot be
 * checked — so the prompt says both, every time, in the same words.
 */

/** Ask the agent to learn from one working doc — the distil step. */
export function distillPrompt(path: string, title: string): string {
  return [
    `Learn from the note at ${path} ("${title}").`,
    '',
    'Read it, then update the knowledge/ bundle so what it establishes is captured:',
    '1. Work out which vault entities it concerns — projects, people, records — and resolve them with search_notes.',
    '2. For each durable thing it establishes, write or revise a concept with write_concept.',
    `3. Anchor every concept with \`about\`, and cite this note in \`sources\` (resource: ${path}).`,
    '4. Prefer revising an existing concept over adding a near-duplicate.',
    '',
    'Skip anything ephemeral — scheduling, chit-chat, and things already recorded elsewhere.',
    'Then tell me, briefly, what you learned and what you chose not to keep.',
  ].join('\n');
}

/** Ask the agent to fetch external references a note mentions but nobody has cached. */
export function fetchRefsPrompt(path: string, ids: readonly string[]): string {
  return [
    `The note at ${path} refers to ${ids.join(', ')}, and there is no local copy of ${
      ids.length === 1 ? 'it' : 'them'
    }.`,
    '',
    'For each one, use whichever connector you have for that system to fetch it, then call cache_source to write the result down.',
    `Cached copies live in ${SOURCES_DIR}/ so the next question about the same ticket reads a file instead of calling the API again.`,
    'If you have no connector for a system, say so plainly rather than guessing at the contents.',
  ].join('\n');
}

/**
 * The PRD case (M8.3): what does the vault know about this that the draft in
 * front of me does not say — and where do the two disagree?
 *
 * Three questions in a fixed order, because the third is the valuable one and
 * an agent left to its own structure will produce a summary instead. The
 * instruction not to edit is load-bearing: this surface reads your draft, and
 * a helper that silently rewrites what you are writing is not a helper.
 */
export function augmentDocPrompt(path: string, title: string): string {
  return [
    `I am writing ${path} ("${title}").`,
    '',
    'Read it, then read what the knowledge bundle and the vault already hold about the same subjects. Answer in three short sections:',
    '',
    '**Established** — things settled elsewhere that this draft should be able to rely on, each with the note it came from.',
    '**Missing** — points the sources make that the draft does not cover yet.',
    '**Contradicts** — anywhere the draft disagrees with a decision, a concept, or a record. Say which is newer.',
    '',
    'Do not edit the document. If a section has nothing in it, say so in one line rather than padding it.',
  ].join('\n');
}

/** Ask the agent to review one concept against what it was built from. */
export function reviewConceptPrompt(path: string, title: string): string {
  return [
    `Review the knowledge concept at ${path} ("${title}").`,
    'Check it against its sources, then revise it with write_concept if it is wrong, stale, or thin.',
    'Explain what you changed and why.',
  ].join('\n');
}

/** Ask the agent to propose a filing for one Inbox capture. */
export function organizePrompt(path: string): string {
  return `Look at the Inbox capture at ${path} and propose how to file it. Use propose_organize.`;
}
