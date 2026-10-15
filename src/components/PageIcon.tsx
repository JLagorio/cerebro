import { Icon } from '@/components/ui/Icon';
import { FileThumb } from './FileThumb';
import { pageIconOf, type PageIcon } from '@/engine/pageChrome';
import type { Entry } from '@/engine/types';
import { resolveOptionColor } from '@/lib/swatch';
import { useEntry } from '@/stores/vaultStore';

/**
 * One glyph for a page's icon, everywhere a page is named (M55.11): the tree,
 * the Pages panel, the crumbs, ⌘K and the page itself.
 *
 * - An emoji draws as text.
 * - A contained file draws through FileThumb; unreadable files and URLs keep
 *   the image glyph without making a remote request.
 * - A lucide name draws through `Icon`, its colour through
 *   `resolveOptionColor`, the one gate a vault colour passes to reach CSS.
 * - Nothing set draws the surface's fallback, which is never written.
 */

export interface GlyphFallback {
  name: string;
  color?: string | null;
}

function FileIcon({ path, size }: { path: string; size: number }) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path) ? (
    <Icon name="image" size={size} color="var(--n-500)" />
  ) : (
    <FileThumb rootId="0" path={path} size={128} compact className="h-full w-full" />
  );
}

export function PageIconGlyph({
  icon,
  fallback,
  size = 14,
  className,
}: {
  icon: PageIcon | null;
  fallback: GlyphFallback;
  size?: number;
  className?: string;
}) {
  if (icon === null) {
    return (
      <Icon
        name={fallback.name}
        size={size}
        color={fallback.color ?? undefined}
        className={className}
      />
    );
  }
  if (icon.kind === 'emoji') {
    return (
      <span
        role="img"
        aria-label={icon.text}
        data-icon-kind="emoji"
        className={className}
        style={{
          display: 'inline-flex',
          flex: 'none',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          fontSize: Math.round(size * 0.9),
          lineHeight: 1,
        }}
      >
        {icon.text}
      </span>
    );
  }
  if (icon.kind === 'file') {
    return (
      <span
        title={icon.path}
        data-icon-kind="file"
        className={className}
        style={{
          display: 'inline-flex',
          flex: 'none',
          width: size,
          height: size,
          overflow: 'hidden',
        }}
      >
        <FileIcon path={icon.path} size={size} />
      </span>
    );
  }
  // No colour keeps the row's own ink; a colour that is not one (a `url(…)`
  // fetch, say) takes the neutral swatch rather than reaching CSS.
  const color = icon.color === null ? undefined : resolveOptionColor(icon.color).solid;
  return <Icon name={icon.name} size={size} color={color} className={className} />;
}

/**
 * The icon of a page, given the entry or its path. A path follows the store,
 * so a row redraws the moment its page's `icon:` changes.
 */
export function EntryIcon({
  entry,
  path,
  fallback,
  size,
  className,
}: {
  entry?: Entry | null;
  path?: string | null;
  fallback: GlyphFallback;
  size?: number;
  className?: string;
}) {
  const looked = useEntry(entry === undefined ? (path ?? null) : null);
  const resolved = entry === undefined ? looked : entry;
  const icon = resolved === null ? null : pageIconOf(resolved);
  return <PageIconGlyph icon={icon} fallback={fallback} size={size} className={className} />;
}
