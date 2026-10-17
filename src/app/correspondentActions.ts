import { homeFolderFor } from '@/engine/createRecord';
import { buildSchema } from '@/engine/schema';
import { correspondentTitle, unfiledCorrespondents, type DismissalKind } from '@/engine/unfiled';
import { formatWikilink, linkTargetOf } from '@/engine/wikilink';
import { mailDismiss, mailDismissalsRead, mailUndismiss } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';

async function inVault<T>(
  action: (vault: string, current: () => boolean) => Promise<T>,
  fallback: T,
): Promise<T> {
  const state = useVaultStore.getState(),
    vault = state.vaultPath;
  if (vault === null || refusedAcrossVaults(state)) return fallback;
  let live = true;
  const unsubscribe = useVaultStore.subscribe((next, prev) => {
    if (next.vaultPath !== prev.vaultPath) live = false;
  });
  const current = () => live && useVaultStore.getState().vaultPath === vault;
  try {
    return await action(vault, current);
  } catch (error) {
    if (current())
      useUiStore.getState().toast(error instanceof Error ? error.message : String(error));
    return fallback;
  } finally {
    unsubscribe();
  }
}
export function dismissCorrespondent(kind: DismissalKind, value: string): Promise<boolean> {
  return inVault(async (vault, current) => {
    await mailDismiss(vault, kind, value);
    return current();
  }, false);
}
export function restoreCorrespondent(kind: DismissalKind, value: string): Promise<boolean> {
  return inVault(async (vault, current) => {
    await mailUndismiss(vault, kind, value);
    return current();
  }, false);
}
/** Explicit Create writes the address into a tracked page; reading the lane never does. */
export function createCorrespondent(
  typeName: string,
  address: string,
  company = false,
): Promise<string | null> {
  return inVault(async (vault, current) => {
    const dismissed = await mailDismissalsRead(vault);
    if (!current()) return null;
    const state = useVaultStore.getState(),
      schema = buildSchema(state.entries);
    const row = unfiledCorrespondents(state.entries, schema, dismissed).rows.find(
      (row) => row.address === address,
    );
    if (row === undefined) throw new Error('This address is no longer unfiled.');
    let type = schema.types.get(typeName);
    let title = correspondentTitle(row);
    const frontmatter: Record<string, unknown> = { type: typeName };
    if (company) {
      const types = [...schema.types.values()].filter((type) => type.emailDomain != null);
      if (row.company.state !== 'unfiled' || types.length !== 1)
        throw new Error(
          'Choose one database with a declared email domain before creating a company.',
        );
      type = types[0];
      frontmatter.type = type.name;
      frontmatter[type.emailDomain!] = row.domain;
      const label = row.domain.split('.')[0];
      title = label.charAt(0).toUpperCase() + label.slice(1);
    } else {
      const email = type?.fields.find((field) => field.kind === 'email');
      if (email === undefined) throw new Error('This database has no email property.');
      frontmatter[email.name] = row.address;
      if (row.company.state === 'filed') {
        const target = row.company.entry;
        const relation = type!.fields.find(
          (field) =>
            (field.kind === 'relation' || field.kind === 'person') &&
            field.from === undefined &&
            field.target === target.type,
        );
        if (relation !== undefined)
          frontmatter[relation.name] = formatWikilink(linkTargetOf(target));
      }
    }
    if (type === undefined) return null;
    const path = await state.createItem({
      folder: type.folder ?? homeFolderFor(type.name, schema, state.entries),
      slug: slugify(title) || 'person',
      frontmatter,
      body: `# ${title}\n`,
    });
    if (!current() || typeof path !== 'string' || path === '') return null;
    useUiStore.getState().toast(`Created ${title}`);
    return path;
  }, null);
}
