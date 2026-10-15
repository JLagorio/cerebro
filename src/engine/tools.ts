/**
 * What the assistant can actually do (M18.4).
 *
 * The tool names are served by `src-tauri/src/mcp.rs` from
 * `shared/policy/tools.v1.json`, which is correct — that is where they are
 * served and where a narrowing is enforced.
 * But it left the UI with nothing to offer: `allowed-tools:` was a free-text
 * box, so choosing a policy meant knowing every identifier by heart and
 * getting each one exactly right. A typo did not error; it silently narrowed
 * the run to nothing, which looks identical to a model that decided not to act.
 *
 * So the picker reads the same manifest the server serves from (M54.2),
 * through `src/lib/policy/tools.ts`: its toolsets, each row's toolset and
 * summary, and whether a tool writes. The transcript's icons, write cards,
 * row renderers and read folds (M56.8), the end-of-turn checkpoint and the
 * run log's paths read it too. No tool is
 * listed here: a list typed out in this file would be a second inventory, and
 * it would drift the moment a row was added.
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
import { TOOLS, toolFacts, type FoldPhrases, type Renderer } from '@/lib/policy/tools';

export { bareToolName } from '@/lib/policy/tools';

export interface ToolSpec {
  name: string;
  /** One line, plain. Not the model-facing description, which is a paragraph. */
  summary: string;
  /** True when a successful call changes something on disk: its door's
   * `writes` flag in the manifest. */
  writes: boolean;
}

export interface Toolset {
  id: string;
  label: string;
  hint: string;
  tools: ToolSpec[];
}

/**
 * Does a successful call to `name` change something on disk? Read off the
 * manifest: the row's door, the generated door for an op the policy table
 * offers agents, or the CLI row. Either spelling, short or `mcp__cerebro__`;
 * false for a name the manifest does not know. A panel turn that called one
 * ends with a rescan (ChatTurnsHost); its commit is Rust's, made before the
 * run's Done (M58.3).
 */
export function isWriteTool(name: string): boolean {
  return toolFacts(name)?.writes === true;
}

/**
 * How a transcript draws a call to `name` (M56.8): the manifest's renderer,
 * or a step for a tool it does not know (another server's).
 */
export function toolRenderer(name: string): Renderer {
  return toolFacts(name)?.renderer ?? 'step';
}

/**
 * What a run of consecutive calls to `name` folds under (M56.8), or null for
 * a tool that never folds: a writer, a generated tool, another server's.
 */
export function toolFold(name: string): FoldPhrases | null {
  return toolFacts(name)?.fold ?? null;
}

/**
 * Does a transcript draw a call to `name` as a change card, its path visible
 * while collapsed and a diff on offer? The manifest's renderer says so for
 * the tools whose target names what they changed: a change, and a concept,
 * whose row adds the way to review it. A proposal writes through the ledger
 * and has no path to show, so it stays a step, and so does a commit.
 */
export function showsAsChange(name: string): boolean {
  const renderer = toolFacts(name)?.renderer;
  return renderer === 'change' || renderer === 'concept';
}

/** The lucide icon for a call to `name`, or the wrench for a tool the
 * manifest does not know: another server's, or a CLI tool it does not list. */
export function toolIconName(name: string): string {
  return toolFacts(name)?.icon ?? 'wrench';
}

/** A picker entry, its writes flag read off the manifest. */
function spec(name: string, summary: string): ToolSpec {
  return { name, summary, writes: isWriteTool(name) };
}

/**
 * The generated proposal tools (M26.3c), one per op the shared policy table
 * offers agents, named with the manifest's prefix. The Rust server builds its
 * half from the same `ops`, so an op added there is offered here the moment
 * it lands, and an `agent_facing: false` withdraws it from both.
 *
 * Each one writes, and that is the honest answer even though a proposal is
 * not itself a mutation: LOW and MEDIUM ops AUTO-APPLY once committed, so
 * "this selection can change something on disk" is true. The manifest says so
 * by sending the generated tools through the ledger door, which writes. The
 * picker's grouping axis is what a run can CHANGE, and a group that read as
 * harmless here would be a lie for exactly the ops most likely to be picked.
 */
const GENERATED_TOOLS: ToolSpec[] = agentFacingOps(POLICY).map((op) =>
  spec(
    `${TOOLS.generated.prefix}${op}`,
    `Propose ${op.replace(/_/g, ' ')} (${POLICY.ops[op].base_risk})`,
  ),
);

/**
 * The picker's groups, in the manifest's order. A set's tools are the
 * generated proposal tools first, when it is the generated block's toolset,
 * then the rows that name it, in served order.
 *
 * The pickers (AgentProperties, SkillEditor) build their checkboxes and group
 * hints from TOOLSETS alone, so a tool that reached only `ALL_TOOLS` would
 * never appear in the UI, and the person choosing a policy could neither
 * grant nor withhold it.
 */
export const TOOLSETS: Toolset[] = TOOLS.toolsets.map(({ id, label, hint }) => ({
  id,
  label,
  hint,
  tools: [
    ...(id === TOOLS.generated.toolset ? GENERATED_TOOLS : []),
    ...TOOLS.tools.filter((row) => row.toolset === id).map((row) => spec(row.name, row.summary)),
  ],
}));

/**
 * Tools the server serves that a person never picks (M26.4h): the rows with
 * no toolset.
 *
 * `report_window_outcome` belongs to the ingest driver's own runs and
 * `submit_answer` to an attended synthesis run: each is refused unless the app
 * opened that run's window or question, so putting either in a picker would
 * offer a checkbox that does nothing for every agent a person can build. They
 * stay in `ALL_TOOLS`, so `unknownTools` still knows them: a served tool
 * flagged as unknown would invite someone to delete it from a working policy.
 */
const UNPICKABLE_TOOLS: ToolSpec[] = TOOLS.tools
  .filter((row) => row.toolset === null)
  .map((row) => spec(row.name, row.summary));

export const ALL_TOOLS: ToolSpec[] = [...TOOLSETS.flatMap((set) => set.tools), ...UNPICKABLE_TOOLS];

/** The proposal set's names: the generated tools and the rows filed beside
 * them (commit_proposals). */
const PROPOSAL_TOOLS = new Set(
  TOOLSETS.find((set) => set.id === TOOLS.generated.toolset)?.tools.map((t) => t.name) ?? [],
);

export function toolSpec(name: string): ToolSpec | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

/**
 * What an armed agent's proposals DO (M36.5) — consequence, not membership.
 *
 * Derived from the SHARED policy artifact, never typed out: the counts are
 * the same table Rust gates against, so the sentence on the agent's page and
 * the behavior at the channel cannot drift. LOW and MEDIUM auto-apply once
 * committed; HIGH waits on a card. The escalator sentence is rendered beside
 * these but needs no derivation — `target_has_attestation → floor HIGH` has
 * shipped in the artifact since M27.4.
 */
export function proposalConsequence(): { applies: number; queues: number } {
  const ops = agentFacingOps(POLICY);
  const queues = ops.filter((op) => POLICY.ops[op].base_risk === 'HIGH').length;
  return { applies: ops.length - queues, queues };
}

/** True when this selection reaches the proposal channel at all — the
 * consequence table is rendered for armed agents only; an unarmed agent
 * gets no table about weapons it does not carry. */
export function holdsProposalTools(names: readonly string[] | null): boolean {
  if (names === null) return false;
  return names.some((n) => PROPOSAL_TOOLS.has(n));
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
