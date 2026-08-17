/**
 * What the assistant can actually do (M18.4).
 *
 * The tool names have only ever existed in `src-tauri/src/mcp.rs`, which is
 * correct — that is where they are served and where a narrowing is enforced.
 * But it left the UI with nothing to offer: `allowed-tools:` was a free-text
 * box, so choosing a policy meant knowing every identifier by heart and
 * getting each one exactly right. A typo did not error; it silently narrowed
 * the run to nothing, which looks identical to a model that decided not to act.
 *
 * So this is a MIRROR, and it is tested as one (tools.test.ts parses mcp.rs and
 * fails if the two lists diverge) — the same parity discipline the mock backend
 * already carries for the Rust write guards.
 *
 * ## Toolsets
 *
 * Grouped the way ClickUp groups them, for the reason they do: nobody picks a
 * dozen checkboxes. They pick "reading" or "reading and writing", and the
 * individual tools are there for the one case that needs a scalpel. The groups
 * are drawn on the axis that matters here — what a run can CHANGE — so the
 * dangerous ones cannot hide in a bundle labelled after a workflow.
 */

import { agentFacingOps, POLICY } from '@/lib/policy/table';

export interface ToolSpec {
  name: string;
  /** One line, plain. Not the model-facing description, which is a paragraph. */
  summary: string;
  /** True when the tool changes something on disk or in the UI. */
  writes: boolean;
}

export interface Toolset {
  id: string;
  label: string;
  hint: string;
  tools: ToolSpec[];
}

export const TOOLSETS: Toolset[] = [
  {
    id: 'read',
    label: 'Read the vault',
    hint: 'Look things up. Changes nothing.',
    tools: [
      {
        name: 'get_vault_context',
        summary: 'The vault’s types, views, projects and counts',
        writes: false,
      },
      { name: 'search_notes', summary: 'Search titles, bodies and frontmatter', writes: false },
      { name: 'get_note', summary: 'Read one note in full', writes: false },
      {
        name: 'knowledge_about',
        summary: 'What the knowledge base already knows about one entity',
        writes: false,
      },
      { name: 'list_inbox', summary: 'Captures waiting to be filed', writes: false },
    ],
  },
  {
    id: 'write',
    label: 'Write to the vault',
    hint: 'Creates and edits notes — inside whatever scope is set below.',
    tools: [
      { name: 'create_note', summary: 'Create a note', writes: true },
      { name: 'update_frontmatter', summary: 'Patch a note’s frontmatter', writes: true },
      { name: 'append_to_note', summary: 'Add markdown to the end of a note', writes: true },
    ],
  },
  {
    id: 'knowledge',
    label: 'Knowledge and sources',
    hint: 'The agent-written bundle, which has its own guard — a concept still needs your stamp to count as verified.',
    tools: [
      { name: 'write_concept', summary: 'Record a concept in knowledge/', writes: true },
      {
        name: 'cache_source',
        summary: 'Save fetched external material under sources/',
        writes: true,
      },
    ],
  },
  {
    id: 'propose',
    label: 'Propose, don’t apply',
    hint: 'Shows the user an accept/reject card instead of writing.',
    tools: [{ name: 'propose_organize', summary: 'Suggest how to file a capture', writes: false }],
  },
  {
    id: 'ui',
    label: 'Move the app',
    hint: 'Changes what is on screen. Rarely what you want for an unattended run — it moves the user while they are working.',
    tools: [
      { name: 'open_note', summary: 'Open a note in the UI', writes: false },
      { name: 'navigate', summary: 'Go to a surface', writes: false },
    ],
  },
];

/**
 * The proposal toolset (M26.3c) — GENERATED from the shared policy artifact,
 * never typed out.
 *
 * The Rust server builds its half from the same `ops` table, so a hand-written
 * list here would be the second inventory the milestone's parity rules forbid:
 * it would drift the moment an op was added or an `agent_facing: false` was
 * set, and the drift would show up as a picker offering something the server
 * refuses.
 *
 * `writes: true` on every entry, and it is the honest answer even though a
 * proposal is not itself a mutation: LOW and MEDIUM ops AUTO-APPLY once
 * committed (12 of the 20), so "this selection can change something on disk"
 * is true. The picker's grouping axis is what a run can CHANGE, and a group
 * that read as harmless here would be a lie for exactly the ops most likely
 * to be picked.
 */
const PROPOSAL_TOOLS: ToolSpec[] = [
  ...agentFacingOps(POLICY).map((op) => ({
    name: `propose_${op}`,
    summary: `Propose ${op.replace(/_/g, ' ')} (${POLICY.ops[op].base_risk})`,
    writes: true,
  })),
  {
    name: 'commit_proposals',
    summary: 'Decide this run’s proposals as one atomic batch',
    writes: true,
  },
];

const PROPOSAL_TOOLSET: Toolset = {
  // NOT `propose` — that id already belongs to the M17-era set holding
  // `propose_organize`, and two sets sharing one id would make
  // `matchedToolset` answer with whichever came first.
  id: 'proposals',
  label: 'Propose changes to the knowledge base',
  hint: 'Suggests changes through the policy layer. Low- and medium-risk ones apply automatically once committed; high-risk ones wait for you on a card. Off unless the proposal surface is switched on.',
  tools: PROPOSAL_TOOLS,
};

// PUSHED INTO `TOOLSETS`, not unioned only into `ALL_TOOLS`. The pickers
// (AgentEditor, SkillEditor) build their checkboxes and group hints from
// TOOLSETS alone — so a set that existed only in ALL_TOOLS would pass every
// parity test while never appearing in the UI, and the person choosing a
// policy would have no way to grant or withhold the proposal surface.
TOOLSETS.push(PROPOSAL_TOOLSET);

/**
 * Tools the server serves that a person never picks (M26.4h).
 *
 * `report_window_outcome` belongs to the ingest driver's own runs and
 * `submit_answer` to an attended synthesis run: each is refused unless the app
 * opened that run's window or question, so putting either in a picker would
 * offer a checkbox that does nothing for every agent a person can build. Both
 * stay in `ALL_TOOLS`, because the catalog parity test scrapes the Rust
 * server's `base_tools()` and a tool served on one side and absent on the
 * other is exactly the drift that test exists to catch.
 */
const UNPICKABLE_TOOLS: ToolSpec[] = [
  {
    name: 'report_window_outcome',
    summary: 'Background ingest: report what this change-window concluded',
    writes: false,
  },
  {
    name: 'submit_answer',
    summary: 'Attended synthesis: submit the nine-part answer to this run’s question',
    writes: false,
  },
];

export const ALL_TOOLS: ToolSpec[] = [...TOOLSETS.flatMap((set) => set.tools), ...UNPICKABLE_TOOLS];

export function toolSpec(name: string): ToolSpec | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

/**
 * The toolset a picked set of names corresponds to, or null.
 *
 * Used to render "Read the vault" instead of four chips when the selection
 * happens to be exactly one group — the summary a person actually wants.
 */
export function matchedToolset(names: string[]): Toolset | null {
  return (
    TOOLSETS.find(
      (set) => set.tools.length === names.length && set.tools.every((t) => names.includes(t.name)),
    ) ?? null
  );
}

/** Names the app does not recognize — a hand-edited or stale `allowed-tools:`.
 * Surfaced rather than dropped: silently discarding one would rewrite the
 * user's policy on the next save. */
export function unknownTools(names: string[]): string[] {
  return names.filter((n) => toolSpec(n) === undefined);
}

/** True when this selection can change anything on disk. The one sentence a
 * tool picker owes the person using it. */
export function writesAnything(names: string[]): boolean {
  return names.some((n) => toolSpec(n)?.writes === true);
}
