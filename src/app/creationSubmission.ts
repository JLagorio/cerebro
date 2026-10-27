import type { CreationContext } from '@/engine/creationDestination';
import { createTarget } from '@/engine/createRecord';
import { draftFrontmatter, recordSlug } from '@/engine/recordDraft';
import { newSheetSource } from '@/engine/sheet/gridEdit';
import { isReservedTypeName } from '@/engine/typeCatalog';
import { slugify } from '@/lib/slug';
import {
  beginCreationSubmission,
  settleCreationSubmission,
  type CreationSubmitStart,
  type CreationSubmission,
} from '@/stores/creationDraftStore';
import { getSchema, useVaultStore } from '@/stores/vaultStore';

/** Allocate before calling the single existing guarded writer. The promise and
 * its acknowledgement belong to the session, never to a mounted dialog. */
export function submitCreationDraft(
  context: CreationContext,
  revision: number,
): CreationSubmitStart {
  const start = beginCreationSubmission(context, revision);
  if (start.kind === 'started') void write(start.submission);
  return start;
}
async function write(submission: CreationSubmission): Promise<void> {
  try {
    const state = useVaultStore.getState();
    const { context, snapshot } = submission;
    if (state.vaultPath !== context.vault || state.entriesVault !== context.vault)
      throw Error('Choose this destination again after its vault opens.');
    const destination = context.destination;
    const name = snapshot.title.trim().replace(/\s+/g, ' ');
    if (name === '') throw Error('Give it a title');
    const unfinished = Object.values(snapshot.scalarDrafts ?? {});
    if (unfinished.length > 0)
      throw Error(
        unfinished.find((draft) => draft.error !== null)?.error ??
          'Finish editing the field before creating.',
      );
    let folder: string;
    let frontmatter: Record<string, unknown> = {};
    let body = `# ${name}\n`;
    if (destination.kind === 'page') {
      folder = destination.folder;
      // Choices come from the scanner. The writer remains authoritative for
      // containment and reserved/guarded paths, including any concurrent move.
      if (
        folder !== '' &&
        !state.folders.includes(folder) &&
        !state.entries.some(
          (entry) => entry.folder === folder || entry.folder.startsWith(`${folder}/`),
        )
      )
        throw Error('Choose a folder: the original destination is unavailable.');
      if (destination.recipe.kind === 'sheet')
        body = `# ${name}\n\n\`\`\`cerebro-sheet\n${newSheetSource(destination.recipe.sheetName)}\`\`\`\n`;
    } else {
      const schema = getSchema(state.entries);
      if (!schema.types.has(destination.typeName) || isReservedTypeName(destination.typeName))
        throw Error('Choose a database: the original database is unavailable.');
      const host =
        destination.host === null
          ? null
          : state.entries.find((entry) => entry.path === destination.host?.path);
      if (host === undefined)
        throw Error('Choose a related destination: the original host is unavailable.');
      if (
        destination.host !== null &&
        !schema.types
          .get(destination.typeName)
          ?.fields.some(
            (field) => field.name === destination.host?.field && field.kind === 'relation',
          )
      )
        throw Error('Choose a related destination: its relation is unavailable.');
      if (
        destination.group !== null &&
        !schema.types
          .get(destination.typeName)
          ?.fields.some((field) => field.name === destination.group?.field)
      )
        throw Error('Choose a destination: its group field is unavailable.');
      const target = createTarget(destination.typeName, {
        entries: state.entries,
        schema,
        host:
          host == null || destination.host === null
            ? null
            : { host, field: destination.host.field },
        groupBy: destination.group?.field,
        groupValue: destination.group?.value,
      });
      const draft = draftFrontmatter(
        target.frontmatter,
        snapshot.values,
        destination.typeName,
        schema,
      );
      if (draft.problems.length > 0) throw Error(draft.problems.join('. '));
      frontmatter = draft.frontmatter;
      if (destination.host !== null)
        frontmatter[destination.host.field] = target.frontmatter[destination.host.field];
      if (target.frontmatter.key !== undefined) frontmatter.key = target.frontmatter.key;
      folder = target.folder;
    }
    const path = await state.createItem({
      folder,
      slug:
        destination.kind === 'page'
          ? slugify(name) || `doc-${Date.now().toString(36)}`
          : recordSlug(name, `record-${Date.now().toString(36)}`),
      frontmatter,
      body,
    });
    settleCreationSubmission(submission.id, { kind: 'succeeded', path });
  } catch (error) {
    settleCreationSubmission(submission.id, {
      kind: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
