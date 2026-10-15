import { LazyMarkdownEditor } from '@/editor/LazyMarkdownEditor';
import { splitFrontmatter } from '@/engine/frontmatter';

/** Fences that render live data, not the version's own bytes. */
const LIVE_FENCE = /^\s*(`{3,}|~{3,})\s*cerebro-(database|page|subpages)\b/m;

const ignore = (): void => undefined;

/**
 * One version of a page, as the page it was (M58.4): the body in a
 * read-only editor, split the way the page's own editor reads it, and the
 * raw frontmatter folded under it. Keyed by commit, so a second version
 * remounts rather than reconciling into the first. A database or page-card
 * block draws today's rows, not the version's, and the caption says so.
 */
export function VersionPreview({ commit, text }: { commit: string; text: string }) {
  const { yaml, body } = splitFrontmatter(text);
  const shown = body.replace(/^\n+/, '');
  return (
    <div data-testid="version-preview" className="flex flex-col gap-3">
      {LIVE_FENCE.test(shown) && (
        <p data-testid="version-preview-caption" className="m-0 text-2xs text-n-500">
          Databases and page cards show today's data.
        </p>
      )}
      <LazyMarkdownEditor key={commit} markdown={shown} onChange={ignore} readOnly />
      {yaml !== null && yaml.trim() !== '' && (
        <details data-testid="version-preview-properties" className="text-xs text-n-600">
          <summary className="cursor-pointer text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
            Properties
          </summary>
          <pre className="m-0 mt-1 whitespace-pre-wrap [font-family:var(--font-mono)] text-xs">
            {yaml}
          </pre>
        </details>
      )}
    </div>
  );
}
