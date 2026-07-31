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
    '2. Search the bundle for what it already holds on those entities BEFORE writing anything.',
    '3. For each durable thing it establishes, write or revise a concept with write_concept.',
    `4. Anchor every concept with \`about\`, and cite this note in \`sources\` (resource: ${path}).`,
    '',
    'Adding a second concept about something the bundle already covers is the failure mode here, not the goal. Revise the existing one in place when the note refines or extends it.',
    'When the note establishes something that REPLACES an existing concept, write the new one and set `supersedes: ["[[old-concept]]"]` — that retires the old one without deleting the record of what was believed before.',
    'When two concepts genuinely disagree and you cannot tell which is right, say so with `contradicts` rather than picking a winner. That is a judgement for the person who owns the work.',
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

/**
 * Ask the agent to recheck one concept against what it was built from (M8.8).
 *
 * The instruction to reach a verdict is load-bearing. Told only to "review",
 * a model reliably rewrites the prose slightly and reports success, which
 * leaves a bundle that grows and never shrinks. Naming the four outcomes —
 * and saying plainly that "still true" is one of them — is what makes
 * deprecating something an available answer rather than a failure to find
 * work.
 */
export function reviewConceptPrompt(path: string, title: string): string {
  return [
    `Recheck the knowledge concept at ${path} ("${title}"). Its recheck date has passed.`,
    '',
    'Read it, then read the sources it cites and anything newer in the vault about the same subjects. Reach one of four verdicts:',
    '',
    '- **Still true** — extend `stale_after` with write_concept and change nothing else.',
    '- **Needs revising** — rewrite it in place with write_concept, keeping the sources that still hold.',
    '- **Replaced** — write the concept that replaces it and set `supersedes` on the NEW one. Do not edit the old one.',
    '- **No longer true** — set `lifecycle: deprecated`. A wrong concept that stays stable is worse than one that is gone.',
    '',
    'Do not rewrite it just to have done something. "Still true, date extended" is a real answer and often the right one.',
    'Say which verdict you reached and what evidence decided it.',
  ].join('\n');
}

/** Ask the agent to propose a filing for one Inbox capture. */
export function organizePrompt(path: string): string {
  return `Look at the Inbox capture at ${path} and propose how to file it. Use propose_organize.`;
}

/**
 * Run one scheduled skill unattended (M13.2).
 *
 * The additive-only rules are the load-bearing part, and they are stated
 * here rather than trusted to each skill's author: an unattended run may
 * add and may flag, but the destructive verbs belong to interactive
 * sessions where a person is watching. The same principle as the nightly
 * agents in every second-brain system worth copying — and the reason a
 * scheduled run can be on by default without being frightening.
 */
export function scheduledSkillPrompt(path: string, title: string, body: string): string {
  return [
    `This is an unattended scheduled run of the skill "${title}" (${path}). Nobody is watching and no chat reply will be read — everything you produce must be written into the vault through the tools.`,
    '',
    'Rules for unattended runs, which override anything the skill says:',
    '- Additive only: create notes and write or revise knowledge concepts, but never delete, deprecate, or rewrite a note a person wrote.',
    '- When you find a genuine disagreement, record it with `contradicts` — resolving it is a judgement for the person who owns the work.',
    '- If a step would be destructive or needs an answer only the user has, skip it and note that in what you write.',
    '',
    'The skill:',
    '',
    body,
  ].join('\n');
}
