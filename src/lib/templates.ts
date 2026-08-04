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
    // `fill:` is an instruction to the APP about this template, not a property
    // of the pages made from it — copying it forward would make every page
    // look like a template and re-fill itself the next time anyone looked.
    if (key === 'fill') continue;
    frontmatter[key] =
      typeof value === 'string' ? substitute(value, vars) : (value as Scalar | Scalar[]);
  }
  for (const [key, targets] of Object.entries(template.relationships)) {
    frontmatter[key] = targets.map((t) => `[[${t}]]`);
  }
  return frontmatter;
}

/**
 * A template that knows how to fill itself (M17.10).
 *
 * `fill:` on a template's frontmatter is an instruction the assistant follows
 * once the page exists — "a PRD, drafted from the record this was created
 * under and what the base already believes about it". It is a declared PROMPT,
 * not a new artifact type: the template is still an ordinary markdown file you
 * can open and edit, and a template without `fill:` behaves exactly as every
 * template did before.
 *
 * Why the prompt lives on the template rather than in the app: the useful
 * version of "AI-assisted PRD" is one the person can change. A built-in
 * generator is a black box that produces someone else's idea of a PRD, and the
 * only way to disagree with it is to stop using it.
 */
export function templateFill(template: Entry): string {
  const raw = template.properties.fill;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * The instruction handed to the assistant for a filled template.
 *
 * The new page is named as the thing to write INTO — it already exists on disk
 * with the template's scaffolding — and the context it should draw on is
 * whatever the panel already assembles (M17.6 chips, M17.20 knowledge). The
 * prompt does not re-describe the vault, because a template author writing
 * `fill:` should be able to say "draft the risks section from what we know"
 * without also explaining what a vault is.
 */
export function templateFillPrompt(path: string, title: string, instruction: string): string {
  return [
    `The page ${path} ("${title}") was just created from a template and is waiting to be filled in.`,
    '',
    `The template asks for: ${instruction}`,
    '',
    'Read the page first — its scaffolding says what shape the result should take, and the headings it already has are the ones to fill rather than replace.',
    'Draw on the records and knowledge in context. Where the base holds nothing on a section, write one line saying so instead of inventing content — a template filled with plausible fiction is worse than one left blank.',
    'Write it with append_to_note or update_frontmatter. Do not create a second page.',
  ].join('\n');
}

/** Today as YYYY-MM-DD in local time (template `{{date}}` and due chips). */
export function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
