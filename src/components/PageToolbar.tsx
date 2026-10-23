import { useId, useRef, type MouseEvent, type ReactNode, type Ref } from 'react';
import './pageToolbar.css';
import './pageFrame.css';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { keycapText } from '@/components/ui/Keycaps';
import { Tooltip } from '@/components/ui/Tooltip';
import type { SaveState as EditorSaveState } from '@/editor/NoteBodyEditor';
import type { PagePanel } from '@/stores/uiStore';

/**
 * What the toolbar's end adds to its actions while a panel is open beneath
 * it: the end's own inset, the Close button and its gap (pageFrame.css). The
 * page counts it in the panel's floor, so it folds the panel into a drawer
 * before the actions would cross the panel's edge.
 */
export const PANEL_HEAD_CHROME = 60;

/**
 * A page's action bar: the way up on the left, the page's own actions on the
 * right. One bar, so a document, a record and an Inbox capture are worked from
 * the same place and read the same way — each surface supplies its crumbs
 * and its actions, never its own bar.
 *
 * `status` follows the crumbs: what the page says about where it stands (its
 * save state, its place in a queue), which changes as you work and so never
 * rides with the actions, whose width the side panel is fitted to. In a page
 * frame (pageFrame.css) the end sits over an open side panel's head, led by
 * its Close button (`onClosePanel`).
 */
export function PageToolbar({
  crumbs,
  status,
  actions,
  onClosePanel,
  closeTooltip = true,
  actionsRef,
  testId,
}: {
  crumbs: ReactNode;
  status?: ReactNode;
  actions: ReactNode;
  /** Set while a side panel is open: the end leads with its Close button. */
  onClosePanel?: () => void;
  /** `false` withholds Close's tooltip while a drawer it sits over is up. */
  closeTooltip?: boolean;
  /** Measures the actions, which the panel's floor is fitted to. */
  actionsRef?: Ref<HTMLDivElement>;
  testId?: string;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  // Close goes with the panel. From the keyboard, focus moves to the panel's
  // own button, which stays where it was, rather than falling to the page; a
  // pointer leaves focus alone, as a drawer's scrim does, or that button's
  // tooltip would come up under nobody's hand.
  const close = () => {
    const here = document.activeElement;
    const keyboard = here instanceof HTMLElement && here.matches(':focus-visible');
    const opener = endRef.current?.querySelector<HTMLElement>(
      '.cb-panel-buttons [aria-pressed="true"]',
    );
    onClosePanel?.();
    if (keyboard) opener?.focus();
  };
  return (
    <div className="cb-document-toolbar" data-testid={testId}>
      <div className="cb-document-start">
        <div className="cb-document-breadcrumbs">{crumbs}</div>
        {status}
      </div>
      <div ref={endRef} className="cb-document-end">
        {onClosePanel !== undefined && (
          <IconButton
            icon="chevrons-right"
            label="Close panel"
            size="sm"
            tooltip={closeTooltip}
            onClick={close}
            className="cb-panel-close"
          />
        )}
        <div ref={actionsRef} className="cb-document-actions">
          {actions}
        </div>
      </div>
    </div>
  );
}

/**
 * One step of the breadcrumb: a button when it leads somewhere, plain text
 * when it only says where you are. `glyph` is a page's own icon (M55.11),
 * drawn in place of the lucide one. `onClick` receives the click, so a crumb
 * that opens something can hand focus back to the crumb that opened it.
 */
export function Crumb({
  label,
  icon,
  glyph,
  onClick,
  strong = false,
  title,
}: {
  label: string;
  icon?: string;
  glyph?: ReactNode;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  strong?: boolean;
  title?: string;
}) {
  return onClick !== undefined ? (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="motion-hover inline-flex min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-sm text-n-500 hover:bg-n-50 hover:text-n-800"
    >
      {glyph ?? (icon !== undefined && <Icon name={icon} size={13} />)}
      <span className="truncate">{label}</span>
    </button>
  ) : (
    <span
      title={title}
      className={[
        'inline-flex min-w-0 items-center gap-1.5 px-1 text-sm',
        strong ? 'font-medium text-n-900' : 'text-n-500',
      ].join(' ')}
    >
      {glyph ?? (icon !== undefined && <Icon name={icon} size={13} color="var(--n-500)" />)}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** What sits between two crumbs. */
export function CrumbSeparator() {
  return <Icon name="chevron-right" size={12} color="var(--n-300)" />;
}

/** What the bar says about the body's relationship to disk. `idle` is the
 * quiet default — nothing typed yet, so there is nothing to reassure about. */
export const SAVE_LABEL: Record<EditorSaveState, string | null> = {
  idle: null,
  dirty: 'Unsaved',
  saving: 'Saving…',
  saved: 'Saved',
  failed: "Couldn't save",
};

/**
 * The trust signal. Autosave used to be entirely invisible: no dirty marker,
 * no saved state, and ⌘S did nothing — ⌘S now force-flushes the debounce
 * (handled in NoteBodyEditor), and this says where the body stands.
 */
export function SaveState({ state }: { state: EditorSaveState }) {
  const label = SAVE_LABEL[state];
  if (label === null) return null;
  return (
    <span
      // Keyed by the state, so each word fades in over the last rather than
      // swapping (pageToolbar.css); saving, a light passes through it.
      key={state}
      data-testid="doc-save-state"
      title={
        state === 'failed'
          ? undefined
          : `Saves automatically — ${keycapText('page.save')} to save now`
      }
      className={[
        'cb-save-state mr-1 flex-none whitespace-nowrap text-xs',
        state === 'failed' ? 'font-medium text-danger-600' : 'text-[var(--text-meta)]',
        state === 'saving' ? 'cb-working-text' : '',
      ].join(' ')}
    >
      {label}
    </span>
  );
}

/** What each panel is called: its button's name, and the title over it. */
export const PANEL_LABELS: Record<PagePanel, string> = {
  details: 'Details',
  comments: 'Comments',
  history: 'History',
};

/**
 * The page's panels, a button each, at the end of its actions (owner,
 * 2026-10-19 — Notion's properties, discussions and updates): History,
 * Comments and Details each open their panel in the side slot, one at a time,
 * and pressing the one that is open closes it. `shown` is what is on screen,
 * not the stored flag: a folded panel reads as closed, and its button offers
 * to open it. `comments` is the open thread count, `null` on a page that
 * takes no comments. `tooltip={false}` withholds the tooltips while a drawer
 * they opened is up (M52): the pointer that opened it is still resting here,
 * and a tooltip over the drawer would take its first Escape.
 */
export function PanelButtons({
  shown,
  onToggle,
  comments,
  tooltip = true,
}: {
  shown: PagePanel | null;
  onToggle: (panel: PagePanel) => void;
  comments: number | null;
  tooltip?: boolean;
}) {
  const countId = useId();
  const open = comments ?? 0;
  return (
    <span className="cb-panel-buttons">
      <span aria-hidden="true" className="cb-panel-buttons-rule" />
      <IconButton
        icon="history"
        label={PANEL_LABELS.history}
        size="sm"
        active={shown === 'history'}
        tooltip={tooltip}
        onClick={() => onToggle('history')}
      />
      {comments !== null && (
        <>
          {/* IconButton's own look, the count on its corner: the actions keep
              one width however many threads are open, since the panel under
              them is fitted to it. */}
          <Tooltip
            label={open > 0 ? `${PANEL_LABELS.comments} · ${open} open` : PANEL_LABELS.comments}
            disabled={!tooltip}
          >
            <button
              type="button"
              aria-label={PANEL_LABELS.comments}
              aria-pressed={shown === 'comments'}
              // The count is said, not named: the button's name stays its label.
              aria-describedby={open > 0 ? countId : undefined}
              onClick={() => onToggle('comments')}
              className={[
                'cb-ibtn cb-panel-button',
                shown === 'comments' ? 'cb-ibtn-active' : '',
              ].join(' ')}
            >
              <Icon name="message-square" size={14} />
              {open > 0 && (
                <span
                  // Keyed by the count, so a new number lands as one.
                  key={open}
                  data-testid="doc-panel-comment-count"
                  aria-hidden="true"
                  className="cb-panel-button-count"
                >
                  {open}
                </span>
              )}
            </button>
          </Tooltip>
          {open > 0 && (
            <span id={countId} hidden>
              {`${open} open comments`}
            </span>
          )}
        </>
      )}
      <IconButton
        icon="panel-right"
        label={PANEL_LABELS.details}
        size="sm"
        active={shown === 'details'}
        tooltip={tooltip}
        onClick={() => onToggle('details')}
      />
    </span>
  );
}
