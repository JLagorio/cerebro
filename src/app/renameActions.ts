import { parse } from 'yaml';
import type { BatchOp } from '@/engine/batch';
import { replaceH1, splitFrontmatter } from '@/engine/frontmatter';
import {
  conceptAnchors,
  movedPath,
  planRename,
  rewriteLinks,
  type LinkChange,
  type RenamePlan,
  type RenameRetitle,
  type RenameStep,
} from '@/engine/linkRewrite';
import { announceExternalWrites, flushOpenPages, heldOpenPages } from '@/editor/openPages';
import {
  pageAttribution,
  readNoteSource,
  renameNote,
  scanVault,
  updateFrontmatter,
} from '@/lib/ipc';
import { sha256Hex } from '@/lib/sha256';
import { UNDO, whoChanged, undoableRename, type RenameChange } from '@/engine/undoPlan';
import { useUndoStore } from '@/stores/undoStore';
import { beginPointerRename, followRename } from './pointers';
import { askRename, type RenamePrompt } from '@/stores/renamePromptStore';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';

interface RenameRequest {
  steps: RenameStep[];
  /** The page's path before any move. */
  retitle?: RenameRetitle;
  label: string;
}

/**
 * One human move door (M60.10). The scan plans link resolution; whole-file
 * reads supply exact spans and hashes. Cancel and a stale batch write no
 * bytes. Knowledge bodies, non-markdown citers and source pointers are named but never rewritten;
 * only concept about fields pass through the capture valve after the move.
 */
export async function renameKeepingLinks({
  steps,
  retitle,
  label,
}: RenameRequest): Promise<{ steps: RenameStep[]; pages: number } | null> {
  const initial = useVaultStore.getState();
  const vault = initial.vaultPath;
  if (vault === null || refusedAcrossVaults(initial)) return null;
  const { toast } = useUiStore.getState();
  const sameVault = () => useVaultStore.getState().vaultPath === vault;
  let finishPointers = () => {};
  try {
    await flushOpenPages();
    if (!sameVault()) return null;
    // Store rescan preserves its last good snapshot after a read failure.
    // A rename must instead refuse: an unseen citer may need rewriting.
    const entries = await scanVault(vault);
    if (!sameVault() || refusedAcrossVaults(useVaultStore.getState())) return null;
    // A title edit without a move deliberately leaves existing title links
    // alone (Q27); moves still include their new title in link resolution.
    const retitles = retitle === undefined || steps.length === 0 ? [] : [retitle];
    const plan = planRename(entries, steps, retitles);
    if (plan.collisions.length > 0) {
      const { name, holder } = plan.collisions[0];
      toast(
        holder === null
          ? `${name} can't be written inside a link. Choose another name.`
          : `${name} already names ${holder.title} (${holder.path}). Choose another name so links keep working.`,
      );
      return null;
    }
    const sourceTitle =
      retitle === undefined
        ? undefined
        : entries.find((entry) => entry.path === retitle.path)?.title;
    const from = sourceTitle ?? steps[0]?.from ?? retitle?.path ?? label;
    const to = retitle?.title ?? steps.at(-1)?.to ?? from;
    const prompt: RenamePrompt = {
      vault,
      from,
      to,
      fromPath: steps[0]?.from ?? retitle?.path,
      pages: [],
      anchors: [],
      refused: [],
      sources: plan.sources.map(({ entry, resource, board }) => ({
        path: entry.path,
        title: entry.title,
        resource,
        ...(board ? { board } : {}),
      })),
    };
    const ops: BatchOp[] = [];
    const anchors: {
      path: string;
      about: string | string[];
      before: string | string[];
      title: string;
    }[] = [];
    const reads = new Map<string, Awaited<ReturnType<typeof readNoteSource>>>();
    for (const { entry } of [...plan.pages, ...plan.concepts]) {
      if (reads.has(entry.path)) continue;
      try {
        reads.set(entry.path, await readNoteSource(vault, entry.path));
      } catch {
        toast(`Couldn't read ${entry.path}, so nothing was renamed.`);
        return null;
      }
    }
    if (retitle !== undefined && !reads.has(retitle.path)) {
      try {
        reads.set(retitle.path, await readNoteSource(vault, retitle.path));
      } catch {
        toast(`Couldn't read ${retitle.path}, so nothing was renamed.`);
        return null;
      }
    }
    if (!sameVault()) return null;
    for (const { entry, changes } of plan.pages) {
      const source = reads.get(entry.path)!;
      const rewritten = rewriteLinks(source.content, changes);
      if (
        rewritten.count === 0 ||
        !rewrittenYamlMatches(source.content, rewritten.content, changes)
      ) {
        toast(`Couldn't safely re-point links in ${entry.path}, so nothing was renamed.`);
        return null;
      }
      ops.push({
        op: 'replace_file',
        path: entry.path,
        content: rewritten.content,
        expectHash: source.hash,
      });
      prompt.pages.push({ path: entry.path, title: entry.title, count: rewritten.count });
    }
    if (retitle !== undefined) {
      const source = reads.get(retitle.path)!;
      const existing = ops.find((op) => op.op === 'replace_file' && op.path === retitle.path);
      const current = existing?.op === 'replace_file' ? existing.content : source.content;
      const { body } = splitFrontmatter(current);
      const content =
        current.slice(0, current.length - body.length) + replaceH1(body, retitle.title);
      if (existing?.op === 'replace_file') existing.content = content;
      else if (content !== current)
        ops.push({ op: 'replace_file', path: retitle.path, content, expectHash: source.hash });
    }
    for (const { entry, changes } of plan.concepts) {
      const source = reads.get(entry.path)!;
      const anchor = conceptAnchors(source.content, changes);
      if (anchor !== null) {
        anchors.push({
          path: entry.path,
          title: entry.title,
          about: anchor.about,
          before: aboutOf(source.content)!,
        });
        prompt.anchors.push({ path: entry.path, title: entry.title });
      }
      const refused = rewriteLinks(source.content, changes).count - (anchor?.linkCount ?? 0);
      if (refused > 0)
        prompt.refused.push({ path: entry.path, title: entry.title, count: refused });
    }
    const touches = (path: string) =>
      ops.some((op) => op.op !== 'rename' && op.path === path) ||
      retitle?.path === path ||
      steps.some(({ from: old }) => path === old || path.startsWith(`${old}/`));
    const held = heldOpenPages().find(touches);
    if (held !== undefined) {
      toast(`${held} has changes waiting on you. Settle them before renaming.`);
      return null;
    }
    const needsPrompt =
      prompt.pages.length + prompt.anchors.length + prompt.refused.length + prompt.sources.length >
      0;
    if (needsPrompt && !(await askRename(prompt))) return null;
    if (!sameVault()) return null;
    await flushOpenPages();
    if (!sameVault()) return null;
    {
      // A new citer or a competing stem can change resolution without
      // touching any page whose bytes the batch checks. Re-plan from a fresh
      // read, and require the confirmation to still describe the same work.
      const current = planRename(await scanVault(vault), steps, retitles);
      if (!sameVault()) return null;
      if (planReferences(current) !== planReferences(plan)) {
        toast('A page changed while renaming, so nothing was renamed. Try again.');
        return null;
      }
    }
    const nowHeld = heldOpenPages().find(touches);
    if (nowHeld !== undefined) {
      toast(`${nowHeld} has changes waiting on you. Settle them before renaming.`);
      return null;
    }
    finishPointers = beginPointerRename(vault);
    let undoChange: RenameChange | null = null;
    if (needsPrompt || steps.length > 1 || ops.length > 0) {
      const applied = await useVaultStore.getState().applyBatch(
        [
          ...ops,
          ...steps.map(({ from: old, to: next }): BatchOp => ({
            op: 'rename',
            from: old,
            to: next,
          })),
        ],
        {
          onRefused: (reason) =>
            toast(
              reason.startsWith('stale_content:')
                ? 'A page changed while renaming, so nothing was renamed. Try again.'
                : `Couldn't rename ${from}: ${reason}`,
            ),
        },
      );
      if (applied === null) return null;
      undoChange = {
        steps: steps.map((step) => ({ ...step })),
        files: ops.flatMap((op) =>
          op.op === 'replace_file'
            ? [{ path: op.path, before: reads.get(op.path)!.content, after: op.content }]
            : [],
        ),
        anchors: [],
      };
    } else {
      for (const step of steps) await renameNote(vault, step.from, step.to);
    }
    // Every pointer follows landed steps before the catch-up read. Concept
    // about updates below can fail independently of the move.
    if (sameVault()) {
      for (const { from: old, to: next } of steps) {
        followRename(vault, old, next);
      }
    }
    const refusedTitles = new Set(prompt.refused.map((row) => row.title));
    for (const row of prompt.sources) refusedTitles.add(row.title);
    for (const anchor of anchors) {
      try {
        // The confirmation may have stayed open while the person edited a
        // concept. Never replace that newer about value with our old draft.
        const current = await readNoteSource(vault, anchor.path);
        if (current.hash !== reads.get(anchor.path)?.hash) {
          refusedTitles.add(anchor.title);
          continue;
        }
        await updateFrontmatter(vault, anchor.path, { about: anchor.about });
        undoChange?.anchors.push({
          path: anchor.path,
          title: anchor.title,
          before: anchor.before,
          after: anchor.about,
        });
      } catch {
        refusedTitles.add(anchor.title);
      }
    }
    if (sameVault()) {
      await announceExternalWrites(
        [...reads.keys(), ...steps.flatMap((step) => [step.from, step.to])],
        () => useVaultStore.getState().rescan(),
      );
      const id =
        undoChange === null || (undoChange.files.length === 0 && undoChange.anchors.length === 0)
          ? null
          : useUndoStore.getState().pushRename(label, vault, undoChange);
      toast(
        `${label}${prompt.pages.length === 0 ? '' : `. Updated ${prompt.pages.length} ${prompt.pages.length === 1 ? 'page' : 'pages'}`}.`,
        id === null
          ? undefined
          : { action: { label: UNDO, run: () => void useUndoStore.getState().undoEntry(id) } },
      );
      if (refusedTitles.size > 0)
        toast(`Not changed: ${[...refusedTitles].join(', ')}. They still name ${from}.`);
    }
    return { steps, pages: prompt.pages.length };
  } catch (error) {
    if (sameVault()) {
      toast(
        `Couldn't ${label.toLowerCase()}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await useVaultStore.getState().rescan();
    }
    return null;
  } finally {
    finishPointers();
  }
}

/** Compare only facts the confirmation and resolution rely on, so unrelated
 * body edits do not prevent a rename. Byte checks still guard every write. */
function planReferences(plan: RenamePlan): string {
  const pages = plan.pages.map(({ entry, changes }) => ({ path: entry.path, changes }));
  const concepts = plan.concepts.map(({ entry, ...rest }) => ({ path: entry.path, ...rest }));
  const sources = plan.sources.map(({ entry, ...rest }) => ({ path: entry.path, ...rest }));
  return JSON.stringify({ pages, concepts, sources, collisions: plan.collisions });
}

/** YAML escapes are decoded by the scan, but byte spans must remain raw.
 * Check the proposed raw edit against the decoded values; an escaped target
 * that cannot be replaced exactly refuses rather than silently dangling. */
function rewrittenYamlMatches(before: string, after: string, changes: LinkChange[]): boolean {
  const yaml = splitFrontmatter(before).yaml;
  if (yaml === null) return true;
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') return rewriteLinks(value, changes).content;
    if (Array.isArray(value)) return value.map(rewrite);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  try {
    return (
      JSON.stringify(rewrite(parse(yaml))) === JSON.stringify(parse(splitFrontmatter(after).yaml!))
    );
  } catch {
    return false;
  }
}

/** Read only the capture valve's supported about shapes. */
function aboutOf(content: string): string | string[] | undefined {
  const { yaml } = splitFrontmatter(content);
  if (yaml === null) return undefined;
  const parsed: unknown = parse(yaml);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const about: unknown = (parsed as Record<string, unknown>).about;
  return typeof about === 'string' ||
    (Array.isArray(about) && about.every((item) => typeof item === 'string'))
    ? about
    : undefined;
}

export type RenameUndoResult =
  { kind: 'done'; inverse: RenameChange; kept: string[] } | { kind: 'retry' } | { kind: 'dropped' };

/** Reverse a rename, or reverse its inverse for redo. Newer page edits are
 * kept; conflicting move endpoints refuse the entire batch before a write. */
export async function undoRename(
  vault: string,
  change: RenameChange,
  since: number,
): Promise<RenameUndoResult> {
  const { toast } = useUiStore.getState();
  const currentVault = () => useVaultStore.getState().vaultPath === vault;
  if (!currentVault() || !undoableRename(change)) return { kind: 'dropped' };
  let finishPointers = () => {};
  try {
    await flushOpenPages();
    await useVaultStore.getState().rescan();
    if (!currentVault() || refusedAcrossVaults(useVaultStore.getState()))
      return { kind: 'dropped' };
    const steps = [...change.steps].reverse().map(({ from, to }) => ({ from: to, to: from }));
    const held = heldOpenPages().find(
      (path) =>
        change.files.some((file) => movedPath(file.path, change.steps) === path) ||
        steps.some(({ from }) => path === from || path.startsWith(`${from}/`)),
    );
    if (held !== undefined) {
      toast(`${held} has changes waiting on you. Settle them before undoing.`);
      return { kind: 'retry' };
    }
    const ops: BatchOp[] = [];
    const inverse: RenameChange = { steps, files: [], anchors: [] };
    const kept: string[] = [];
    const { entries } = useVaultStore.getState();
    for (const file of change.files) {
      const path = movedPath(file.path, change.steps);
      const entry = entries.find((item) => item.path === path);
      if (entry === undefined) {
        kept.push(`“${path}” (missing)`);
        continue;
      }
      let source: Awaited<ReturnType<typeof readNoteSource>>;
      try {
        source = await readNoteSource(vault, path);
      } catch {
        toast(`Couldn't read ${path}, so nothing was undone.`);
        return { kind: 'retry' };
      }
      if (source.hash !== sha256Hex(file.after)) {
        let who: string | null = null;
        if (kept.length < 10) {
          try {
            who = whoChanged(await pageAttribution(vault, path), since, entries);
          } catch {
            /* An unavailable attribution names no writer (CV-05). */
          }
        }
        kept.push(`“${entry.title}”${who === null ? '' : ` (${who})`}`);
        continue;
      }
      ops.push({ op: 'replace_file', path, content: file.before, expectHash: source.hash });
      inverse.files.push({ path, before: file.after, after: file.before });
    }
    if (!currentVault()) return { kind: 'dropped' };
    if (ops.length === 0 && steps.length === 0) return { kind: 'done', inverse, kept };
    const refused: { message: string | null } = { message: null };
    finishPointers = beginPointerRename(vault);
    const applied = await useVaultStore
      .getState()
      .applyBatch([...ops, ...steps.map(({ from, to }): BatchOp => ({ op: 'rename', from, to }))], {
        onRefused: (message) => {
          refused.message = message;
        },
      });
    if (applied === null) {
      if (refused.message !== null) toast(`Nothing was undone: ${refused.message}`);
      return {
        kind:
          refused.message === null || refused.message.startsWith("Couldn't") ? 'retry' : 'dropped',
      };
    }
    if (!currentVault()) return { kind: 'dropped' };
    for (const { from, to } of steps) {
      followRename(vault, from, to);
    }
    for (const anchor of change.anchors) {
      try {
        const source = await readNoteSource(vault, anchor.path);
        if (JSON.stringify(aboutOf(source.content)) !== JSON.stringify(anchor.after)) {
          kept.push(`About on “${anchor.title}”`);
          continue;
        }
        await updateFrontmatter(vault, anchor.path, { about: anchor.before });
        inverse.anchors.push({ ...anchor, before: anchor.after, after: anchor.before });
      } catch {
        kept.push(`About on “${anchor.title}”`);
      }
    }
    if (!currentVault()) return { kind: 'dropped' };
    await announceExternalWrites(
      [
        ...change.files.map((file) => movedPath(file.path, change.steps)),
        ...steps.flatMap(({ from, to }) => [from, to]),
        ...change.anchors.map(({ path }) => path),
      ],
      () => useVaultStore.getState().rescan(),
    );
    return { kind: 'done', inverse, kept };
  } catch (error) {
    if (currentVault())
      toast(`Couldn't undo the rename: ${error instanceof Error ? error.message : String(error)}`);
    return { kind: 'retry' };
  } finally {
    finishPointers();
  }
}
