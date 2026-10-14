import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { PageIconGlyph } from '@/components/PageIcon';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { flushOpenPages } from '@/editor/openPages';
import { isKnowledgePath } from '@/engine/okf';
import {
  isEmojiIcon,
  isImagePath,
  pageCoverOf,
  pageIconOf,
  type PageChromeKey,
} from '@/engine/pageChrome';
import type { Entry } from '@/engine/types';
import { canPickFiles, importAttachment, pickFiles } from '@/lib/ipc';
import { PICKABLE_OPTION_COLORS, resolveOptionColor } from '@/lib/swatch';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * A page's icon and cover, drawn above its title (M55.11), on the page and in
 * the record peek alike (M45.6: an anatomy change is owed to both).
 *
 * Nothing set draws nothing. An editable page keeps one row mounted that shows
 * on hover or focus, the FileTree row-actions pattern, offering Add icon and
 * Add cover; a set icon or cover is itself the button that opens its picker,
 * except a lucide icon, which "Customize icon & color…" owns.
 *
 * Every write first lands the open pages' pending saves (`flushOpenPages`,
 * M53.6), so the frontmatter patch never meets a dirty buffer and raises the
 * divergence banner. Opening and closing a picker writes nothing; Remove
 * writes null, which deletes the key; nothing ever writes '' or a fallback.
 * Under knowledge/ the folder is written through the ledger, so the chrome
 * shows there but cannot be set.
 */

export type ChromeVariant = 'page' | 'peek';

/**
 * About forty emoji for the grid, as escapes: the source stays plain text
 * (CV-13), with no raw joiner or variation selector in it.
 */
const EMOJI_GRID = [
  '\u{1F680}',
  '\u{1F4DD}',
  '\u{1F4CC}',
  '\u{1F4A1}',
  '\u{1F3AF}',
  '\u{2705}',
  '\u{2B50}',
  '\u{1F525}',
  '\u{1F4DA}',
  '\u{1F4D6}',
  '\u{1F4C5}',
  '\u{1F4CA}',
  '\u{1F4C8}',
  '\u{1F9E0}',
  '\u{1F4BC}',
  '\u{1F3E0}',
  '\u{1F30D}',
  '\u{1F331}',
  '\u{1F333}',
  '\u{1F308}',
  '\u{2600}\u{FE0F}',
  '\u{1F319}',
  '\u{26A1}',
  '\u{1F48E}',
  '\u{1F381}',
  '\u{1F389}',
  '\u{1F3A8}',
  '\u{1F3B5}',
  '\u{1F4F7}',
  '\u{1F4AC}',
  '\u{1F4E6}',
  '\u{1F527}',
  '\u{2699}\u{FE0F}',
  '\u{1F512}',
  '\u{1F511}',
  '\u{1F9EA}',
  '\u{1F9ED}',
  '\u{1F5FA}\u{FE0F}',
  '\u{2764}\u{FE0F}',
  '\u{1F9D1}\u{200D}\u{1F4BB}',
];

const EMOJI_HINT = '⌃⌘Space opens the macOS emoji picker.';

/** Why a typed vault path cannot be an icon or cover, or null when it can. */
function vaultPathProblem(raw: string): string | null {
  const path = raw.trim();
  if (path === '') return 'Type a path inside the vault.';
  const outside =
    path.startsWith('/') ||
    path.startsWith('\\') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('://') ||
    path.split(/[\\/]/).some((seg) => seg === '..');
  if (outside) return 'Use a path inside the vault, like attachments/cover.png.';
  if (!isImagePath(path)) return "That isn't an image file.";
  return null;
}

/** Land pending saves, then patch one chrome key. `null` deletes it. */
async function writeChrome(path: string, key: PageChromeKey, value: string | null) {
  await flushOpenPages();
  await useVaultStore.getState().patchFrontmatter(path, { [key]: value });
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function canEdit(entry: Entry, editable: boolean): boolean {
  return editable && !isKnowledgePath(entry.path);
}

// --- The pickers ------------------------------------------------------------

/** The two doors to an image: the native picker (desktop only), and a typed
 *  vault path. */
function ImageDoors({ onPick }: { onPick: (path: string) => void }) {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = () => {
    const vault = useVaultStore.getState().vaultPath;
    if (vault === null) return;
    const { toast } = useUiStore.getState();
    void (async () => {
      setBusy(true);
      try {
        const picked = await pickFiles();
        if (picked.length === 0) return;
        if (!isImagePath(picked[0])) {
          toast('Choose an image file');
          return;
        }
        onPick(await importAttachment(vault, picked[0]));
      } catch (e) {
        toast(`Couldn't add the image — ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="flex flex-col gap-2">
      {canPickFiles() && (
        <button
          type="button"
          disabled={busy}
          onClick={choose}
          className="inline-flex items-center gap-1.5 rounded-md border border-n-200 bg-n-0 px-2 py-1 text-sm text-n-700 hover:bg-n-50 disabled:opacity-50"
        >
          <Icon name="upload" size={13} color="var(--n-500)" />
          {busy ? 'Adding…' : 'Choose an image…'}
        </button>
      )}
      <label className="flex flex-col gap-1 text-2xs text-n-500">
        Vault path
        <input
          aria-label="Vault path"
          placeholder="attachments/cover.png"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const why = vaultPathProblem(draft);
            if (why !== null) {
              setProblem(why);
              return;
            }
            onPick(draft.trim());
          }}
          className="h-7 rounded-md border border-n-200 px-2 text-sm text-n-800 outline-none focus:border-cortex-500"
        />
      </label>
      {problem !== null && (
        <span role="alert" className="text-2xs text-danger-600">
          {problem}
        </span>
      )}
    </div>
  );
}

function RemoveButton({ onRemove }: { onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="self-start rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-danger-600"
    >
      Remove
    </button>
  );
}

function PageIconPicker({
  anchorRef,
  hasIcon,
  onPick,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  hasIcon: boolean;
  onPick: (value: string | null) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'emoji' | 'upload'>('emoji');
  const [typed, setTyped] = useState('');
  const [refused, setRefused] = useState(false);
  return (
    <Popover anchorRef={anchorRef} role="dialog" ariaLabel="Page icon" onClose={onClose} trapFocus>
      <div
        data-testid="page-icon-picker"
        className="flex w-[292px] flex-col gap-2 rounded-lg border border-n-200 bg-n-0 p-2 shadow-lg"
      >
        <SegmentedControl
          ariaLabel="Icon source"
          value={tab}
          onChange={(v) => setTab(v as 'emoji' | 'upload')}
          options={[
            { value: 'emoji', label: 'Emoji' },
            { value: 'upload', label: 'Upload' },
          ]}
        />
        {tab === 'emoji' ? (
          <>
            <input
              autoFocus
              aria-label="Emoji"
              placeholder="Type or paste one emoji"
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                setRefused(false);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (isEmojiIcon(typed)) onPick(typed.trim());
                else setRefused(true);
              }}
              className="h-7 rounded-md border border-n-200 px-2 text-sm text-n-800 outline-none focus:border-cortex-500"
            />
            <span
              data-testid="page-emoji-hint"
              role={refused ? 'alert' : undefined}
              className={['text-2xs', refused ? 'text-danger-600' : 'text-n-500'].join(' ')}
            >
              {refused ? `One emoji only. ${EMOJI_HINT}` : EMOJI_HINT}
            </span>
            <div className="grid grid-cols-8 gap-0.5" data-testid="page-emoji-grid">
              {EMOJI_GRID.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={emoji}
                  onClick={() => onPick(emoji)}
                  className="flex h-8 w-8 items-center justify-center rounded-md border-0 bg-transparent text-lg hover:bg-n-50"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </>
        ) : (
          <ImageDoors onPick={onPick} />
        )}
        {hasIcon && <RemoveButton onRemove={() => onPick(null)} />}
      </div>
    </Popover>
  );
}

function CoverPicker({
  anchorRef,
  hasCover,
  onPick,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  hasCover: boolean;
  onPick: (value: string | null) => void;
  onClose: () => void;
}) {
  return (
    <Popover anchorRef={anchorRef} role="dialog" ariaLabel="Page cover" onClose={onClose} trapFocus>
      <div
        data-testid="page-cover-picker"
        className="flex w-[292px] flex-col gap-2 rounded-lg border border-n-200 bg-n-0 p-2 shadow-lg"
      >
        <span className="text-2xs font-medium text-n-500">Color</span>
        <div className="flex flex-wrap gap-1">
          {PICKABLE_OPTION_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={capitalize(color)}
              title={capitalize(color)}
              onClick={() => onPick(color)}
              className="h-6 w-6 rounded-md border border-n-200"
              style={{ background: resolveOptionColor(color).solid }}
            />
          ))}
        </div>
        <span className="text-2xs font-medium text-n-500">Image</span>
        <ImageDoors onPick={onPick} />
        {hasCover && <RemoveButton onRemove={() => onPick(null)} />}
      </div>
    </Popover>
  );
}

/** Which picker is open, and what to anchor it to. */
function usePicker() {
  const anchor = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState<PageChromeKey | null>(null);
  return {
    anchor,
    open,
    show: (key: PageChromeKey, el: HTMLElement) => {
      anchor.current = el;
      setOpen(key);
    },
    close: () => setOpen(null),
  };
}

// --- The cover band ---------------------------------------------------------

export function PageCoverBand({
  entry,
  editable,
  variant = 'page',
}: {
  entry: Entry;
  editable: boolean;
  variant?: ChromeVariant;
}) {
  const picker = usePicker();
  const cover = pageCoverOf(entry);
  if (cover === null) return null;
  const canSet = canEdit(entry, editable);
  const height = variant === 'page' ? 'h-[168px]' : 'h-[72px]';
  const background = cover.kind === 'color' ? resolveOptionColor(cover.raw).solid : 'var(--n-100)';
  const content =
    cover.kind === 'file' ? (
      // A named placeholder: the webview loads no vault bytes before M66.2.
      <span className="inline-flex items-center gap-1.5 text-xs text-n-500">
        <Icon name="image" size={14} color="var(--n-500)" />
        <span className="truncate">{cover.path}</span>
      </span>
    ) : null;
  const className = [
    'flex w-full flex-none items-center justify-center border-0 p-0',
    height,
    canSet ? 'cursor-pointer' : '',
  ].join(' ');
  return (
    <>
      {canSet ? (
        <button
          type="button"
          data-testid="page-cover"
          aria-label="Change cover"
          title={cover.kind === 'file' ? cover.path : undefined}
          className={className}
          style={{ background }}
          onClick={(e) => picker.show('cover', e.currentTarget)}
        >
          {content}
        </button>
      ) : (
        <div
          data-testid="page-cover"
          title={cover.kind === 'file' ? cover.path : undefined}
          className={className}
          style={{ background }}
        >
          {content}
        </div>
      )}
      {picker.open === 'cover' && (
        <CoverPicker
          anchorRef={picker.anchor}
          hasCover
          onClose={picker.close}
          onPick={(value) => {
            picker.close();
            void writeChrome(entry.path, 'cover', value);
          }}
        />
      )}
    </>
  );
}

// --- The icon header --------------------------------------------------------

export function PageIconHeader({
  entry,
  editable,
  variant = 'page',
  children,
  className,
}: {
  entry: Entry;
  editable: boolean;
  variant?: ChromeVariant;
  /** The peek's title, which shares the icon's row; hovering it shows the
   *  Add row at the row's end. */
  children?: ReactNode;
  className?: string;
}) {
  const picker = usePicker();
  const icon = pageIconOf(entry);
  const cover = pageCoverOf(entry);
  const canSet = canEdit(entry, editable);
  // A lucide name is a Type doc's or a Collection's own icon, edited through
  // "Customize icon & color…" with its colour beside it; the page picker
  // writes only emoji and images, so it leaves that one alone.
  const iconEditable = canSet && icon?.kind !== 'lucide';
  const offerIcon = canSet && icon === null;
  const offerCover = canSet && cover === null;
  if (icon === null && !offerIcon && !offerCover && children === undefined) return null;

  const size = variant === 'page' ? 52 : 22;
  const glyph = <PageIconGlyph icon={icon} fallback={{ name: 'file-text' }} size={size} />;

  const addButton = (key: PageChromeKey) => (
    <button
      type="button"
      data-testid={key === 'icon' ? 'page-add-icon' : 'page-add-cover'}
      onClick={(e) => picker.show(key, e.currentTarget)}
      className="inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
    >
      <Icon name={key === 'icon' ? 'smile' : 'image'} size={13} />
      {key === 'icon' ? 'Add icon' : 'Add cover'}
    </button>
  );

  const addRow =
    offerIcon || offerCover ? (
      <span
        data-testid="page-chrome-add"
        className={[
          'inline-flex items-center gap-0.5 group-hover/chrome:opacity-100 focus-within:opacity-100',
          // Shown while its picker is open, so the anchor does not vanish.
          picker.open === null ? 'opacity-0' : 'opacity-100',
          // Neither takes room: on the page the row sits in the padding above
          // the title, and in the peek over the end of the title's row.
          variant === 'page'
            ? 'absolute bottom-full left-[48px] h-6'
            : 'absolute right-0 top-1/2 -translate-y-1/2 rounded-md bg-n-0',
        ].join(' ')}
      >
        {offerIcon && addButton('icon')}
        {offerCover && addButton('cover')}
      </span>
    ) : null;

  return (
    <div
      data-testid="page-chrome"
      className={[
        'group/chrome relative flex',
        // On the page, the editor's 54px block gutter: the icon, the title
        // and the first paragraph share one left edge.
        variant === 'page' ? 'flex-col items-start pl-[52px]' : 'items-center gap-1',
        className ?? '',
      ].join(' ')}
    >
      {icon !== null &&
        (iconEditable ? (
          <button
            type="button"
            data-testid="page-icon"
            aria-label="Change icon"
            onClick={(e) => picker.show('icon', e.currentTarget)}
            className={[
              'inline-flex items-center justify-center rounded-md border-0 bg-transparent p-0.5 hover:bg-n-50',
              variant === 'page' ? 'mb-2' : '',
            ].join(' ')}
          >
            {glyph}
          </button>
        ) : (
          <span
            data-testid="page-icon"
            className={['inline-flex p-0.5', variant === 'page' ? 'mb-2' : ''].join(' ')}
          >
            {glyph}
          </span>
        ))}
      {children}
      {addRow}
      {picker.open === 'icon' && (
        <PageIconPicker
          anchorRef={picker.anchor}
          hasIcon={icon !== null}
          onClose={picker.close}
          onPick={(value) => {
            picker.close();
            void writeChrome(entry.path, 'icon', value);
          }}
        />
      )}
      {picker.open === 'cover' && (
        <CoverPicker
          anchorRef={picker.anchor}
          hasCover={cover !== null}
          onClose={picker.close}
          onPick={(value) => {
            picker.close();
            void writeChrome(entry.path, 'cover', value);
          }}
        />
      )}
    </div>
  );
}
