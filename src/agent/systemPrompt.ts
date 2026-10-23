/**
 * What the agent is told about where the user is standing, and what it may
 * reach. Its own module (M34.1.2) because useJobRunner needs it too, and a
 * background runner importing a React panel for a string was the tail
 * wagging the dog.
 *
 * Every line is a typed fragment that declares the tools it names, said only
 * to a run that holds them all (M54.7). A narrowed run told to call a tool it
 * lacks plans around a call that will be refused, and a background run told
 * to call open_note moves the screen of a person who is not watching. The
 * vault's rules hold for every run, whatever it holds, so they are not here:
 * `shared/prompt/server-instructions.md`, which the loopback serves as its
 * MCP `instructions` (mcp.rs, `initialize_result`). The product brief holds
 * for every run too and opens every prompt (M54.8): it is context, not a
 * rule, and get_vault_context ends with the same words.
 */
import SERVER_INSTRUCTIONS from '../../shared/prompt/server-instructions.md?raw';
import { kindFor } from '@/engine/fileKinds';
import { skillIndex, type SkillRef } from '@/engine/skills';
import { parseIssuePrefixes, SOURCES_DIR } from '@/engine/ingest';
import { editsNotes, holds, type PromptGrant } from '@/engine/toolGrant';
import { toolSpec } from '@/engine/tools';
import { PRODUCT_BRIEF } from '@/lib/productBrief';

export interface SystemPromptOptions {
  connectors?: boolean;
  issuePrefixes?: string;
  skills?: SkillRef[];
  capabilities?: string[];
  /** What the run holds (M54.7). Required: a prompt composed without one
   * could only guess which tools to name. */
  grant: PromptGrant;
  /** Vault paths of the files the person attached (M91.17), which the
   * context snapshot lists by path and kind. */
  attachments?: readonly string[];
}

/** One line of the system prompt (M54.7). */
export interface Fragment {
  id: string;
  /** Context describes, an instruction asks, a prohibition forbids. A
   * prohibition names no tool: it binds every run it is said to. */
  kind: 'context' | 'instruction' | 'prohibition';
  /** Every cerebro tool `text` names. The fragment is said only to a run that
   * holds them all. */
  uses: readonly string[];
  text: string;
  /** Said only when this holds as well. */
  when?: (grant: PromptGrant, options: SystemPromptOptions) => boolean;
}

/** Holds the M34.1.3 capability that carries the OKF contract. */
const knowsTheBundle = (_grant: PromptGrant, options: SystemPromptOptions) =>
  (options.capabilities ?? []).includes('knowledge');

/** Who is speaking. What cerebro is follows it, in the brief. */
const IDENTITY: Fragment = {
  id: 'identity',
  kind: 'context',
  uses: [],
  text: 'You are the assistant inside cerebro.',
};

/** What cerebro is (M54.8): shared/prompt/product-brief.md, the one product
 * description the model reads, which get_vault_context ends with too. It
 * names no tool, and it leaves the knowledge bundle to the fragments the
 * declared capability turns on (M34.1.3), so it is said to every grant. */
const BRIEF: Fragment = {
  id: 'brief',
  kind: 'context',
  uses: [],
  text: PRODUCT_BRIEF,
};

/** Closes the tools line, and only on a run someone is watching: open_note
 * moves the person's screen. */
const OPEN_NOTE: Fragment = {
  id: 'open-note',
  kind: 'instruction',
  uses: ['open_note'],
  text: 'Call open_note so the user sees what you are referring to.',
  when: (grant) => grant.attended,
};

/** The M9.5 sentence, byte for byte, and changed only with the owner's
 * sign-off: filing a capture is a proposal the user accepts or rejects. */
const ORGANIZE: Fragment = {
  id: 'organize',
  kind: 'instruction',
  uses: ['propose_organize'],
  text: 'To file an Inbox capture, use propose_organize so the user can accept or reject it. Do not edit captures directly.',
};

/** What a run without propose_organize keeps of the M9.5 sentence, said only
 * to one that could edit a capture: through a note editor, or the shell. */
const ORGANIZE_FALLBACK: Fragment = {
  id: 'organize-fallback',
  kind: 'prohibition',
  uses: [],
  text: 'Do not edit captures directly.',
  when: (grant) => !holds(grant, 'propose_organize') && editsNotes(grant),
};

const CONCISE: Fragment = { id: 'concise', kind: 'instruction', uses: [], text: 'Be concise.' };

// M34.1.3: the OKF contract rides a capability. The panel assistant and the
// knowledge-lane jobs declare it; an Agent record declares it in frontmatter
// or is not told the bundle exists.
const KNOWLEDGE: Fragment = {
  id: 'knowledge',
  kind: 'instruction',
  uses: [],
  text: "You maintain the knowledge/ bundle in Open Knowledge Format. Record where every claim came from in `sources`, and anchor every concept to the entities it is about with `about` wikilinks — an unanchored concept is unreachable from the work it describes. Never write `verified` — that is the user's stamp, and claiming it would defeat the review model.",
  when: knowsTheBundle,
};

// M17.20. The snapshot SHOWS what the base believes about the records in
// context, so the prompt has to say how to read it — a claim's trust and its
// contradictions are the whole reason it is worth carrying, and a superseded
// belief quoted as current is worse than no belief at all. M52.3 carries
// learned-from concepts too, and a note's `relation` is the only thing
// telling them apart.
const KNOWLEDGE_SNAPSHOT: Fragment = {
  id: 'knowledge-snapshot',
  kind: 'instruction',
  uses: [],
  text: "The context snapshot may carry a `knowledge` list: what this vault's base already believes about the records in view — concepts anchored to them with `about:`, and concepts learned from them. Each note's `relation` says which: `about` means the record at `about` is its subject; `learned from` means that record is one of its sources, so the concept records what was concluded from it, not necessarily what it is about. Use it before searching for the same thing again. Weigh it by `review` and `reviewedBy`: `current` with `reviewedBy: human` means a person stood behind what it says now; `predates_current` means a person reviewed an earlier version; `unreviewed` means only an agent has; `disputed` means the file claims a review its recorded history does not hold, so treat it as unreviewed. Never present a claim marked `supersededBy` as current. A claim with `replacementProposedBy` is STILL current — something proposed replacing it and nobody has agreed. When a claim carries `contradictedBy`, say that the base disagrees with itself rather than picking a side.",
  when: knowsTheBundle,
};

// The two fetch lines: what the run fetches is written down with cache_source,
// so each is said only to a run that holds it, and only when the run can
// fetch at all. Telling an agent to fetch and cache through tools it does not
// have produces apologies, not sources.
//
// The cached-source inlet (M8.2): said when Settings switched connectors on. The
// switch is not yet the run's own connector grant.
const CACHE_SOURCES: Fragment = {
  id: 'cache-sources',
  kind: 'instruction',
  uses: ['cache_source'],
  text: `Tickets and pages you fetch through another MCP server must be written down with cache_source, which stores it under ${SOURCES_DIR}/. Search for an existing copy before fetching: one fetch, a permanent local file, and every later question reads the file. Mail is the exception: a message, a thread or a mail link is never written down as a web copy.`,
  when: (_grant, options) => options.connectors === true,
};

/** Imported pages use the fetch's own result, not a model transcription. */
const NOTION_IMPORT: Fragment = {
  id: 'notion-import',
  kind: 'instruction',
  uses: ['import_notion_page'],
  text: "When the user asks to import a Notion page, fetch it with their Notion connector in this same turn, then call import_notion_page with the page's link and a folder. Never write the page out yourself unless the import refuses and says you may.",
  when: (_grant, options) => options.connectors === true,
};

// The web inlet (M57.7): said to a run that holds Claude Code's WebFetch (the
// grant's `web`, by the table), which also finds pages with WebSearch. The
// CLI's tools are not cerebro's, so `uses` names only cache_source.
const WEB_SOURCES: Fragment = {
  id: 'web-sources',
  kind: 'instruction',
  uses: ['cache_source'],
  text: `Pages you fetch with WebFetch or find with WebSearch must be written down with cache_source (kind web, the URL as its id), which keeps them under ${SOURCES_DIR}/. Search for a copy before fetching: one fetch, a local file, and later questions read the file.`,
  when: (grant) => grant.web === true,
};

/** The prompt's fixed fragments, each with the tools it names. The rest are
 * built per run: the tools line, the issue keys, the skill catalogue and
 * where the user is standing. */
export const SYSTEM_FRAGMENTS: readonly Fragment[] = [
  IDENTITY,
  BRIEF,
  OPEN_NOTE,
  ORGANIZE,
  ORGANIZE_FALLBACK,
  CONCISE,
  KNOWLEDGE,
  KNOWLEDGE_SNAPSHOT,
  CACHE_SOURCES,
  NOTION_IMPORT,
  WEB_SOURCES,
];

/**
 * Whether the prompt also says the rules the server instructions hold
 * (M54.7). Off: they hold on every run, so the loopback serves them once, as
 * its MCP `instructions`, which the CLI keeps as a session meta message.
 * Whether a resumed turn (`--resume`) still hears them is the owner's live
 * check on CLI 2.1.250 to settle. If it does not, this turns on, and every
 * rule rides this prompt as well, after the tools line, as the fallback
 * golden in systemPrompt.test.ts pins.
 */
export const SERVER_RULES_IN_PROMPT = false;

/** The server instructions' rules, one per bullet. */
const SERVER_RULES: readonly string[] = SERVER_INSTRUCTIONS.split('\n')
  .filter((line) => line.startsWith('- '))
  .map((line) => line.slice(2).trim());

/** The tools line's reading clause names whichever of these the run holds. */
const READERS = ['search_notes', 'get_note'];

/** What the agent is told about where the user is standing, and what it may reach. */
export function buildSystemPrompt(
  selection: { kind: string; path?: string; id?: string; name?: string },
  options: SystemPromptOptions,
  /** Say the server instructions' rules here too. Every caller leaves it to
   * the switch; the tests set it to pin both branches. */
  serverRules: boolean = SERVER_RULES_IN_PROMPT,
): string {
  const { grant } = options;
  const say = (fragment: Fragment): string[] =>
    holds(grant, ...fragment.uses) && (fragment.when?.(grant, options) ?? true)
      ? [fragment.text]
      : [];
  const tools = [...toolsSentence(grant), ...say(OPEN_NOTE)].join(' ');

  const lines = [
    ...say(IDENTITY),
    ...say(BRIEF),
    ...(tools === '' ? [] : [tools]),
    ...(serverRules ? SERVER_RULES : []),
    ...say(ORGANIZE),
    ...say(ORGANIZE_FALLBACK),
    ...say(CONCISE),
    ...say(KNOWLEDGE),
    ...say(KNOWLEDGE_SNAPSHOT),
    ...say(CACHE_SOURCES),
    ...say(NOTION_IMPORT),
    ...say(WEB_SOURCES),
  ];

  // The issue keys name no tool, so they keep their M8.2 rule: said whenever
  // the connector switch is on.
  const prefixes =
    options.connectors === true ? parseIssuePrefixes(options.issuePrefixes ?? '') : [];
  if (prefixes.length > 0) {
    lines.push(
      `This vault's issue-tracker project keys are ${prefixes.join(', ')}. A token like ${prefixes[0]}-421 is a ticket worth fetching; nothing else that merely looks similar is.`,
    );
  }

  // M13.1: the skill catalog — one line per skill; bodies load on invocation.
  const skillLine = skillIndex(options.skills ?? [], grant);
  if (skillLine !== null) lines.push(skillLine);

  for (const fragment of attachmentFragments(options.attachments ?? [], grant)) {
    lines.push(...say(fragment));
  }

  const where = describeSelection(selection);
  if (where !== null) lines.push(`The user is currently looking at ${where}.`);
  return lines.join('\n');
}

/**
 * "Use the cerebro MCP tools: …", with a clause for each kind of tool the run
 * holds: get_vault_context to orient, its readers to read, and any tool that
 * writes to change things. Nothing for a run that holds none of them.
 */
function toolsSentence(grant: PromptGrant): string[] {
  const clauses: string[] = [];
  if (holds(grant, 'get_vault_context')) clauses.push('get_vault_context to orient');
  const readers = READERS.filter((name) => holds(grant, name));
  if (readers.length > 0) clauses.push(`${readers.join(' and ')} to read`);
  if ([...grant.tools].some((name) => toolSpec(name)?.writes === true)) {
    clauses.push('the write tools to change things');
  }
  return clauses.length === 0 ? [] : [`Use the cerebro MCP tools: ${series(clauses)}.`];
}

/** Claude Code's own reader, by the name its tool answers to. */
const CLI_READ = 'Read';

/** The extractors read_document opens: the Office rows, which files/read.rs
 * hands to its Office reader. The PDF row's extractor is the Inbox's own
 * capture; read_document refuses PDFs and pictures, which Read opens. */
const OFFICE_EXTRACTORS: ReadonlySet<string> = new Set(['docx', 'pptx', 'xlsx']);

/** The viewers that show a file as text, a picture or a PDF: what Claude
 * Code's Read opens as well. */
const READ_VIEWERS: ReadonlySet<string> = new Set(['doc', 'code', 'table', 'image', 'pdf']);

/**
 * What opens an attached file (M91.17), by its row in the file-kinds table:
 * read_canvas a board, read_document an Office file, and Claude Code's Read
 * anything the app shows as text, a picture or a PDF. Null for the rest —
 * audio, video, archives, a format nothing parses — which no run opens.
 */
export function attachmentReader(path: string): string | null {
  const row = kindFor(path);
  if (row.kind === 'whiteboard') return 'read_canvas';
  if (row.extractor !== null && OFFICE_EXTRACTORS.has(row.extractor)) return 'read_document';
  if (row.kind === 'unknown' || row.kind === 'binary') return null;
  return READ_VIEWERS.has(row.viewer) ? CLI_READ : null;
}

/** Does the run hold `reader`: one of cerebro's tools by name, Read as the
 * grant's `read` says. */
function holdsReader(grant: PromptGrant, reader: string): boolean {
  return reader === CLI_READ ? grant.read === true : holds(grant, reader);
}

const quoted = (paths: readonly string[]) => series(paths.map((path) => `\`${path}\``));

/**
 * What the run is told about the files the person attached (M91.17): which
 * reader it holds opens each, a line per reader, and one line for the files
 * nothing it holds opens, so it says so rather than guessing at them. Each
 * declares the cerebro tool it names; Read is said only to a run that holds
 * it, as the web line names WebFetch. Exported for the tests, which hold
 * every line to what it names.
 */
export function attachmentFragments(
  paths: readonly string[],
  grant: PromptGrant,
): readonly Fragment[] {
  const opened = new Map<string, string[]>();
  const closed: string[] = [];
  for (const path of new Set(paths)) {
    const reader = attachmentReader(path);
    if (reader !== null && holdsReader(grant, reader)) {
      opened.set(reader, [...(opened.get(reader) ?? []), path]);
    } else {
      closed.push(path);
    }
  }
  const fragments: Fragment[] = [...opened].map(([reader, files]) => {
    const them = files.length === 1 ? 'it' : 'them';
    const cli = reader === CLI_READ;
    return {
      id: `attached-${reader}`,
      kind: 'instruction',
      uses: cli ? [] : [reader],
      text: `The person attached ${quoted(files)}: open ${them} with ${cli ? 'your Read tool' : reader}.`,
      ...(cli ? { when: (held: PromptGrant) => held.read === true } : {}),
    };
  });
  if (closed.length > 0) {
    const one = closed.length === 1;
    fragments.push({
      id: 'attached-closed',
      kind: 'context',
      uses: [],
      text: `The person attached ${quoted(closed)}, which you can't open here: nothing this conversation holds reads ${one ? 'it' : 'them'}. If the question needs what ${one ? 'it holds' : 'they hold'}, say so.`,
    });
  }
  return fragments;
}

/** "a", "a and b", or "a, b, and c". */
function series(items: readonly string[]): string {
  return items.length <= 2
    ? items.join(' and ')
    : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
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
