/** Filename slug from a display title: lowercase, ASCII, dash-separated. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Display name from a slug: 'app-notes' \u2192 'App Notes'. Slugs stay kebab on
 * disk; humans see title case (M2.x feedback). */
export function humanizeSlug(slug: string): string {
  const words = slug
    .split(/[-_]+/)
    .filter((w) => w !== '')
    .map((w) => w[0].toUpperCase() + w.slice(1));
  return words.length === 0 ? slug : words.join(' ');
}
