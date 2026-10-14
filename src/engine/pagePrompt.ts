import { stringify } from 'yaml';

/**
 * A page as a prompt for an app outside Cerebro (M55.9): what Open with's
 * Copy as prompt copies and its agent links carry.
 *
 * It names the page by its vault-relative path only (Q16): the Claude Code
 * on the web link puts the prompt in a URL sent to claude.ai, and an absolute
 * path would carry the home folder's name with it. And it names no Cerebro
 * tool, because an outside client cannot reach the app's loopback tools.
 */
export interface PagePromptInput {
  title: string;
  /** Vault-relative. */
  path: string;
  properties: Record<string, unknown>;
  /** Wikilink fields, bracket-stripped as the scanner hands them over. */
  relationships: Record<string, readonly string[]>;
  /** The page's markdown, frontmatter already split off. */
  body: string;
}

const EMPTY_BODY = '(This page is empty.)';

function yamlOf(value: Record<string, unknown>): string {
  return Object.keys(value).length === 0 ? '' : stringify(value).trimEnd();
}

export function pagePrompt({
  title,
  path,
  properties,
  relationships,
  body,
}: PagePromptInput): string {
  const links: Record<string, string[]> = {};
  for (const [field, targets] of Object.entries(relationships)) {
    if (targets.length > 0) links[field] = targets.map((target) => `[[${target}]]`);
  }
  const block = [yamlOf(properties), yamlOf(links)].filter((part) => part !== '').join('\n');
  const trimmed = body.trim();
  const lines = ['Use this page from my Cerebro notes as context.', '', `Title: ${title}`];
  lines.push(`Path: ${path}`, '');
  if (block !== '') lines.push('<properties>', block, '</properties>', '');
  lines.push('<page>', trimmed === '' ? EMPTY_BODY : trimmed, '</page>');
  return lines.join('\n');
}
