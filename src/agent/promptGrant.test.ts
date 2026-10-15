import { describe, expect, it } from 'vitest';
import SERVER_INSTRUCTIONS from '../../shared/prompt/server-instructions.md?raw';
import { buildSystemPrompt } from './systemPrompt';
import { listSkills, skillPrompt } from '@/engine/skills';
import { makeEntry } from '@/engine/testHelpers';
import {
  cliGrant,
  grantedTools,
  holdsShell,
  mentionedTools,
  type PromptGrant,
} from '@/engine/toolGrant';
import { SHELL_CEILINGS } from '@/lib/policy/toolApproval';
import {
  addressedAgentPrompt,
  agentRunPrompt,
  askBasePrompt,
  augmentDocPrompt,
  distillPrompt,
  fetchRefsPrompt,
  freshProposalPrompt,
  organizePrompt,
  panelAgentPrompt,
  refreshSourcePrompt,
  reviewConceptPrompt,
  reviseConceptPrompt,
  scheduledSkillPrompt,
  schemaRecheckPrompt,
  studioBuildPrompt,
} from '@/lib/prompts';
import { templateFillPrompt } from '@/lib/templates';

/**
 * M54.7 — no prompt names a tool its run lacks (AGENTS.md CV-19).
 *
 * Exhaustive, not sampled: every subset of the tools any composer names, on
 * every composer the app's TS runs, under every combination of the grant's
 * other axes and the options that switch lines on. A run hears the server
 * instructions too, so each prompt is checked with them in front of it.
 */

/** Every tool a run started from TS can hold. */
const HOLDABLE = grantedTools(null);

/** A vault with more skills than the catalogue's budget, so the line about
 * the unlisted ones is composed too. */
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

const SCOPES: (string[] | null)[] = [null, [], ['records/risks']];
const TRIGGERS = [
  null,
  {
    ask: 'Does this threaten the release?',
    do: 'Check the release date before writing anything.',
  },
];
const MEMORY = { recent: 'NOTES', preferences: 'CORRECTION' };
const AGENT = 'records/agents/scout.md';

/** The agent Settings binds the panel to (M56.6), under one scope pair. */
function panelAgent(scope: string[] | null, readScope: string[] | null) {
  return { path: AGENT, title: 'Scout', actor: 'process:scout', memory: MEMORY, scope, readScope };
}

/** Every agent prompt for `grant`: an unattended run, woken or not, an
 * addressed turn and the panel's bound agent, under each write and read
 * scope. They read only the grant's tools. */
function agentPrompts(grant: PromptGrant): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  for (const scope of SCOPES) {
    for (const readScope of SCOPES) {
      const where = `scope ${JSON.stringify(scope)}, read scope ${JSON.stringify(readScope)}`;
      for (const trigger of TRIGGERS) {
        out.push({
          label: `agentRunPrompt, ${trigger === null ? 'scheduled' : 'woken'}, ${where}`,
          text: agentRunPrompt(
            grant,
            AGENT,
            'Scout',
            'process:scout',
            MEMORY,
            trigger,
            scope,
            readScope,
          ),
        });
      }
      out.push({
        label: `addressedAgentPrompt, ${where}`,
        text: addressedAgentPrompt(
          grant,
          AGENT,
          'Scout',
          'process:scout',
          MEMORY,
          scope,
          readScope,
        ),
      });
      out.push({
        label: `panelAgentPrompt, ${where}`,
        text: panelAgentPrompt(grant, panelAgent(scope, readScope), 'Keep a running brief.'),
      });
    }
  }
  return out;
}

/** The panel's system prompt and a background job's, for `grant`. */
function systemPrompts(
  grant: PromptGrant,
  connectors: boolean,
  capabilities: string[],
): { label: string; text: string }[] {
  const options = {
    grant,
    connectors,
    ...(connectors ? { issuePrefixes: 'KES, OPS' } : {}),
    capabilities,
  };
  const axes = `connectors ${connectors}, capabilities ${JSON.stringify(capabilities)}`;
  return [
    {
      label: `panel buildSystemPrompt, ${axes}`,
      text: buildSystemPrompt({ kind: 'inbox' }, { ...options, skills: SKILLS }),
    },
    { label: `job buildSystemPrompt, ${axes}`, text: buildSystemPrompt({ kind: 'none' }, options) },
  ];
}

/** Many grants compose the same text, so each text is scanned once. */
const scanned = new Map<string, string[]>();
function heard(text: string): string[] {
  const prompt = `${SERVER_INSTRUCTIONS}\n${text}`;
  let named = scanned.get(prompt);
  if (named === undefined) {
    named = mentionedTools(prompt);
    scanned.set(prompt, named);
  }
  return named;
}

/** The tools any composer names, read off their output under a full grant
 * with every branch on: attended, shell, connectors, the knowledge capability,
 * a skill catalogue over budget, and every scope, read scope and trigger. */
const NAMED: readonly string[] = (() => {
  const full: PromptGrant = { tools: HOLDABLE, shell: true, attended: true };
  const named = new Set<string>();
  for (const { text } of [...systemPrompts(full, true, ['knowledge']), ...agentPrompts(full)]) {
    for (const tool of mentionedTools(text)) named.add(tool);
  }
  return [...named].sort();
})();

/** Every subset of NAMED, each with every tool no composer names. */
function grantsOfNamed(): ReadonlySet<string>[] {
  const unnamed = [...HOLDABLE].filter((tool) => !NAMED.includes(tool));
  return Array.from(
    { length: 2 ** NAMED.length },
    (_, mask) => new Set([...NAMED.filter((_, at) => (mask & (1 << at)) !== 0), ...unnamed]),
  );
}

describe('no prompt names a tool its run lacks', () => {
  it('reads the named tools off the composers themselves', () => {
    // Not vacuous: each of these is named by some line, so each subset below
    // drops a line someone wrote.
    for (const tool of [
      'get_vault_context',
      'search_notes',
      'get_note',
      'open_note',
      'propose_organize',
      'cache_source',
      'update_frontmatter',
      'write_concept',
    ]) {
      expect(NAMED, tool).toContain(tool);
    }
    for (const tool of NAMED) expect(HOLDABLE.has(tool), tool).toBe(true);
    // 2^12 subsets times every composer is the budget; past it, split the
    // matrix by composer.
    expect(NAMED.length).toBeLessThanOrEqual(12);
  });

  it('holds for every subset of them, on every composer, under every axis', () => {
    const misses: string[] = [];
    let composed = 0;
    for (const tools of grantsOfNamed()) {
      const check = (grant: PromptGrant, prompts: { label: string; text: string }[]) => {
        for (const { label, text } of prompts) {
          composed += 1;
          const lacked = heard(text).filter((tool) => !grant.tools.has(tool));
          if (lacked.length > 0) {
            misses.push(`${label}, holding [${[...grant.tools].sort().join(', ')}]: ${lacked}`);
          }
        }
      };
      // The agent prompts read only the grant's tools.
      check(
        { tools, shell: false, attended: false },
        agentPrompts({ tools, shell: false, attended: false }),
      );
      for (const attended of [true, false]) {
        for (const shell of [true, false]) {
          for (const connectors of [true, false]) {
            for (const capabilities of [[], ['knowledge']]) {
              const grant = { tools, shell, attended };
              check(grant, systemPrompts(grant, connectors, capabilities));
            }
          }
        }
      }
    }
    expect(composed).toBe(2 ** NAMED.length * (36 + 32));
    expect(misses.slice(0, 5)).toEqual([]);
  });

  it('never tells an unattended run to call open_note', () => {
    for (const tools of grantsOfNamed()) {
      for (const shell of [true, false]) {
        for (const { label, text } of systemPrompts({ tools, shell, attended: false }, true, [
          'knowledge',
        ])) {
          expect(heard(text), label).not.toContain('open_note');
        }
      }
    }
  });
});

/**
 * The asks a surface sends go to the panel's turns or a lane job's, which
 * narrow nothing, so they may name any tool such a run holds and no other.
 */
describe('the surface prompts', () => {
  const SURFACES: [string, string][] = [
    ['distill', distillPrompt('inbox/capture.md', 'A capture')],
    ['augment', augmentDocPrompt('docs/prd.md', 'The PRD')],
    ['askBase', askBasePrompt('records/reqs/rq-84b.md', 'RQ-84B Kestrel')],
    ['review', reviewConceptPrompt('knowledge/systems/drain.md', 'Drain time')],
    ['revise', reviseConceptPrompt('knowledge/systems/drain.md', 'Drain time')],
    ['schemaRecheck', schemaRecheckPrompt('knowledge/systems/drain.md', 'Drain time')],
    ['organize', organizePrompt('inbox/capture.md')],
    ['studioBuild', studioBuildPrompt('Checkout', 'studio/checkout')],
    ['refreshSource', refreshSourcePrompt('sources/kes-421.md', 'KES-421')],
    ['fetchRefs', fetchRefsPrompt('docs/prd.md', ['KES-421', 'OPS-7'])],
    [
      'freshProposal',
      freshProposalPrompt({
        proposalId: 'p-1',
        change: 'revise the drain time',
        reason: 'the pilot measured it',
        moved: 'the concept changed since',
      }),
    ],
    [
      'scheduledSkill',
      scheduledSkillPrompt('records/skills/digest.md', 'Digest', 'Read the boards.'),
    ],
    ['templateFill', templateFillPrompt('docs/new.md', 'New page', 'draft the risks section')],
  ];

  it('name only tools a full grant holds', () => {
    for (const [label, text] of SURFACES) {
      for (const tool of heard(text)) expect(HOLDABLE.has(tool), `${label}: ${tool}`).toBe(true);
    }
  });

  it('name no tool where a skill narrows the run', () => {
    // A skill turn and a scheduled skill run under the skill's own
    // allowed-tools, so the words around its body name nothing.
    const [skill] = SKILLS;
    expect(
      mentionedTools(skillPrompt(skill, '---\ntype: Skill\n---\nRead the boards.', 'now')),
    ).toEqual([]);
    expect(
      mentionedTools(
        scheduledSkillPrompt('records/skills/digest.md', 'Digest', 'Read the boards.'),
      ),
    ).toEqual([]);
  });

  it("say 'Read, Glob and Grep' exactly when the run is read-scoped", () => {
    const full: PromptGrant = { tools: HOLDABLE, shell: true, attended: true };
    for (const scope of SCOPES) {
      for (const readScope of SCOPES) {
        for (const trigger of TRIGGERS) {
          const run = agentRunPrompt(
            full,
            AGENT,
            'Scout',
            'process:scout',
            MEMORY,
            trigger,
            scope,
            readScope,
          );
          expect(run.includes('Read, Glob and Grep'), JSON.stringify({ scope, readScope })).toBe(
            readScope !== null,
          );
        }
        const turn = addressedAgentPrompt(
          full,
          AGENT,
          'Scout',
          'process:scout',
          MEMORY,
          scope,
          readScope,
        );
        expect(turn.includes('Read, Glob and Grep')).toBe(readScope !== null);
        const panel = panelAgentPrompt(full, panelAgent(scope, readScope), 'Keep a brief.');
        expect(panel.includes('Read, Glob and Grep')).toBe(readScope !== null);
      }
    }
  });
});

describe('the server instructions', () => {
  it('fit the CLI’s cap and name no tool', () => {
    const served = SERVER_INSTRUCTIONS.trim();
    expect(served.length).toBeGreaterThan(0);
    // A JS string's length counts UTF-16 units, as the cap does.
    expect(served.length).toBeLessThanOrEqual(2048);
    expect(mentionedTools(SERVER_INSTRUCTIONS)).toEqual([]);
  });
});

describe('the ceiling dimension (M57.2)', () => {
  it('holds the shell exactly where the table pre-approves or asks for it', () => {
    for (const shell of SHELL_CEILINGS) {
      for (const attended of [true, false]) {
        const input = { shell, attended, readScoped: false, narrowing: null };
        const { cli, asks } = cliGrant(input);
        expect(holdsShell(input), `${shell} attended=${attended}`).toBe(
          [...cli, ...asks].includes('Bash'),
        );
      }
    }
  });

  it('gives an unattended Ask run no shell tool, so its prompts are Off’s', () => {
    const input = { shell: 'ask' as const, attended: false, readScoped: false, narrowing: null };
    expect(cliGrant(input)).toEqual({ cli: [], asks: [] });
    const tools = grantedTools(null);
    const ask: PromptGrant = { tools, shell: holdsShell(input), attended: false };
    const off: PromptGrant = { tools, shell: false, attended: false };
    expect(systemPrompts(ask, true, ['knowledge'])).toEqual(
      systemPrompts(off, true, ['knowledge']),
    );
  });
});
