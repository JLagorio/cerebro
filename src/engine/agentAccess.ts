/**
 * Who can change a page, and why (M58.6).
 *
 * Every row is derived, never restated: what an agent may read or change on
 * a page comes from the tool manifest's rows (`tools.v1.json`), the
 * tool-approval table's plan for the run it would be (`plan`), and the
 * record's own axes. Nothing here types a tool list or a decision table, so a
 * new note writer or a new ceiling reaches this explanation with no edit.
 *
 * From Macro (behaviour only): an explanation lists every path that grants
 * access plus the strongest, and "none" is an answer. Cerebro differs on
 * purpose: rows are per agent, the paths are scope, shell and grant, and
 * calling never lends (a hand-off keeps the callee's own axes).
 *
 * Twins Rust in three places, each held: the folder parse
 * (`agents.parseFolders`) and `scopeAdmits` by
 * src-tauri/fixtures/grant-scope.json, `GOVERNED_TYPES` and `OWN_NOTES_TOOL`
 * by tripwires that read src-tauri/src/mcp.rs. The own-notes mirror explains
 * Rust's one crossing (D7) and never decides it; if Rust narrows it, this
 * overclaims until the tripwire is followed.
 *
 * Pure: engine/ reads it, and tsconfig.engine.json typechecks it without the
 * DOM.
 */

import { TOOLS, type ToolRow } from '@/lib/policy/tools';
import {
  effectiveCeiling,
  plan,
  TOOL_APPROVAL,
  type RunApproval,
  type RunKind,
  type ShellCeiling,
} from '@/lib/policy/toolApproval';
import { listAgents, type AgentRef } from './agents';
import { ASSISTANT_ACTOR } from './authors';
import { agentActive, agentDraft } from './libraryDraft';
import { SOURCES_DIR } from './ingest';
import { isKnowledgePath, KNOWLEDGE_DIR } from './okf';
import { grantedTools, namesTool } from './toolGrant';
import type { Entry } from './types';

// --- Scope ---------------------------------------------------------------

/**
 * Does a folder scope admit `path`? The twin of Rust's `scope_admits`: null
 * admits every path and [] none; a folder admits itself and its descendants,
 * matched at a separator so `work` never admits `workspace/`. The path loses
 * every leading `./` and then its leading `/`, each folder its outer `/`, and
 * an empty folder admits everything. Case, Unicode form and `..` compare as
 * written.
 */
export function scopeAdmits(scope: readonly string[] | null, path: string): boolean {
  if (scope === null) return true;
  const target = path.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
  return scope.some((raw) => {
    const folder = raw.replace(/^\/+|\/+$/g, '');
    return folder === '' || target === folder || target.startsWith(`${folder}/`);
  });
}

// --- What the manifest says ---------------------------------------------

/** The manifest's door ids this reads by (tools.v1.json `doors`). */
const NOTE_DOOR = 'note';
const READ_DOOR = 'none';
const CONCEPT_DOOR = 'concept';
const SOURCE_DOOR = 'source';

/** Tools that change a page already on disk: the note door's rows aimed at a
 * note. create_note's target is a folder, so it never changes an existing
 * page. */
const PAGE_WRITERS: readonly ToolRow[] = TOOLS.tools.filter(
  (row) => row.door === NOTE_DOOR && row.target?.kind === 'note',
);

/** Tools that read pages: the read door's rows, less the bundle's reader. */
const PAGE_READERS: readonly ToolRow[] = TOOLS.tools.filter(
  (row) => row.door === READ_DOOR && row.axis === 'read' && row.target?.kind !== 'bundle',
);

/** Tools that write through Knowledge's own doors. */
const BUNDLE_WRITERS: readonly ToolRow[] = TOOLS.tools.filter(
  (row) => row.door === CONCEPT_DOOR || row.door === SOURCE_DOOR,
);

/**
 * The bundle's update log, which Rust appends on every concept write
 * (`knowledge::LOG_PATH`, held by a tripwire in agentAccess.test.ts).
 */
export const KNOWLEDGE_LOG = `${KNOWLEDGE_DIR}/log.md`;

/**
 * The Knowledge-door tools that change a page past every write scope, by the
 * page they reach. Rust exempts both doors from the scope on purpose
 * (`grant_admission` in src-tauri/src/mcp.rs) and neither reads first:
 * the source door rewrites a cached copy under sources/ that holds a source
 * id (`source_target`), and the concept door's content writers (the rows
 * that take a `body`) append the log. recheck_concept moves a stamp and
 * logs nothing.
 */
const DOOR_WRITERS: Record<BundlePage, readonly ToolRow[]> = {
  source: BUNDLE_WRITERS.filter((row) => row.door === SOURCE_DOOR),
  log: BUNDLE_WRITERS.filter((row) => row.door === CONCEPT_DOOR && takes(row, 'body')),
};

/** Does a row's input schema declare `property`? */
function takes(row: ToolRow, property: string): boolean {
  const schema = row.input_schema as { properties?: unknown } | null;
  const properties = schema?.properties;
  return typeof properties === 'object' && properties !== null && property in properties;
}

/**
 * The types agents may never write, exactly as the scanner spells them: Rust
 * refuses a write to either in `governed_type_refusal` (src-tauri/src/mcp.rs),
 * and agentAccess.test.ts reads that match to hold this list to it.
 */
export const GOVERNED_TYPES = ['Agent', 'Type'] as const;

/**
 * The one tool that may cross onto a run's own Agent record (D7, M56.10):
 * `own_memory_record` in src-tauri/src/mcp.rs admits it there, `recent`
 * alone. Rust's only named crossing, mirrored by name and held by a
 * tripwire in agentAccess.test.ts.
 */
export const OWN_NOTES_TOOL = 'update_frontmatter';

const SERVER_PREFIX = `mcp__${TOOLS.server}__`;

/** The families whose tools change files: the ones acceptEdits would approve
 * with no host. */
const CHANGING_FAMILIES = new Set(
  TOOL_APPROVAL.families.filter((family) => family.needs_default_mode).map((family) => family.id),
);

/** The families that read files: those a read limit withdraws that change
 * nothing. */
const READING_FAMILIES = new Set(
  Object.keys(TOOL_APPROVAL.read_scope).filter((family) => !CHANGING_FAMILIES.has(family)),
);

// --- One row --------------------------------------------------------------

/** How far a run reaches a page: strongest first. */
export type Reach = 'yes' | 'asks' | 'own-notes' | 'none';

const RANK: Record<Reach, number> = { yes: 3, asks: 2, 'own-notes': 1, none: 0 };

function strongest(...reaches: Reach[]): Reach {
  return reaches.reduce((best, next) => (RANK[next] > RANK[best] ? next : best), 'none');
}

/** A run's axes as its record gives them; the plain panel holds every one. */
export interface GrantAxes {
  scope: string[] | null;
  readScope: string[] | null;
  allowedTools: string[] | null;
  /** Does the record declare the shell (`tools: shell`)? Null for the
   * plain panel, which runs at the Settings ceiling. */
  shell: boolean | null;
  askFirst: boolean;
}

/** Why the shell a record declares is withheld, in `plan()`'s order. */
export type ShellWithheld = 'ceiling' | 'read-limit' | 'narrowing';

/** A page a Knowledge door rewrites whatever the write scope says. */
export type BundlePage = 'source' | 'log';

/** What the page is, as the rules it meets see it. */
export interface PageKind {
  governed: (typeof GOVERNED_TYPES)[number] | null;
  knowledge: boolean;
  /** A cached source or the bundle's log: the Knowledge door that reaches
   * it past the scope. */
  bundle: BundlePage | null;
}

export interface AccessRow {
  /** The stamp its writes carry. */
  actor: string;
  title: string;
  /** Its record's path; null for the plain panel. */
  path: string | null;
  /** The assistant panel's row. */
  panel: boolean;
  /** The record the panel answers as, by title; null when unbound. */
  boundTo: string | null;
  axes: GrantAxes;
  page: PageKind;
  /** Does its write scope admit the page? */
  inScope: boolean;
  /** The titles of the page writers it holds, in manifest order. */
  heldWriters: string[];
  /** The titles of the page writers that reach the page. */
  writers: string[];
  /** The titles of the Knowledge-door tools it holds that change this page
   * past its write scope. */
  doorWriters: string[];
  /** Held writers that also need the page inside the read scope. */
  needsRead: string[];
  /** It may rewrite its notes on this, its own record. */
  ownNotes: boolean;
  /** Reach through Cerebro's tools, by run kind. */
  tools: { attended: Reach; unattended: Reach };
  /** Reach through the CLI's file and shell tools, by run kind. */
  shell: { attended: Reach; unattended: Reach; withheld: ShellWithheld | null };
  /** The strongest reach, by run kind and overall. */
  attended: Reach;
  unattended: Reach;
  write: Reach;
  read: boolean;
  /** It holds some way to read a page. */
  reads: boolean;
  /** It can run with nobody watching: an agent that is not paused. */
  runsUnattended: boolean;
  paused: boolean;
  /** Its schedule and trigger count, when on duty. */
  duty: { schedule: string; triggers: number } | null;
}

/** The runs a page's rows are asked about. */
export interface PageAccessInput {
  entries: Entry[];
  path: string;
  /** The page's `type:`. */
  type: string | null;
  /** The Settings shell ceiling. */
  shell: ShellCeiling;
  /** The handle the panel is bound to (M56.6), null when unbound. */
  panelAgent: string | null;
}

export interface PageAccess {
  /** How many agents the vault holds. */
  agents: number;
  /** How many of them can change the page (the panel not counted). */
  canChange: number;
  rows: AccessRow[];
}

function narrowingOf(allowed: readonly string[] | null): ((tool: string) => boolean) | null {
  return allowed === null ? null : (tool) => allowed.some((entry) => namesTool(entry, tool));
}

function planFor(kind: RunKind, axes: GrantAxes, ceiling: ShellCeiling): RunApproval {
  return plan({
    kind,
    shell: effectiveCeiling(ceiling, axes.shell),
    askFirst: axes.askFirst,
    readScoped: axes.readScope !== null,
    narrowing: narrowingOf(axes.allowedTools),
  });
}

/** What a plan lets the CLI's changing tools do: allowed, asked, or not. */
function shellReach(approval: RunApproval): Reach {
  const changing = approval.decisions.filter((d) => CHANGING_FAMILIES.has(d.family));
  if (changing.some((d) => d.decision === 'allow')) return 'yes';
  if (changing.some((d) => d.decision === 'ask')) return 'asks';
  return 'none';
}

/** A page writer's reach under a plan: its ask-first ask or queue is an
 * ask, a refusal is none, anything else writes. */
function writerReach(approval: RunApproval, row: ToolRow): Reach {
  const decision = approval.decisions.find((d) => d.tool === `${SERVER_PREFIX}${row.name}`);
  switch (decision?.decision) {
    case 'ask':
    case 'queue':
      return 'asks';
    case 'deny':
    case 'refuse':
      return 'none';
    default:
      return 'yes';
  }
}

function withheldOf(axes: GrantAxes, ceiling: ShellCeiling, attended: Reach): ShellWithheld | null {
  if (axes.shell !== true || attended !== 'none') return null;
  if (ceiling === 'off') return 'ceiling';
  if (axes.readScope !== null) return 'read-limit';
  return 'narrowing';
}

interface RowSeed {
  actor: string;
  title: string;
  path: string | null;
  panel: boolean;
  boundTo: string | null;
  axes: GrantAxes;
  /** This record answers its handle alone. */
  sole: boolean;
  paused: boolean;
  duty: { schedule: string; triggers: number } | null;
}

function deriveRow(seed: RowSeed, input: PageAccessInput, page: PageKind): AccessRow {
  const { axes } = seed;
  const held = grantedTools(axes.allowedTools);
  const heldWriters = PAGE_WRITERS.filter((row) => held.has(row.name));
  const inScope = scopeAdmits(axes.scope, input.path);
  const readable = scopeAdmits(axes.readScope, input.path);
  const needsRead = heldWriters
    .filter((row) => row.axis === 'read_write' && !readable)
    .map((row) => row.title);
  const reaching = heldWriters.filter((row) => row.axis !== 'read_write' || readable);
  const doorWriters =
    page.bundle === null || page.governed !== null
      ? []
      : DOOR_WRITERS[page.bundle].filter((row) => held.has(row.name));
  const ownNotes =
    page.governed === 'Agent' &&
    seed.path === input.path &&
    seed.sole &&
    seed.actor.startsWith('process:') &&
    held.has(OWN_NOTES_TOOL);

  const runsUnattended = !seed.panel && !seed.paused;
  const kinds: RunKind[] = runsUnattended ? ['attended', 'unattended'] : ['attended'];
  const reach = { attended: 'none' as Reach, unattended: 'none' as Reach };
  const shell = { attended: 'none' as Reach, unattended: 'none' as Reach };
  let attendedPlan: RunApproval | null = null;
  for (const kind of kinds) {
    const approval = planFor(kind, axes, input.shell);
    if (kind === 'attended') attendedPlan = approval;
    const viaDoor = strongest(...doorWriters.map((row) => writerReach(approval, row)));
    let tools: Reach;
    if (page.knowledge) tools = viaDoor;
    else if (page.governed !== null) tools = ownNotes ? 'own-notes' : 'none';
    else if (inScope) {
      tools = strongest(viaDoor, ...reaching.map((row) => writerReach(approval, row)));
    } else tools = viaDoor;
    // A hand-off runs with the shell off, so only a run on its own schedule
    // or trigger carries a ceiling unattended.
    const viaShell = kind === 'unattended' && seed.duty === null ? 'none' : shellReach(approval);
    const key = kind === 'attended' ? 'attended' : 'unattended';
    reach[key] = tools;
    shell[key] = viaShell;
  }
  const attended = strongest(reach.attended, shell.attended);
  const unattended = strongest(reach.unattended, shell.unattended);

  const readers = PAGE_READERS.some((row) => held.has(row.name));
  const fileRead =
    attendedPlan?.decisions.some(
      (d) => READING_FAMILIES.has(d.family) && d.decision !== 'deny' && d.decision !== 'refuse',
    ) ?? false;
  const reads = readers || fileRead || shell.attended !== 'none';
  const read = (readers && readable) || fileRead || shell.attended !== 'none';

  return {
    actor: seed.actor,
    title: seed.title,
    path: seed.path,
    panel: seed.panel,
    boundTo: seed.boundTo,
    axes,
    page,
    inScope,
    heldWriters: heldWriters.map((row) => row.title),
    writers: [
      ...(page.knowledge || page.governed !== null ? [] : reaching.map((row) => row.title)),
      ...doorWriters.map((row) => row.title),
    ],
    doorWriters: doorWriters.map((row) => row.title),
    needsRead,
    ownNotes,
    tools: reach,
    shell: { ...shell, withheld: withheldOf(axes, input.shell, shell.attended) },
    attended,
    unattended,
    write: strongest(attended, unattended),
    read,
    reads,
    runsUnattended,
    paused: seed.paused,
    duty: seed.duty,
  };
}

function axesOf(agent: AgentRef): GrantAxes {
  return {
    scope: agent.scope,
    readScope: agent.readScope,
    allowedTools: agent.allowedTools,
    shell: agent.shell,
    askFirst: agent.askFirst,
  };
}

function seedOf(agent: AgentRef, entries: Entry[], all: AgentRef[]): RowSeed {
  const entry = entries.find((e) => e.path === agent.path);
  const draft = entry === undefined ? null : agentDraft(entry, '');
  const onDuty = draft !== null && agentActive(draft);
  return {
    actor: agent.actor,
    title: agent.title,
    path: agent.path,
    panel: false,
    boundTo: null,
    axes: axesOf(agent),
    sole: all.filter((other) => other.handle === agent.handle).length === 1,
    paused: entry?.properties.paused === true,
    duty:
      onDuty && draft !== null
        ? { schedule: draft.schedule.trim(), triggers: draft.triggers.length }
        : null,
  };
}

/**
 * Which Knowledge door reaches the page past the scope, if any. A cached
 * source is a `.md` under sources/ whose `source_id` is text, the copies
 * `source_target` replaces in place; where two copies hold one id Rust
 * rewrites the first, and this claims both, erring toward reach.
 */
function bundlePageOf(input: PageAccessInput): BundlePage | null {
  if (input.path === KNOWLEDGE_LOG) return 'log';
  if (!input.path.startsWith(`${SOURCES_DIR}/`) || !input.path.endsWith('.md')) return null;
  const sourceId = input.entries.find((e) => e.path === input.path)?.properties.source_id;
  return typeof sourceId === 'string' && sourceId.trim() !== '' ? 'source' : null;
}

/**
 * Who can change the page at `path`: the assistant panel first (unrestricted
 * unless bound, and attended only), then every agent in title order, each
 * with its reach by run kind. A dangling binding reads as unbound: the
 * explanation errs toward claiming reach, never toward hiding it.
 */
export function pageAccess(input: PageAccessInput): PageAccess {
  const agents = listAgents(input.entries);
  const governed = GOVERNED_TYPES.find((type) => type === input.type) ?? null;
  const page: PageKind = {
    governed,
    knowledge: isKnowledgePath(input.path),
    bundle: bundlePageOf(input),
  };
  const bound =
    input.panelAgent === null
      ? null
      : (agents.find((agent) => agent.handle === input.panelAgent) ?? null);
  const panelSeed: RowSeed =
    bound === null
      ? {
          actor: ASSISTANT_ACTOR,
          title: 'Assistant panel',
          path: null,
          panel: true,
          boundTo: null,
          axes: { scope: null, readScope: null, allowedTools: null, shell: null, askFirst: false },
          sole: false,
          paused: false,
          duty: null,
        }
      : {
          ...seedOf(bound, input.entries, agents),
          title: 'Assistant panel',
          panel: true,
          boundTo: bound.title,
          duty: null,
        };
  const rows = [
    deriveRow(panelSeed, input, page),
    ...agents.map((agent) => deriveRow(seedOf(agent, input.entries, agents), input, page)),
  ];
  return {
    agents: agents.length,
    canChange: rows.filter((row) => !row.panel && row.write !== 'none').length,
    rows,
  };
}

// --- Words ----------------------------------------------------------------

function folderWords(folders: readonly string[]): string {
  return folders.map((folder) => `${folder}/`).join(', ');
}

/** The page's one-line summary. */
export function summaryWords(access: PageAccess): string {
  if (access.agents === 0) return 'No agents in this vault yet.';
  if (access.canChange === 0) return 'No agent can change this page.';
  return `${access.canChange} of ${access.agents} agents can change this page.`;
}

export interface AccessLines {
  status: string;
  /** In fixed order: scope, tools, page kind, ask-first, shell, when, read. */
  reasons: string[];
}

/** A row's status and its reasons, in the words the owner reads. */
export function accessLines(row: AccessRow): AccessLines {
  const { axes } = row;
  const viaTools = row.tools.attended === 'yes' || row.tools.unattended === 'yes';
  const status =
    row.write === 'yes'
      ? viaTools
        ? 'Can change it'
        : 'Can change it with the shell'
      : row.write === 'asks'
        ? 'Can change it once you allow it'
        : row.write === 'own-notes'
          ? 'Only its own notes'
          : row.read
            ? 'Can read it'
            : "Can't reach it";

  const reasons: string[] = [];
  // Scope.
  if (axes.scope === null) reasons.push("No write scope, so Cerebro's tools reach every page.");
  else if (axes.scope.length === 0) reasons.push('Its write scope is empty.');
  else if (row.inScope) reasons.push(`Inside its write scope: ${folderWords(axes.scope)}.`);
  else reasons.push(`Outside its write scope: ${folderWords(axes.scope)}.`);
  // Tools.
  if (row.heldWriters.length === 0 && row.doorWriters.length === 0) {
    reasons.push('None of its tools change a page.');
  } else if (row.heldWriters.length > 0) {
    const usable = row.heldWriters.filter((title) => !row.needsRead.includes(title));
    if (usable.length > 0) reasons.push(`Changes pages with: ${usable.join(', ')}.`);
    for (const title of row.needsRead) {
      reasons.push(`${title} also needs the page inside its read scope.`);
    }
  }
  if (row.doorWriters.length > 0) {
    const tools = row.doorWriters.join(', ');
    reasons.push(
      row.page.bundle === 'source'
        ? `Rewrites cached sources with: ${tools}, whatever its write scope.`
        : `Appends to the knowledge log with: ${tools}, whatever its write scope.`,
    );
  }
  // Page kind.
  if (row.page.governed === 'Type') {
    reasons.push("Type docs are the vault's schema. Only people change them.");
  } else if (row.page.governed === 'Agent') {
    reasons.push(
      row.ownNotes
        ? 'On its own page it may rewrite its recent notes, and nothing else.'
        : 'Agent pages are grants. Only people change them.',
    );
  } else if (row.page.knowledge) {
    reasons.push("Files under knowledge/ change only through Knowledge's own tools.");
  }
  // Ask-first.
  if (row.tools.attended === 'asks') reasons.push('It asks you before each page write.');
  if (row.tools.unattended === 'asks') reasons.push('Unattended, its page writes wait in Review.');
  // Shell.
  if (row.shell.attended === 'yes') {
    reasons.push('Shell is On: it can change any file in the vault folder, past every rule above.');
  } else if (row.shell.attended === 'asks') {
    reasons.push('Shell is Ask: while you watch, it can change any file once you allow it.');
  }
  if (row.shell.attended !== 'none' && row.runsUnattended && row.shell.unattended === 'none') {
    reasons.push('Unattended runs go without the shell.');
  }
  if (row.shell.withheld === 'ceiling') reasons.push('Shell is Off in Settings.');
  if (row.shell.withheld === 'read-limit') reasons.push('A read limit withdraws its shell.');
  if (row.shell.withheld === 'narrowing') reasons.push('Its allowed tools leave out the shell.');
  // When.
  if (row.panel) {
    reasons.push(row.boundTo === null ? 'Runs when you ask.' : `Answers as ${row.boundTo} here.`);
  } else if (row.paused) {
    reasons.push('Paused: it runs only after you resume it.');
  } else if (row.duty !== null) {
    const parts = [
      row.duty.schedule,
      row.duty.triggers === 0
        ? ''
        : `${row.duty.triggers} trigger${row.duty.triggers === 1 ? '' : 's'}`,
    ].filter((part) => part !== '');
    reasons.push(`Runs on its own: ${parts.join(', ')}.`);
  } else {
    reasons.push('Runs when you ask, or when another agent hands it work.');
  }
  // Read.
  if (!row.reads) reasons.push('None of its tools read a page.');
  else if (axes.readScope === null) reasons.push('Reads it: no read scope.');
  else if (axes.readScope.length === 0) reasons.push('Its read scope is empty.');
  else if (row.read) {
    reasons.push(`Reads it: inside its read scope (${folderWords(axes.readScope)}).`);
  } else reasons.push(`Outside its read scope: ${folderWords(axes.readScope)}.`);
  return { status, reasons };
}

/**
 * The agent page's Writes in words: which pages its tools reach, Knowledge's
 * own doors whenever it holds one (they pass every scope), and the shell when
 * that widens it, at the Settings ceiling `ceiling` while you watch.
 */
export function writesInWords(
  grant: Pick<GrantAxes, 'scope' | 'readScope' | 'allowedTools' | 'shell'>,
  ceiling: ShellCeiling,
): string {
  const held = grantedTools(grant.allowedTools);
  const writes = PAGE_WRITERS.some((row) => held.has(row.name));
  const doors = BUNDLE_WRITERS.some((row) => held.has(row.name));
  const writesNoPage = !writes || (grant.scope !== null && grant.scope.length === 0);
  let words: string;
  if (writesNoPage && doors) words = 'Knowledge and sources only, through their own tools';
  else if (!writes) words = 'no page — none of its tools change one';
  else if (grant.scope === null) words = 'any page but Type docs and Agent pages';
  else if (grant.scope.length === 0) words = 'no page';
  else words = folderWords(grant.scope);
  if (!writesNoPage && doors) words += '; Knowledge and sources through their own tools';
  const shell = shellReach(
    planFor('attended', { ...grant, shell: grant.shell ?? null, askFirst: false }, ceiling),
  );
  if (shell === 'yes') words += ' · any file with the shell';
  else if (shell === 'asks') words += ' · any file with the shell, once you allow it';
  return words;
}
