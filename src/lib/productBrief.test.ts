import { describe, expect, it } from 'vitest';
import RAW_BRIEF from '../../shared/prompt/product-brief.md?raw';
import RETIRED from '../../shared/prompt/retired-terms.json';
import SERVER_INSTRUCTIONS from '../../shared/prompt/server-instructions.md?raw';
import RAW_TOOLS from '../../shared/policy/tools.v1.json?raw';
import { PRODUCT_BRIEF } from './productBrief';
import * as prompts from './prompts';
import { templateFillPrompt } from './templates';
import { VAULT_OVERVIEW_REPLY } from '@/agent/mockAgent';
import { buildSystemPrompt } from '@/agent/systemPrompt';
import { listSkills, skillIndex, skillPrompt } from '@/engine/skills';
import { makeEntry } from '@/engine/testHelpers';
import { grantedTools, mentionedTools, type PromptGrant } from '@/engine/toolGrant';

/**
 * M54.8 — one current description of the product, and no word for the model
 * cerebro retired, in anything the model reads (AGENTS.md CV-20). The brief
 * is the one place to say what the app is; this file fails the next drift.
 */

const TERMS: readonly string[] = RETIRED.terms;

/** The retired terms `text` still says, each matched as a case-insensitive
 * substring, as src-tauri/src/mcp.rs matches them. */
const retiredIn = (text: string): string[] =>
  TERMS.filter((term) => text.toLowerCase().includes(term.toLowerCase()));

const FULL: ReadonlySet<string> = grantedTools(null);
const NONE: ReadonlySet<string> = new Set();

/** Every grant shape a prompt branches on: everything held or nothing, with a
 * person watching or not, with the shell or without. */
const GRANTS: readonly PromptGrant[] = [FULL, NONE].flatMap((tools) =>
  [true, false].flatMap((attended) => [true, false].map((shell) => ({ tools, shell, attended }))),
);

/** More skills than the catalogue's budget, so its "more are defined" clause
 * is composed too. Neutral names: a skill's title is vault data, not copy. */
const SKILLS = listSkills(
  Array.from({ length: 60 }, (_, i) =>
    makeEntry({
      path: `records/skills/s${i}.md`,
      title: `Skill ${String(i).padStart(2, '0')}`,
      type: 'Skill',
      properties: { description: 'A reasonably wordy description of what this skill does.' },
    }),
  ),
);

/** Every kind `describeSelection` names, with neutral names in it. */
const SELECTIONS = [
  { kind: 'none' },
  { kind: 'home' },
  { kind: 'inbox' },
  { kind: 'knowledge' },
  { kind: 'doc', path: 'notes/plan.md' },
  { kind: 'project', path: 'notes/plan.md' },
  { kind: 'list', id: 'board' },
  { kind: 'type', name: 'Thing' },
];

/** One speaker of each kind the meeting ask names (M64.7). */
const MEETING_SPEAKERS = [
  {
    label: 'Sam Lee',
    kind: 'matched' as const,
    page: makeEntry({ path: 'people/sam-lee.md', title: 'Sam Lee' }),
    link: '[[sam-lee]]',
  },
  { label: 'Ana Ray', kind: 'none' as const },
  { label: 'Jo Kim', kind: 'ambiguous' as const, count: 2 },
];

const MEMORY = { recent: 'Read the boards.', preferences: 'Keep it short.' };
const EMPTY_MEMORY = { recent: '', preferences: '' };
const SCOPES: (string[] | null)[] = [null, [], ['notes']];
const TRIGGERS = [
  null,
  { subject: 'notes/plan.md', because: 'status changed' },
  { subject: 'notes/plan.md', because: 'status changed', ask: 'Is it late?', do: 'Check dates.' },
];

/**
 * Every export of src/lib/prompts.ts that composes text, called on every
 * branch it has. Keyed by export name, so a new builder that is not added
 * here fails the coverage test below rather than going unchecked.
 */
const BUILDERS: Record<string, () => string[]> = {
  sheetAskPrompt: () => [
    prompts.sheetAskPrompt('What is the total?', 'notes/plan.md', 'Plan', 'Sheet1!A1', [
      { address: 'A1', source: '1', shown: '1' },
    ]),
  ],
  askedAbout: () => [prompts.askedAbout('A label', 'A page')],
  askAssistantLabel: () => [prompts.askAssistantLabel('what is due')],
  distillPrompt: () => [prompts.distillPrompt('notes/plan.md', 'The plan')],
  fetchRefsLabel: () => [prompts.fetchRefsLabel(1), prompts.fetchRefsLabel(2)],
  fetchRefsPrompt: () => [
    prompts.fetchRefsPrompt('notes/plan.md', ['KES-421']),
    prompts.fetchRefsPrompt('notes/plan.md', ['KES-421', 'OPS-7']),
    prompts.fetchRefsPrompt(
      'notes/plan.md',
      ['KES-421', 'https://linear.app/acme/issue/ENG-142/fix-login'],
      [null, 'ENG-142 Fix login'],
    ),
  ],
  augmentDocPrompt: () => [prompts.augmentDocPrompt('notes/plan.md', 'The plan')],
  askBasePrompt: () => [prompts.askBasePrompt('notes/plan.md', 'The plan')],
  reviewConceptPrompt: () => [prompts.reviewConceptPrompt('knowledge/c.md', 'A concept')],
  freshProposalPrompt: () => [
    prompts.freshProposalPrompt({
      proposalId: 'p-1',
      change: 'revise it',
      reason: 'it moved',
      moved: 'the concept changed since',
    }),
  ],
  reviseConceptPrompt: () => [prompts.reviseConceptPrompt('knowledge/c.md', 'A concept')],
  conceptAsk: () =>
    [true, false].flatMap((stale) => {
      const ask = prompts.conceptAsk({ path: 'knowledge/c.md', title: 'A concept', stale });
      return [ask.label, ask.text];
    }),
  schemaRecheckPrompt: () => [prompts.schemaRecheckPrompt('knowledge/c.md', 'A concept')],
  organizePrompt: () => [
    prompts.organizePrompt('inbox/thought.md'),
    ...[null, [], MEETING_SPEAKERS].map((speakers) =>
      prompts.organizePrompt('inbox/standup.md', { title: 'Standup', speakers }),
    ),
  ],
  studioBuildPrompt: () => [prompts.studioBuildPrompt('Checkout', 'studio/checkout')],
  currentStatePrompt: () =>
    [null, 'succeeded'].flatMap((lastOutcome) =>
      [null, 0, 3].map((openReviews) =>
        prompts.currentStatePrompt({
          vaultName: 'vault',
          today: '2026-10-13',
          lastOutcome,
          openReviews,
        }),
      ),
    ),
  assignmentLines: () =>
    [
      ...GRANTS,
      {
        tools: new Set(['get_note', 'update_frontmatter', 'edit_note']),
        shell: false,
        attended: true,
      },
    ].flatMap((grant) =>
      [true, false].flatMap((canWrite) =>
        [null, { title: 'Plan', path: 'notes/plan.md' }].map((host) =>
          prompts.assignmentLines(grant, { field: 'agent', canWrite, host }).join('\n'),
        ),
      ),
    ),
  agentMemoryLines: () =>
    [MEMORY, EMPTY_MEMORY].map((memory) => prompts.agentMemoryLines(memory).join('\n')),
  agentScopeLines: () =>
    GRANTS.flatMap((grant) =>
      SCOPES.map((scope) => prompts.agentScopeLines(grant, scope, 'Stop.').join('\n')),
    ),
  agentReadScopeLines: () =>
    GRANTS.flatMap((grant) =>
      SCOPES.map((scope) => prompts.agentReadScopeLines(grant, scope).join('\n')),
    ),
  standingInstructionsBlock: () => [
    prompts.standingInstructionsBlock('records/agents/scout.md', 'Read the boards.'),
    prompts.standingInstructionsBlock('records/agents/scout.md', ''),
  ],
  addressedAgentPrompt: () =>
    GRANTS.flatMap((grant) =>
      SCOPES.flatMap((scope) =>
        SCOPES.map((readScope) =>
          prompts.addressedAgentPrompt(
            grant,
            'records/agents/scout.md',
            'Scout',
            'process:scout',
            MEMORY,
            scope,
            readScope,
          ),
        ),
      ),
    ),
  panelAgentPrompt: () =>
    GRANTS.flatMap((grant) =>
      SCOPES.flatMap((scope) =>
        SCOPES.flatMap((readScope) =>
          [MEMORY, EMPTY_MEMORY].flatMap((memory) =>
            ['Read the boards.', ''].map((body) =>
              prompts.panelAgentPrompt(
                grant,
                {
                  path: 'records/agents/scout.md',
                  title: 'Scout',
                  actor: 'process:scout',
                  memory,
                  scope,
                  readScope,
                },
                body,
              ),
            ),
          ),
        ),
      ),
    ),
  agentRunPrompt: () =>
    GRANTS.flatMap((grant) =>
      TRIGGERS.flatMap((trigger) =>
        SCOPES.map((scope) =>
          prompts.agentRunPrompt(
            grant,
            'records/agents/scout.md',
            'Scout',
            'process:scout',
            EMPTY_MEMORY,
            trigger,
            scope,
            scope,
          ),
        ),
      ),
    ),
  refreshSourcePrompt: () => [prompts.refreshSourcePrompt('sources/kes-421.md', 'KES-421')],
  scheduledSkillPrompt: () => [
    prompts.scheduledSkillPrompt('records/skills/digest.md', 'Digest', 'Read the boards.'),
  ],
};

describe('the product brief', () => {
  it('is the file, trimmed the same way in both languages', () => {
    // Exactly one newline after the text, so TS `trim` and Rust `str::trim`
    // (which differ at U+FEFF and U+0085) hand the model the same bytes.
    expect(RAW_BRIEF).toBe(`${PRODUCT_BRIEF}\n`);
  });

  it('fits its budget: it rides every turn and every get_vault_context answer', () => {
    expect(PRODUCT_BRIEF.length).toBeLessThanOrEqual(1500);
  });

  it('names no tool, so every grant may hear it', () => {
    expect(mentionedTools(PRODUCT_BRIEF)).toEqual([]);
  });

  it('never tells a run about the knowledge bundle (M34.1.3)', () => {
    // A run that never declared the knowledge capability is not told the
    // bundle exists, and the brief goes to every run.
    expect(PRODUCT_BRIEF).not.toContain('knowledge/');
    expect(PRODUCT_BRIEF.toLowerCase()).not.toContain('knowledge');
  });

  it('describes the model the app has today', () => {
    for (const fact of ['`type: Type`', '`type: Collection`', '`<folder>/<folder>.md`', 'Inbox']) {
      expect(PRODUCT_BRIEF).toContain(fact);
    }
  });
});

describe('no retired term reaches the model', () => {
  it('lists at least the five the roadmap retired, and matches them in any case', () => {
    for (const term of ['project.md', 'collection.yml', '.list.yml', 'Types screen', 'work item']) {
      expect(TERMS).toContain(term);
    }
    expect(RETIRED.why.length).toBeGreaterThan(0);
    expect(new Set(TERMS.map((term) => term.toLowerCase())).size).toBe(TERMS.length);
    // Not vacuous: the match ignores case and finds a term inside a word.
    expect(retiredIn('A Work Item in PROJECT.MD')).toEqual(['project.md', 'work item']);
  });

  it('in the brief, the server instructions and the tool manifest', () => {
    expect(retiredIn(PRODUCT_BRIEF)).toEqual([]);
    expect(retiredIn(SERVER_INSTRUCTIONS)).toEqual([]);
    expect(retiredIn(RAW_TOOLS)).toEqual([]);
  });

  it('in any system prompt, on every branch', () => {
    const misses: string[] = [];
    let composed = 0;
    for (const grant of GRANTS) {
      for (const capabilities of [[], ['knowledge']]) {
        for (const connectors of [true, false]) {
          for (const selection of SELECTIONS) {
            for (const serverRules of [false, true]) {
              const prompt = buildSystemPrompt(
                selection,
                {
                  grant,
                  capabilities,
                  connectors,
                  issuePrefixes: 'KES, OPS',
                  skills: SKILLS,
                },
                serverRules,
              );
              composed += 1;
              const said = retiredIn(prompt);
              if (said.length > 0) misses.push(`${JSON.stringify(selection)}: ${said}`);
            }
          }
        }
      }
    }
    expect(composed).toBe(GRANTS.length * 2 * 2 * SELECTIONS.length * 2);
    expect(misses).toEqual([]);
  });

  it('in every prompt builder, and every builder is checked', () => {
    const exported = Object.entries(prompts)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();
    expect(Object.keys(BUILDERS).sort()).toEqual(exported);
    for (const [name, build] of Object.entries(BUILDERS)) {
      const texts = build();
      expect(texts.length, name).toBeGreaterThan(0);
      for (const text of texts) expect(retiredIn(text), name).toEqual([]);
    }
    // The labels are what a person reads in the bubble the ask leaves behind.
    for (const [name, value] of Object.entries(prompts)) {
      if (typeof value === 'string') expect(retiredIn(value), name).toEqual([]);
    }
  });

  it('in the skill catalogue, a skill turn and the template fill', () => {
    for (const tools of [FULL, NONE]) {
      expect(retiredIn(skillIndex(SKILLS, { tools, shell: false, attended: true }) ?? '')).toEqual(
        [],
      );
    }
    expect(retiredIn(skillPrompt(SKILLS[0], '---\ntype: Skill\n---\nRead it.', 'now'))).toEqual([]);
    expect(retiredIn(templateFillPrompt('notes/new.md', 'New page', 'draft the risks'))).toEqual(
      [],
    );
  });

  it("in the mock's overview reply, which stays one line under its first words", () => {
    expect(retiredIn(VAULT_OVERVIEW_REPLY)).toEqual([]);
    // e2e/ai-block.spec.ts and src/editor/MarkdownEditor.test.tsx find an AI
    // block's answer by these words, on one line.
    expect(VAULT_OVERVIEW_REPLY.startsWith('This vault tracks work as typed markdown')).toBe(true);
    expect(VAULT_OVERVIEW_REPLY).not.toContain('\n');
  });
});
