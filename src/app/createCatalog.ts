import { canHaveSubPages } from '@/engine/docPages';
import { INBOX_DIR } from '@/engine/inbox';
import { LIBRARY_FOLDER } from '@/engine/library';
import { STUDIO_DIR } from '@/engine/studio';
import type { Entry } from '@/engine/types';
import { TEMPLATES_DIR } from '@/lib/templates';

export const CREATE_GROUPS = [
  ['write', 'Write'],
  ['organize', 'Organize'],
  ['data', 'Data'],
  ['diagram', 'Diagram'],
  ['build', 'Build'],
  ['ai', 'AI'],
  ['capture', 'Capture'],
] as const;
export type CreateGroup = (typeof CREATE_GROUPS)[number][0];
export interface CreateContext {
  ready: boolean;
  page: Entry | null;
  inbox: boolean;
}
export interface CreateRow {
  id: string;
  group: CreateGroup;
  label: string;
  icon: string;
  chord: string;
  tagline: string;
  lands(ctx: CreateContext): string;
}
export const CREATE_ROWS = [
  {
    id: 'page',
    group: 'write',
    label: 'Page',
    icon: 'file-text',
    chord: 'p',
    tagline: 'A blank page for your words.',
    lands: () => 'At the top of the vault.',
  },
  {
    id: 'sub-page',
    group: 'write',
    label: 'Sub-page',
    icon: 'files',
    chord: 's',
    tagline: 'Keep a page beside related work.',
    lands: (ctx: CreateContext) => `Inside “${ctx.page?.title ?? ''}”, beside its other sub-pages.`,
  },
  {
    id: 'template',
    group: 'write',
    label: 'Template',
    icon: 'layout-template',
    chord: 't',
    tagline: 'A starting point you can reuse.',
    lands: () => `In ${TEMPLATES_DIR}/, opened in the Library.`,
  },
  {
    id: 'collection',
    group: 'organize',
    label: 'Collection',
    icon: 'folder-open',
    chord: 'l',
    tagline: 'Bring related pages together.',
    lands: () => 'A new collection folder at the top of the vault.',
  },
  {
    id: 'record',
    group: 'data',
    label: 'Record',
    icon: 'square-plus',
    chord: 'r',
    tagline: 'A page with the properties of a database.',
    lands: () => 'In the database you pick, in its home folder.',
  },
  {
    id: 'sheet',
    group: 'data',
    label: 'Sheet',
    icon: 'sheet',
    chord: 'h',
    tagline: 'A grid with formulas on a page.',
    lands: () => 'A new sheet page at the top of the vault.',
  },
  {
    id: 'sheet-file',
    group: 'data',
    label: 'Sheet from file…',
    icon: 'file-spreadsheet',
    chord: 'x',
    tagline: 'Bring in an Excel workbook or CSV as sheets.',
    lands: () => 'A new sheet page at the top of the vault.',
  },
  {
    id: 'database',
    group: 'data',
    label: 'Database',
    icon: 'database',
    chord: 'd',
    tagline: 'Organize records with shared properties and views.',
    lands: () => 'Its page in types/, its records in a folder of their own.',
  },
  {
    id: 'database-csv',
    group: 'data',
    label: 'Database from CSV',
    icon: 'file-spreadsheet',
    chord: 'v',
    tagline: 'Turn the rows of a CSV file into records.',
    lands: () => 'A new database from a CSV file, one page per row.',
  },
  {
    id: 'whiteboard',
    group: 'diagram',
    label: 'Whiteboard',
    icon: 'presentation',
    chord: 'w',
    tagline: 'Arrange cards, connections and drawings.',
    lands: () => 'At the top of the vault.',
  },
  {
    id: 'prototype',
    group: 'build',
    label: 'Prototype',
    icon: 'blocks',
    chord: 'b',
    tagline: 'A place to build with the assistant.',
    lands: () => `A folder under ${STUDIO_DIR}/ with an index page.`,
  },
  {
    id: 'agent',
    group: 'ai',
    label: 'Agent',
    icon: 'bot',
    chord: 'a',
    tagline: 'Standing instructions and grants for recurring work.',
    lands: () => `In ${LIBRARY_FOLDER.agent}/, born paused.`,
  },
  {
    id: 'skill',
    group: 'ai',
    label: 'Skill',
    icon: 'zap',
    chord: 'k',
    tagline: 'Instructions to invoke when you need them.',
    lands: () => `In ${LIBRARY_FOLDER.skill}/.`,
  },
  {
    id: 'capture',
    group: 'capture',
    label: 'Capture',
    icon: 'inbox',
    chord: 'i',
    tagline: 'Catch an idea now and file it later.',
    lands: () => `In ${INBOX_DIR}/, opened in the Inbox.`,
  },
] as const satisfies readonly CreateRow[];
export type CreateId = (typeof CREATE_ROWS)[number]['id'];
export function isCreateId(id: unknown): id is CreateId {
  return typeof id === 'string' && CREATE_ROWS.some((row) => row.id === id);
}
export function availableRows(ctx: CreateContext): readonly CreateRow[] {
  if (!ctx.ready) return [];
  return CREATE_ROWS.filter((row) =>
    row.id === 'sub-page'
      ? ctx.page !== null && canHaveSubPages(ctx.page)
      : row.id !== 'capture' || ctx.inbox,
  );
}
export function groupRows(rows: readonly CreateRow[]) {
  return CREATE_GROUPS.flatMap(([id, label]) => {
    const items = rows.filter((row) => row.group === id);
    return items.length ? [{ id, label, rows: items }] : [];
  });
}
export function pruneRecents(raw: unknown): CreateId[] {
  return Array.isArray(raw) ? [...new Set(raw.filter(isCreateId))].slice(0, 10) : [];
}
export function recordUse(recents: readonly CreateId[], id: CreateId): CreateId[] {
  return [id, ...recents.filter((previous) => previous !== id)].slice(0, 10);
}
export function recentRows(rows: readonly CreateRow[], recent: readonly CreateId[]): CreateRow[] {
  return pruneRecents(recent)
    .flatMap((id) => rows.filter((row) => row.id === id))
    .slice(0, 3);
}
