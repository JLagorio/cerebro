import { resolveOptionColor } from '@/lib/swatch';
import { useOpenPath } from '@/app/useOpenPath';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { FieldChip } from '@/views/FieldChip';
import { groupTree } from '@/engine/grouping';
import { typeStyle } from '@/engine/typeCatalog';
import { visibleColumns } from '@/engine/views';
import { useUiStore } from '@/stores/uiStore';
import type { CardSize, Entry, GroupNode, Presentation, Schema } from '@/engine/types';

/**
 * Gallery (M16.22) — the same rows every other layout sees, drawn as cards.
 *
 * Three settings, all on `presentation.gallery`: which files property covers a
 * card, how wide a card is, and whether a cover is fitted whole or cropped to
 * fill. WHICH PROPERTIES a card shows is deliberately not among them — that is
 * `columns`, so the Properties page configures a gallery and a table with one
 * control and switching between them keeps your choice.
 *
 * Grouping applies, because grouping is not a layout's business: `groupTree`
 * bands the cards exactly as it bands the list's rows. Relation (nest) levels
 * are ignored here rather than faked — `groupTree` reads band levels only, and
 * a card grid has nowhere to put an outline.
 *
 * COVERS DO NOT RENDER IMAGES YET, on purpose. Since M16.13c a files property
 * stores a vault-relative path (`attachments/cover.png`), and the webview
 * cannot load one: that needs Tauri's `assetProtocol` enabled AND the CSP
 * widened past `img-src 'self' data:` — a deliberate change to what the app may
 * load, which belongs in its own commit. A remote https:// value is blocked by
 * the same line. So a cover tile names the file it would show instead of
 * rendering a broken image, and the setting still round-trips, so galleries
 * configured today light up the day that commit lands.
 */

export interface GalleryViewProps {
  /** Filtered and sorted by the caller. */
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** Collapse-state namespace for bands — the same one the list uses. */
  scope?: string;
  /** True when the view has filters, so the empty state can say why. */
  filtered?: boolean;
}

/** Card width and cover height per size step. The width is a grid MINIMUM —
 * cards stretch to fill the row, so a narrow panel does not scroll sideways. */
const METRICS: Record<CardSize, { min: number; cover: number }> = {
  small: { min: 156, cover: 92 },
  medium: { min: 212, cover: 128 },
  large: { min: 288, cover: 176 },
};

const isUrl = (value: string) => /^(https?|mailto):/i.test(value);

export interface CardCover {
  /** The stored value: a vault-relative path, or a URL. */
  value: string;
  kind: 'file' | 'url';
  /** What the tile says — the basename for a path, the value for a URL. */
  label: string;
}

/**
 * The first value of a card's cover property, or null.
 *
 * FIRST, not "the one that looks like an image": a files property holds an
 * ordered list the user arranged, and picking a favourite out of it would make
 * the cover change when someone renames an attachment.
 */
export function coverOf(entry: Entry, field: string | undefined): CardCover | null {
  if (field === undefined || field === '') return null;
  const raw = entry.properties[field];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined || first === null || first === '') return null;
  const value = String(first);
  if (isUrl(value)) return { value, kind: 'url', label: value };
  return { value, kind: 'file', label: value.split('/').pop() ?? value };
}

function CoverTile({
  cover,
  entry,
  schema,
  height,
  fit,
}: {
  cover: CardCover | null;
  entry: Entry;
  schema: Schema;
  height: number;
  fit: boolean;
}) {
  const style = typeStyle(entry.type, schema);
  return (
    <div
      data-testid="gallery-cover"
      data-cover={cover?.value ?? ''}
      // `fit` has no visual job while there is no image to letterbox, but it
      // is the setting the user chose and the tile is where it will apply —
      // so it is reported here rather than silently dropped.
      data-fit={fit ? 'contain' : 'cover'}
      style={{ height }}
      className="flex flex-col items-center justify-center gap-1 overflow-hidden rounded-t-[9px] border-b border-[var(--n-100)] bg-[var(--n-50)] px-2"
    >
      {cover === null ? (
        <Icon name={style.icon} size={20} strokeWidth={1.5} color={style.color ?? 'var(--n-300)'} />
      ) : (
        <>
          <Icon
            name={cover.kind === 'url' ? 'link' : 'image'}
            size={16}
            strokeWidth={1.5}
            color="var(--n-400)"
          />
          <span className="max-w-full truncate text-[10.5px] text-[var(--n-400)]">
            {cover.label}
          </span>
        </>
      )}
    </div>
  );
}

function GalleryCard({
  entry,
  presentation,
  schema,
  metrics,
}: {
  entry: Entry;
  presentation: Presentation;
  schema: Schema;
  metrics: { min: number; cover: number };
}) {
  // M9.3: the one open rule every layout shares.
  const openPath = useOpenPath('in-place');
  const gallery = presentation.gallery;
  const cover = coverOf(entry, gallery?.cover);
  const chips = visibleColumns(presentation).filter((c) => c.field !== 'key');

  if (entry.parseError !== null) {
    return (
      <div
        data-testid="gallery-card"
        data-path={entry.path}
        className="flex flex-col gap-1 rounded-[10px] border border-[var(--warn-500)] bg-[var(--n-0)] px-2.5 py-2"
      >
        <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--warn-500)]">
          <Icon name="triangle-alert" size={13} />
          Cannot parse
        </span>
        <span className="truncate text-[12px] text-[var(--n-600)]">{entry.filename}</span>
      </div>
    );
  }

  return (
    // A real <button>, not a div with role="button": the board learned that
    // the hard way — its cards advertised themselves as buttons and then did
    // nothing on Enter, because a div gets no native activation (M15).
    <button
      type="button"
      data-testid="gallery-card"
      data-path={entry.path}
      onClick={() => openPath(entry.path)}
      className="flex w-full cursor-pointer flex-col overflow-hidden rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-0 text-left shadow-[var(--shadow-xs)] hover:border-[var(--n-300)] hover:shadow-[var(--shadow-sm)] focus-visible:border-[var(--cortex-500)] focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
    >
      {gallery?.cover !== undefined && (
        <CoverTile
          cover={cover}
          entry={entry}
          schema={schema}
          height={metrics.cover}
          fit={gallery.fit === true}
        />
      )}
      <span className="flex min-w-0 flex-col gap-1.5 px-2.5 py-2">
        <span className="truncate text-[13px] font-medium leading-[18px] text-[var(--n-900)]">
          {entry.title}
        </span>
        {chips.length > 0 && (
          <span className="flex min-w-0 flex-col items-start gap-1">
            {chips.map((c) => (
              <FieldChip key={c.field} resolved={schema.resolveField(entry, c.field)} />
            ))}
          </span>
        )}
      </span>
    </button>
  );
}

function CardGrid({
  entries,
  presentation,
  schema,
  metrics,
}: {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  metrics: { min: number; cover: number };
}) {
  if (entries.length === 0) {
    return <p className="m-0 px-1 py-2 text-[11.5px] text-[var(--n-400)]">Nothing here yet.</p>;
  }
  return (
    <div
      data-testid="gallery-grid"
      className="grid items-start gap-2.5"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${metrics.min}px, 1fr))` }}
    >
      {entries.map((e) => (
        <GalleryCard
          key={e.path}
          entry={e}
          presentation={presentation}
          schema={schema}
          metrics={metrics}
        />
      ))}
    </div>
  );
}

/** One band and everything under it. Recursive, because the grouping chain is:
 * three band levels are three nested headings, not a special case. */
function Band({
  node,
  presentation,
  schema,
  metrics,
  scope,
}: {
  node: GroupNode;
  presentation: Presentation;
  schema: Schema;
  metrics: { min: number; cover: number };
  scope: string;
}) {
  const collapsed = useUiStore((s) => s.collapsed[scope]?.[node.path] === true);
  const toggle = useUiStore((s) => s.toggleCollapsed);
  const swatch = resolveOptionColor(node.color);
  return (
    <section data-testid="gallery-band" data-depth={node.depth} className="mb-4">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => toggle(scope, node.path)}
        className="mb-2 inline-flex items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-[12.5px] font-semibold text-[var(--n-800)] hover:bg-[var(--n-100)]"
      >
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
        <span
          className="box-border h-2.5 w-2.5 flex-none rounded-full"
          style={
            node.ghost || node.color === null
              ? { border: '1.5px solid var(--n-400)' }
              : { background: swatch.solid, border: `1.5px solid ${swatch.solid}` }
          }
        />
        {node.label}
        <span className="[font-family:var(--font-mono)] text-[11px] font-normal text-[var(--n-400)]">
          {node.count}
        </span>
      </button>
      {!collapsed &&
        (node.children.length > 0 ? (
          <div className="pl-4">
            {node.children.map((child) => (
              <Band
                key={child.path}
                node={child}
                presentation={presentation}
                schema={schema}
                metrics={metrics}
                scope={scope}
              />
            ))}
          </div>
        ) : (
          <CardGrid
            entries={node.entries}
            presentation={presentation}
            schema={schema}
            metrics={metrics}
          />
        ))}
    </section>
  );
}

export function GalleryView({
  entries,
  presentation,
  schema,
  scope = 'gallery',
  filtered,
}: GalleryViewProps) {
  const size: CardSize = presentation.gallery?.size ?? 'medium';
  const metrics = METRICS[size];
  const bands = groupTree(entries, presentation.group, schema);

  return (
    <div
      data-testid="gallery-view"
      data-card-size={size}
      data-cover-field={presentation.gallery?.cover ?? ''}
      className="box-border min-h-0 min-w-0 flex-1 overflow-auto bg-[var(--n-25)] px-5 py-4"
    >
      {entries.length === 0 ? (
        <EmptyState
          icon="layout-grid"
          title={filtered === true ? 'Nothing matches these filters' : 'No records yet'}
          description={
            filtered === true
              ? 'Adjust the filters in view settings to widen the query.'
              : 'Records that land in this view appear here as cards.'
          }
        />
      ) : bands.length === 0 ? (
        <CardGrid entries={entries} presentation={presentation} schema={schema} metrics={metrics} />
      ) : (
        bands.map((node) => (
          <Band
            key={node.path}
            node={node}
            presentation={presentation}
            schema={schema}
            metrics={metrics}
            scope={scope}
          />
        ))
      )}
    </div>
  );
}
