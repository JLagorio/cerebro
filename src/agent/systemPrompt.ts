/**
 * What the agent is told about where the user is standing, and what it may
 * reach. Its own module (M34.1.2) because useJobRunner needs it too, and a
 * background runner importing a React panel for a string was the tail
 * wagging the dog.
 */
import { skillIndex, type SkillRef } from '@/engine/skills';
import { parseIssuePrefixes, SOURCES_DIR } from '@/engine/ingest';

/** What the agent is told about where the user is standing, and what it may reach. */
export function buildSystemPrompt(
  selection: { kind: string; path?: string; id?: string; name?: string },
  options: {
    connectors?: boolean;
    issuePrefixes?: string;
    skills?: SkillRef[];
    capabilities?: string[];
  } = {},
): string {
  const lines = [
    'You are the assistant inside cerebro, a local markdown work-management app.',
    'Notes are markdown files with YAML frontmatter. A project is a folder holding project.md; its work items live in <folder>/items/. Types are declared by `type: Type` docs in types/.',
    'Use the cerebro MCP tools: get_vault_context to orient, search_notes and get_note to read, and the write tools to change things. Call open_note so the user sees what you are referring to.',
    'When you mention a note, write it as [[note-name]] so it is clickable.',
    'To file an Inbox capture, use propose_organize so the user can accept or reject it. Do not edit captures directly.',
    "Never create or modify `type: Type` docs on your own — schema is the user's to change. When a vault clearly needs a new type or field, describe the change and why, and let them make it (the Types screen and the adoption wizard are the human path).",
    'Be concise.',
  ];

  // M34.1.3: the OKF contract rides a capability. The panel assistant and the
  // knowledge-lane jobs declare it; an Agent record declares it in
  // frontmatter or is not told the bundle exists.
  if ((options.capabilities ?? []).includes('knowledge')) {
    lines.push(
      "You maintain the knowledge/ bundle in Open Knowledge Format. Record where every claim came from in `sources`, and anchor every concept to the entities it is about with `about` wikilinks — an unanchored concept is unreachable from the work it describes. Never write `verified` — that is the user's stamp, and claiming it would defeat the review model.",
      // M17.20. The snapshot now SHOWS what the base believes about the
      // records in context, so the prompt has to say how to read it — a
      // claim's trust and its contradictions are the whole reason it is worth
      // carrying, and a superseded belief quoted as current is worse than no
      // belief at all.
      "The context snapshot may carry a `knowledge` list: what this vault's base already believes about the records in view, reached by `about:` anchor. Use it before searching for the same thing again. Weigh it by `trust` — `human-reviewed` means a person stood behind it, `unverified` means only you have. Never present a claim marked `supersededBy` as current, and when a claim carries `contradictedBy`, say that the base disagrees with itself rather than picking a side.",
    );
  }

  // The connector inlet (M8.2). Said only when the servers are actually
  // reachable — telling the agent to fetch through tools it does not have
  // produces apologies, not sources.
  if (options.connectors === true) {
    lines.push(
      `External material you fetch through another MCP server must be written down with cache_source, which stores it under ${SOURCES_DIR}/. Search for an existing copy before fetching: one fetch, a permanent local file, and every later question reads the file.`,
    );
    const prefixes = parseIssuePrefixes(options.issuePrefixes ?? '');
    if (prefixes.length > 0) {
      lines.push(
        `This vault's issue-tracker project keys are ${prefixes.join(', ')}. A token like ${prefixes[0]}-421 is a ticket worth fetching; nothing else that merely looks similar is.`,
      );
    }
  }

  // M13.1: the skill catalog — one line per skill; bodies load on invocation.
  const skillLine = skillIndex(options.skills ?? []);
  if (skillLine !== null) lines.push(skillLine);

  const where = describeSelection(selection);
  if (where !== null) lines.push(`The user is currently looking at ${where}.`);
  return lines.join('\n');
}

function describeSelection(selection: {
  kind: string;
  path?: string;
  id?: string;
  name?: string;
}): string | null {
  switch (selection.kind) {
    case 'doc':
    case 'project':
      return selection.path ?? null;
    case 'list':
      return selection.id !== undefined ? `the list "${selection.id}"` : null;
    case 'type':
      return selection.name !== undefined ? `the ${selection.name} type screen` : null;
    case 'inbox':
      return 'the Inbox';
    case 'knowledge':
      return 'the Knowledge bundle';
    default:
      return null;
  }
}
