import { isWhiteboardPath } from './fileKinds';
import { parse } from 'yaml';
import { humanize, splitFrontmatter } from './frontmatter';
import { isKnowledgePath, parseAbout, parseSources } from './okf';
import type { Entry } from './types';
import { buildTargetIndex, linkTargetOf, wikilinkSpans } from './wikilink';

/** Steps are applied in order: a folder move may precede its main file's rename. */
export interface RenameStep {
  from: string;
  to: string;
}

/** `path` names the page before any rename step. */
export interface RenameRetitle {
  path: string;
  title: string;
}

/** A trimmed target and the end of the page part that must change. */
export interface LinkChange {
  target: string;
  replacement: string;
  pageEnd: number;
}

export interface RenamePage {
  entry: Entry;
  changes: LinkChange[];
}

export interface RenameConcept extends RenamePage {
  /** Candidate anchors; the raw source decides the exact shape and count. */
  anchors: string[] | null;
  anchorCount: number;
  refusedCount: number;
}

export interface RenameSource {
  entry: Entry;
  resource: string;
  to: string;
  /** Non-markdown links are reported, never read or rewritten. */
  board?: true;
}

export interface RenameCollision {
  name: string;
  /** Null means the name cannot safely be written in a link. */
  holder: Entry | null;
}

export interface RenamePlan {
  pages: RenamePage[];
  concepts: RenameConcept[];
  sources: RenameSource[];
  collisions: RenameCollision[];
  after: Entry[];
  steps: readonly RenameStep[];
}

/** Move a page or descendant through all steps, leaving neighboring prefixes alone. */
export function movedPath(path: string, steps: readonly RenameStep[]): string {
  return steps.reduce(
    (current, { from, to }) =>
      current === from || current.startsWith(`${from}/`)
        ? to + current.slice(from.length)
        : current,
    path,
  );
}

const writtenTarget = (change: LinkChange): string =>
  change.replacement + change.target.slice(change.pageEnd);

/**
 * Plan against the scan's link resolution, including links to unmoved pages
 * that a new stem or a changed path order would otherwise steal (M60.10).
 * Only targets that resolved before are repaired; dangling links stay as-is.
 * Reads and writes belong to the action, so this plan is pure and contains
 * candidate pages rather than claiming counts from bytes it has not read.
 * Non-markdown citers join sources: reported, never rewritten by a note batch.
 */
export function planRename(
  entries: readonly Entry[],
  steps: readonly RenameStep[],
  retitles: readonly RenameRetitle[] = [],
): RenamePlan {
  const titles = new Map(retitles.map(({ path, title }) => [path, title]));
  const relocated = new Map<string, Entry>();
  for (const entry of entries) {
    const path = movedPath(entry.path, steps);
    const slash = path.lastIndexOf('/');
    const filename = path.slice(slash + 1);
    relocated.set(entry.path, {
      ...entry,
      path,
      filename,
      folder: slash === -1 ? '' : path.slice(0, slash),
      project: entry.project === null ? null : movedPath(entry.project, steps),
      title:
        titles.get(entry.path) ??
        (filename.endsWith('.mmd') || isWhiteboardPath(path)
          ? humanize(filename.slice(0, filename.lastIndexOf('.')))
          : entry.title),
    });
  }
  const after = [...relocated.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const beforeIndex = buildTargetIndex(entries);
  const afterIndex = buildTargetIndex(after);
  const collisions: RenameCollision[] = [];
  const collide = (name: string, holder: Entry | null) => {
    if (!collisions.some((row) => row.name === name && row.holder?.path === holder?.path)) {
      collisions.push({ name, holder });
    }
  };
  const changeFor = (target: string, willWrite: boolean): LinkChange | null => {
    const resolved = beforeIndex.resolveLink(target);
    if (resolved === null) return null;
    const expected = relocated.get(resolved.entry.path)!;
    const actual = afterIndex.resolveLink(target);
    if (actual?.entry.path === expected.path && actual.section === resolved.section) return null;
    const replacement = linkTargetOf(expected);
    const whole = beforeIndex.resolveName(target) !== null;
    const pageEnd = whole ? target.length : target.slice(0, target.indexOf('#')).trimEnd().length;
    const change = { target, replacement, pageEnd };
    // Single quotes can corrupt a single-quoted YAML field just as double
    // quotes can corrupt a double-quoted one. No YAML reserialization is
    // allowed here: every other byte must stay, so either quote is refused.
    if (
      replacement === '' ||
      replacement !== replacement.trim() ||
      /[[\]|\\"'\r\n]/.test(replacement)
    ) {
      if (willWrite) collide(replacement, null);
    } else {
      const holder = afterIndex.resolveName(replacement);
      const rewritten = afterIndex.resolveLink(writtenTarget(change));
      if (holder?.path !== expected.path) {
        if (willWrite) collide(replacement, holder);
      } else if (
        rewritten?.entry.path !== expected.path ||
        rewritten.section !== resolved.section
      ) {
        if (willWrite)
          collide(
            replacement,
            rewritten?.entry.path === expected.path ? null : (rewritten?.entry ?? null),
          );
      }
    }
    return change;
  };
  const pages: RenamePage[] = [];
  const concepts: RenameConcept[] = [];
  const sources: RenameSource[] = [];
  for (const entry of entries) {
    const markdown = entry.path.endsWith('.md');
    const concept = markdown && isKnowledgePath(entry.path);
    const about = concept ? parseAbout(entry) : [];
    const targets = [
      ...entry.outgoingLinks,
      ...Object.values(entry.relationships).flat(),
      ...about,
    ];
    const changes = [...new Set(targets)].flatMap((target) => {
      const change = changeFor(target, markdown && (!concept || about.includes(target)));
      return change === null ? [] : [change];
    });
    if (changes.length > 0) {
      if (!markdown) {
        for (const change of changes)
          sources.push({
            entry,
            resource: change.target,
            to: writtenTarget(change),
            ...(isWhiteboardPath(entry.path) ? { board: true as const } : {}),
          });
      } else if (concept) {
        const map = new Map(changes.map((change) => [change.target, change]));
        const anchorCount = about.filter((target) => map.has(target)).length;
        concepts.push({
          entry,
          changes,
          anchors:
            anchorCount === 0
              ? null
              : about.map((target) => (map.has(target) ? writtenTarget(map.get(target)!) : target)),
          anchorCount,
          refusedCount: [
            ...entry.outgoingLinks,
            ...Object.entries(entry.relationships)
              .filter(([key]) => key !== 'about')
              .flatMap(([, values]) => values),
          ].filter((target) => map.has(target)).length,
        });
      } else {
        pages.push({ entry, changes });
      }
    }
    for (const source of parseSources(entry)) {
      const path = source.resource.replace(/^\.?\//, '');
      const to = movedPath(path, steps);
      if (path !== to) sources.push({ entry, resource: source.resource, to });
    }
  }
  return { pages, concepts, sources, collisions, after, steps };
}

/** Replace only each changed page name, keeping every other source byte. */
export function rewriteLinks(
  content: string,
  changes: readonly LinkChange[],
): { content: string; count: number } {
  const byTarget = new Map(changes.map((change) => [change.target, change]));
  let cursor = 0;
  let rewritten = '';
  let count = 0;
  for (const span of wikilinkSpans(content)) {
    const change = byTarget.get(span.target);
    if (change === undefined) continue;
    rewritten += content.slice(cursor, span.targetStart) + change.replacement;
    cursor = span.targetStart + change.pageEnd;
    count += 1;
  }
  return { content: count === 0 ? content : rewritten + content.slice(cursor), count };
}

/**
 * A concept's only writable link field goes through the capture valve.
 * Parse its raw source so scalar/list shape, aliases and unchanged values
 * survive; the rest of the concept is never returned as writable bytes.
 */
export function conceptAnchors(
  content: string,
  changes: readonly LinkChange[],
): { about: string | string[]; count: number; linkCount: number } | null {
  const { yaml } = splitFrontmatter(content);
  if (yaml === null) return null;
  let parsed: unknown;
  try {
    parsed = parse(yaml) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const about: unknown = (parsed as Record<string, unknown>).about;
  if (
    typeof about !== 'string' &&
    !(Array.isArray(about) && about.every((value) => typeof value === 'string'))
  )
    return null;
  const byTarget = new Map(changes.map((change) => [change.target, change]));
  let count = 0;
  let linkCount = 0;
  const rewrite = (value: string): string => {
    const links = rewriteLinks(value, changes);
    if (links.count > 0) {
      count += links.count;
      linkCount += links.count;
      return links.content;
    }
    const trimmed = value.trim();
    const change = byTarget.get(trimmed);
    if (change === undefined) return value;
    count += 1;
    const start = value.length - value.trimStart().length;
    return value.slice(0, start) + writtenTarget(change) + value.slice(start + trimmed.length);
  };
  const rewritten = typeof about === 'string' ? rewrite(about) : about.map(rewrite);
  return count === 0 ? null : { about: rewritten, count, linkCount };
}
