/**
 * Markdown reduced to the words in it, for one-line summaries.
 *
 * The Docs tab lists files by title and first paragraph. That paragraph comes
 * off disk as markdown, so an excerpt printed verbatim reads
 * "A ledger. ## Install ```bash pnpm install ```" — the syntax competing with
 * the sentence it is supposed to be summarising.
 *
 * Deliberately NOT a markdown parser. This is a display cleanup for a single
 * line of preview text; running the real parser to throw away everything it
 * produced would cost more than the whole tab is worth. The rendered document
 * is the place syntax is honoured, and that already goes through remark.
 */
const RULES: [RegExp, string][] = [
  // Fenced blocks, before anything else can see their contents.
  [/```[\s\S]*?```/g, ' '],
  [/~~~[\s\S]*?~~~/g, ' '],
  // Images before links: an image is a link with a bang, and dropping the alt
  // text keeps "See ![diagram](a.png)" from reading as "See diagram".
  [/!\[[^\]]*\]\([^)]*\)/g, ' '],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  // Wikilinks: `[[target|label]]` shows the label, `[[target]]` the target.
  [/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2'],
  [/\[\[([^\]]*)\]\]/g, '$1'],
  // Leading block syntax, line by line.
  [/^\s{0,3}#{1,6}\s+/gm, ''],
  [/^\s{0,3}>\s?/gm, ''],
  [/^\s{0,3}([-*+]|\d+\.)\s+/gm, ''],
  [/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/gm, ' '],
  // Inline emphasis and code. The marks go; what they wrapped stays.
  [/`{1,3}([^`]*)`{1,3}/g, '$1'],
  [/(\*\*|__)(.*?)\1/g, '$2'],
  [/(\*|_)(.*?)\1/g, '$2'],
  [/~~(.*?)~~/g, '$1'],
  // An HTML comment carries nothing a reader wants in a summary.
  [/<!--[\s\S]*?-->/g, ' '],
];

export function plainExcerpt(markdown: string): string {
  let text = markdown;
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, ' ').trim();
}
