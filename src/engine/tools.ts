/**
 * What the assistant can actually do (M18.4).
 *
 * The tool names have only ever existed in `src-tauri/src/mcp.rs`, which is
 * correct — that is where they are served and where a narrowing is enforced.
 * But it left the UI with nothing to offer: `allowed-tools:` was a free-text
 * box, so choosing a policy meant knowing thirteen identifiers by heart and
 * getting each one exactly right. A typo did not error; it silently narrowed
 * the run to nothing, which looks identical to a model that decided not to act.
 *
 * So this is a MIRROR, and it is tested as one (tools.test.ts parses mcp.rs and
 * fails if the two lists diverge) — the same parity discipline the mock backend
 * already carries for the Rust write guards.
 *
 * ## Toolsets
 *
 * Grouped the way ClickUp groups them, for the reason they do: nobody picks
 * thirteen checkboxes. They pick "reading" or "reading and writing", and the
 * individual tools are there for the one case that needs a scalpel. The groups
 * are drawn on the axis that matters here — what a run can CHANGE — so the
 * dangerous ones cannot hide in a bundle labelled after a workflow.
 */

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

export const ALL_TOOLS: ToolSpec[] = TOOLSETS.flatMap((set) => set.tools);

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
