/** Filename slug from a display title: lowercase, ASCII, dash-separated. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Slug tokens that are acronyms rather than words. Title-casing them ruins
 * the name the user actually typed ('guided-onboarding-ga' read back as
 * 'Guided Onboarding Ga'), so they stay uppercase. Tokens that are also
 * ordinary English words ('it', 'id', 'is', 'us', 'ad') are deliberately
 * absent \u2014 uppercasing those reads worse than the bug it fixes.
 */
const ACRONYMS = new Set([
  'ai',
  'api',
  'arr',
  'cli',
  'crm',
  'css',
  'csv',
  'cta',
  'faq',
  'ga',
  'html',
  'http',
  'https',
  'json',
  'kpi',
  'kr',
  'ml',
  'mrr',
  'mvp',
  'nps',
  'okr',
  'pdf',
  'poc',
  'prd',
  'qa',
  'rfc',
  'roi',
  'saas',
  'sdk',
  'seo',
  'sla',
  'sql',
  'sso',
  'svg',
  'uat',
  'ui',
  'url',
  'ux',
  'xml',
  'yaml',
]);

/** Display name from a slug: 'app-notes' \u2192 'App Notes'. Slugs stay kebab on
 * disk; humans see title case (M2.x feedback). Known acronyms keep their
 * case: 'guided-onboarding-ga' \u2192 'Guided Onboarding GA'. */
export function humanizeSlug(slug: string): string {
  const words = slug
    .split(/[-_]+/)
    .filter((w) => w !== '')
    .map((w) =>
      ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1),
    );
  return words.length === 0 ? slug : words.join(' ');
}
