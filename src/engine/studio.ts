import type { Entry } from './types';
import { humanizeSlug } from '@/lib/slug';

/**
 * The Studio derivation (M40.2).
 *
 * `studio/` is the workshop: one prototype = one FOLDER `studio/<slug>/`,
 * whose `index.md` is the main page. A folder rather than a tagged file for
 * the same reason a Collection is one — the thing being built is a set of
 * pages, and a set needs a container the agent can be scoped to.
 *
 * Loose files directly in `studio/` belong to no prototype and are ignored
 * here on purpose: a prototype without a folder has nothing to scope a build
 * to, and silently adopting strays would make "which folder is the agent
 * writing into" a question with two answers.
 */

export const STUDIO_DIR = 'studio';

export interface StudioProject {
  /** The folder name under studio/ — the prototype's identity. */
  slug: string;
  /** Vault-relative folder, `studio/<slug>`. */
  folder: string;
  /** The main page's title when it has one; the humanized slug otherwise. */
  title: string;
  /** `index.md`, when the prototype has one. Null is ABSENT, not empty —
   * the page renders "no main page yet", never a blank preview. */
  main: Entry | null;
  /** Every page in the folder (subfolders included), main first. */
  pages: Entry[];
}

/** Every prototype in the vault, sorted by title. */
export function studioProjects(entries: Entry[]): StudioProject[] {
  const bySlug = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!entry.path.startsWith(`${STUDIO_DIR}/`)) continue;
    const rest = entry.path.slice(STUDIO_DIR.length + 1);
    const cut = rest.indexOf('/');
    if (cut === -1) continue; // a loose file, not a prototype
    const slug = rest.slice(0, cut);
    const pages = bySlug.get(slug) ?? [];
    pages.push(entry);
    bySlug.set(slug, pages);
  }
  return [...bySlug.entries()]
    .map(([slug, pages]) => {
      const folder = `${STUDIO_DIR}/${slug}`;
      const main = pages.find((p) => p.path === `${folder}/index.md`) ?? null;
      const rest = pages
        .filter((p) => p !== main)
        .sort((a, b) => a.title.localeCompare(b.title));
      return {
        slug,
        folder,
        title: main?.title ?? humanizeSlug(slug),
        main,
        pages: main === null ? rest : [main, ...rest],
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}
