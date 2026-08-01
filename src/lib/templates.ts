import type { Entry, Scalar } from '@/engine/types';

/**
 * Page templates (M2.x docs polish) are ordinary markdown files in the
 * vault's `templates/` folder — edit them like any page. Creating a page
 * from one copies its body and frontmatter with `{{title}}` and `{{date}}`
 * placeholders substituted.
 */

export const TEMPLATES_DIR = 'templates';

export function isTemplate(e: Entry): boolean {
  return e.folder === TEMPLATES_DIR || e.folder.startsWith(`${TEMPLATES_DIR}/`);
}

export function listTemplates(entries: Entry[]): Entry[] {
  return entries.filter(isTemplate).sort((a, b) => a.title.localeCompare(b.title));
}

/** Notes that read as documents get template filtering too: templates are
 * scaffolding, not content — keep them out of recents and task rollups. */
export function isTemplateFolderPath(path: string): boolean {
  return path === TEMPLATES_DIR || path.startsWith(`${TEMPLATES_DIR}/`);
}

/** A template whose H1 is `# {{title}}` would list as "{{title}}" — fall
 * back to the humanized filename for display. */
export function templateDisplayName(template: Entry): string {
  if (!template.title.includes('{{')) return template.title;
  const stem = template.filename.replace(/\.md$/, '').replace(/[-_]+/g, ' ');
  return stem === '' ? template.title : stem[0].toUpperCase() + stem.slice(1);
}

const substitute = (text: string, vars: { title: string; date: string }): string =>
  text.replaceAll('{{title}}', vars.title).replaceAll('{{date}}', vars.date);

/** Apply placeholders to a template body; guarantee the new page has an H1. */
export function applyTemplateBody(body: string, vars: { title: string; date: string }): string {
  const filled = substitute(body, vars);
  const hasH1 = filled.split('\n').some((l) => l.trim().startsWith('# '));
  return hasH1 ? filled : `# ${vars.title}\n\n${filled}`;
}

/** Template frontmatter for the new page: type + scalar properties, with
 * placeholders substituted inside string values. */
export function applyTemplateFrontmatter(
  template: Entry,
  vars: { title: string; date: string },
): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {};
  if (template.type !== null) frontmatter.type = template.type;
  for (const [key, value] of Object.entries(template.properties)) {
    frontmatter[key] =
      typeof value === 'string' ? substitute(value, vars) : (value as Scalar | Scalar[]);
  }
  for (const [key, targets] of Object.entries(template.relationships)) {
    frontmatter[key] = targets.map((t) => `[[${t}]]`);
  }
  return frontmatter;
}

/** Today as YYYY-MM-DD in local time (template `{{date}}` and due chips). */
export function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
