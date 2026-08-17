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
    `4. Anchor every concept with \`about\`, cite this note in \`sources\` (resource: ${path}), and give each one a one-sentence \`description\` — it is the only line shown beside the title in every list.`,
    '',
    'Every fact you store must be timeless, dated, or a pointer (M13.5). "The pipeline has 13 open deals" becomes a lie next Tuesday while still reading as truth — write "2026-07-31: pipeline at 13 open deals", or point at where the live number lives, or store only what does not move.',
    '',
    'Adding a second concept about something the bundle already covers is the failure mode here, not the goal. Revise the existing one in place when the note refines or extends it.',
    'When the note establishes something that REPLACES an existing concept, write the new one and set `supersedes: ["[[old-concept]]"]` — that retires the old one without deleting the record of what was believed before.',
    'Anything you state in the body about one concept replacing, narrowing or disagreeing with another must ALSO be in `supersedes`/`refines`/`contradicts`. A supersession written only as prose cannot answer "is this still true". Only assert a relation whose target you read in this run.',
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
 * Ask the base what it knows that bears on the record in front of you
 * (M33a.5).
 *
 * The counterpart to `augmentDocPrompt`, and a different question: that one
 * reads your DRAFT and reports what it is missing, this one asks the base
 * about the SUBJECT and reports what it holds. It is the invocable half of
 * the same read the surfaces beside a record already render.
 *
 * Naming `knowledge_about` first is load-bearing. Told only to "see what you
 * know", a model searches the bundle by keyword and returns whichever
 * concepts share words with the title — which misses everything anchored to
 * the record under a name the title never uses, and finds concepts that are
 * about something else entirely. The tool answers by ANCHOR, which is the
 * question being asked.
 *
 * The instruction not to write is equally load-bearing: the user pressed a
 * button that asks a question, and an answer that arrives as three new
 * concepts is not the thing they asked for.
 */
export function askBasePrompt(path: string, title: string): string {
  return [
    `What does the knowledge base know that bears on ${path} ("${title}")?`,
    '',
    `Call knowledge_about with target: ${path} FIRST — it answers by anchor, so it finds what is filed under this record rather than what happens to share words with its title. Then follow the threads it names: read the concepts that matter with get_note, and call knowledge_about again for anything they are also about.`,
    '',
    'Answer in three short sections:',
    '',
    '**Held** — what the base currently believes about this, each with the concept it came from.',
    '**Unsettled** — anything contradicted, superseded, or past its recheck date. Say which claim is newer.',
    '**Not covered** — what the record raises that the base has nothing on. This is the section worth reading, so do not pad the other two to reach it.',
    '',
    'Do not write or revise anything. This is a question, not an instruction to distil — if the answer is "almost nothing yet", that is the answer, and say so in one line.',
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
    'While you are in there: any volatile present-tense claim without a date becomes a dated snapshot or a pointer to where truth lives — an undated "currently" is the sentence that rots silently.',
    'Say which verdict you reached and what evidence decided it.',
  ].join('\n');
}

/**
 * Recheck a concept because the SCHEMA of what it describes changed (M13.5).
 *
 * This is how "we added/removed a type" avoids a bulk re-synthesis: each
 * affected concept comes through here lazily, one at a time, when the queue
 * gets to it. Same four verdicts as an ordinary recheck — a schema change
 * often changes nothing about what is true.
 */
export function schemaRecheckPrompt(path: string, title: string): string {
  return [
    `Recheck the knowledge concept at ${path} ("${title}"). The schema of what it is about has changed: a Type it references was edited after this concept was written — fields may have been added, renamed, or removed, and the concept may describe a shape that no longer exists.`,
    '',
    'Read it, its sources, and the current Type docs of the records it is about. Reach one of four verdicts:',
    '',
    '- **Still true** — the schema change does not affect it; extend `stale_after` with write_concept and change nothing else.',
    '- **Needs revising** — rewrite it in place to match the current shape, keeping the sources that still hold.',
    '- **Replaced** — write the concept that replaces it and set `supersedes` on the NEW one. Do not edit the old one.',
    '- **No longer true** — set `lifecycle: deprecated`.',
    '',
    'Say which verdict you reached and what the schema change turned out to mean.',
  ].join('\n');
}

/** Ask the agent to propose a filing for one Inbox capture. */
export function organizePrompt(path: string): string {
  return `Look at the Inbox capture at ${path} and propose how to file it. Use propose_organize.`;
}

/**
 * Run one agent record unattended (M13.4).
 *
 * Same additive-only spine as a scheduled skill, plus the two things that
 * make an agent an AGENT rather than a prompt: an identity its writes are
 * attributed to, and a memory it must leave for its next run. The memory
 * lives in the record's own `memory:` frontmatter — rewritten through
 * update_frontmatter, bounded, and visible as an ordinary property — so what
 * the agent carries forward is never hidden from the person it works for.
 */
/**
 * State pushed at a resumed run, rather than remembered by it (M33.8).
 *
 * An unattended run may carry notes it wrote weeks ago (`memory.recent`), and
 * a model reading them has no way to tell which parts are still true. Pushing
 * the few facts that go stale — and saying out loud that they SUPERSEDE what
 * it remembers — is cheaper and more reliable than any instruction to
 * distrust its own notes.
 *
 * Deliberately four lines. This block rides in front of every unattended run,
 * so anything added here is paid for on every one of them; it holds only
 * facts that (a) change without the agent doing anything and (b) change what
 * a run should do.
 *
 * **Absent is never zero here either.** An agent that has never run says
 * "none", not "succeeded"; a review count that could not be read is OMITTED
 * rather than reported as 0, because telling an unattended agent that nothing
 * is waiting when we do not know is exactly the false calm the rest of this
 * milestone is built to avoid.
 */
export function currentStatePrompt(state: {
  vaultName: string;
  today: string;
  /** The outcome of this agent's last run, or null if it has never run —
   * which is different from a run that failed. */
  lastOutcome: string | null;
  /** Omitted from the block entirely when null (unreadable), which is not
   * the same as 0 (read, and empty). */
  openReviews: number | null;
}): string {
  return [
    'CURRENT STATE (supersedes anything you remember)',
    `- Vault: ${state.vaultName}`,
    `- Today: ${state.today}`,
    `- Your last run: ${state.lastOutcome ?? 'none'}`,
    ...(state.openReviews === null
      ? []
      : [`- Proposals waiting on a person: ${state.openReviews}`]),
  ].join('\n');
}

export function agentRunPrompt(
  path: string,
  title: string,
  actor: string,
  memory: { recent: string; preferences: string },
  body: string,
  /** What woke this run, when an event did (M17.12) — layer TWO of the
   * trigger. Layer one already passed deterministically; this is the model
   * gate, and it comes with an explicit permission to do nothing. */
  trigger?: { subject: string; because: string; ask?: string; do?: string } | null,
  /** Folders this run may write inside (M17.13). Stated so the agent plans
   * inside its boundary rather than discovering it as a tool error. */
  scope?: readonly string[] | null,
): string {
  return [
    `You are "${title}", the agent defined at ${path} in this vault, on an unattended ${trigger == null ? 'scheduled' : 'event-triggered'} run. Your writes are attributed to ${actor}. Nobody is watching and no chat reply will be read — everything you produce must land in the vault through the tools.`,
    '',
    ...(trigger == null
      ? []
      : [
          `You were woken because ${trigger.because}: ${trigger.subject}. Read it first.`,
          ...(trigger.ask === undefined
            ? []
            : [
                `Before doing anything else, answer this for yourself: ${trigger.ask}`,
                'If the answer is no, write nothing and stop. A run that correctly does nothing is a success, and this question exists precisely so that most wakings end here.',
              ]),
          // M18.5 — placed BEFORE the standing instructions and named as an
          // addition to them, because the failure mode of per-trigger prose is
          // a model that treats it as a replacement and forgets the agent's
          // own rules. Said twice, in effect: here, and again by "Your
          // instructions" arriving afterwards as the general case.
          ...(trigger.do === undefined
            ? []
            : [
                `For this waking in particular, on top of your standing instructions below: ${trigger.do}`,
                'Your standing instructions still apply in full — this narrows what to do, it does not replace them.',
              ]),
          '',
        ]),
    ...(scope == null
      ? []
      : [
          scope.length === 0
            ? 'You are scoped to no folder at all: every write to a record will be refused. Say so in your memory and stop.'
            : `You may write records only inside: ${scope.join(', ')}. This is enforced — a write anywhere else is refused before it reaches disk, so plan inside it rather than discovering it as an error. (The knowledge bundle is reached through write_concept and is not affected.)`,
          '',
        ]),
    'Rules for unattended runs, which override anything your instructions say:',
    '- Additive only: create notes and write or revise knowledge concepts, but never delete, deprecate, or rewrite a note a person wrote.',
    '- When you find a genuine disagreement, record it with `contradicts` — resolving it is a judgement for the person who owns the work.',
    '- If a step would be destructive or needs an answer only the user has, skip it and note that in what you write.',
    '',
    // M17.14 — two tiers, in priority order, and the order is the point. What
    // a person corrected outranks what the agent concluded about itself, every
    // time; presenting them as one blob is how the second quietly overwrites
    // the first.
    ...(memory.preferences === ''
      ? []
      : [
          `What the person you work for has told you. This outranks your own notes and anything you infer, and you cannot change it — a write to \`preferences\` from this run is refused:\n${memory.preferences}`,
          '',
        ]),
    memory.recent === ''
      ? 'This is your first run — you have no working notes yet.'
      : `Your working notes from previous runs:\n${memory.recent}`,
    '',
    `Before you finish, rewrite your working notes with update_frontmatter on ${path}, patching the \`recent\` key: at most 30 lines, only what your next run genuinely needs. A memory that merely grows is a log, not a memory.`,
    'What you have LEARNED — anything durable about the work rather than about your own progress — belongs in the knowledge bundle through write_concept, where it carries provenance and a person can verify it. Working notes are for you; concepts are for everyone.',
    '',
    'Your instructions:',
    '',
    body,
  ].join('\n');
}

/**
 * Refresh one stale cached source (M13.3).
 *
 * "Do nothing without a connector" is load-bearing: a model told to refresh
 * a copy it cannot re-fetch will write a plausible newer-looking one, and a
 * fabricated cache poisons every concept that cites it.
 */
export function refreshSourcePrompt(path: string, title: string): string {
  return [
    `The cached copy at ${path} ("${title}") has passed its refresh date.`,
    '',
    'Read it to see what it is a copy of — source_id, source_kind, source_url — then re-fetch it through whichever connector you have for that system and call cache_source with the SAME id and kind, so the copy is replaced in place and everything citing the path keeps working.',
    'If you have no connector for that system, do nothing and say so briefly. A stale honest copy beats a fresh invented one.',
  ].join('\n');
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
