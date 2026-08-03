import React, { useEffect, useId, useRef } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { useFocusRestore } from '@/hooks/useFocusRestore';
import { isTopLayer, ownsEscape, useLayer } from '@/components/ui/layers';

const css = `
.cb-dlg-scrim{position:fixed;inset:0;background:var(--scrim);display:flex;align-items:flex-start;justify-content:center;padding:64px 24px;z-index:1000;animation:cbFade var(--dur-med) var(--ease-out)}
.cb-dlg{background:var(--n-0);border-radius:var(--r-xl);box-shadow:var(--shadow-lg);width:100%;display:flex;flex-direction:column;max-height:calc(100vh - 128px);animation:cbUp var(--dur-med) var(--ease-out)}
.cb-dlg:focus{outline:none}
.cb-dlg-hd{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 0 24px}
.cb-dlg-hd h2{margin:0;font-size:var(--fs-lg);line-height:var(--lh-lg);font-weight:600;letter-spacing:var(--track-tight);color:var(--n-900)}
.cb-dlg-bd{padding:16px 24px;overflow:auto;font-size:var(--fs-sm);color:var(--n-800)}
.cb-dlg-ft{display:flex;align-items:center;gap:8px;padding:14px 24px;border-top:1px solid var(--n-100)}
.cb-dlg-ft .cb-dlg-note{font-size:var(--fs-xs);color:var(--text-muted);margin-right:auto}
@keyframes cbFade{from{opacity:0}to{opacity:1}}
@keyframes cbUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`;
if (typeof document !== 'undefined' && !document.getElementById('cb-dlg-css')) {
  const t = document.createElement('style');
  t.id = 'cb-dlg-css';
  t.textContent = css;
  document.head.appendChild(t);
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DialogAction {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}

/** Modal dialog: flat scrim, radius-14 card, footer actions right-aligned. */
export interface DialogProps {
  open: boolean;
  onClose?: () => void;
  title: string;
  children?: React.ReactNode;
  /** max width px, default 560 */
  width?: number;
  primaryAction?: DialogAction;
  secondaryAction?: DialogAction;
  /** muted left-aligned footer text */
  footerNote?: string;
  style?: React.CSSProperties;
}

export function Dialog(props: DialogProps) {
  // The modal behaviour (escape, focus trap, focus restore) lives in a child
  // that only exists while open, so its effects mount and unmount with the
  // dialog rather than needing an `open` guard in every one of them.
  if (!props.open) return null;
  return <DialogCard {...props} />;
}

function DialogCard({
  onClose,
  title,
  children,
  width = 560,
  primaryAction,
  secondaryAction,
  footerNote,
  style,
}: DialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const layerId = useLayer();

  // Focus goes back where it came from on close. Captured at render time, not
  // here: the very child this effect defers to below has ALREADY taken focus
  // by the time an effect can look, so reading `activeElement` here recorded
  // QuickOpen's own input as the thing to restore to — a node unmounted with
  // the dialog, and so never restored to at all (PR #7 review).
  useFocusRestore();

  // Escape closes and focus moves in on open. Without these the dialog was
  // `aria-modal` in name only: keyboard users tabbed straight out onto the
  // rail behind the scrim and landed on <body> after closing.
  useEffect(() => {
    const card = cardRef.current;
    // A child that took focus itself (Input autoFocus in QuickOpen) wins —
    // child effects run before this one, so only claim focus if nothing inside
    // the card already has it.
    if (card && !card.contains(document.activeElement)) {
      const first = card.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? card).focus();
    }
  }, []);

  useEffect(() => {
    // Escape listens on the BUBBLE phase so anything nested that claims the key
    // first still wins: window-capture overlays (useEscapeToClose) never reach
    // us at all, and React handlers that call stopPropagation (RelationPicker,
    // Dropdown, QuickAdd…) stop the native event too. Tab is capture, because
    // the trap has to beat the browser's own focus move.
    const onEscape = (e: KeyboardEvent) => {
      const card = cardRef.current;
      if (e.key !== 'Escape' || !card || !onClose) return;
      // Only the innermost dismissable surface takes the keystroke, so Escape
      // dismisses one thing at a time. This used to compare `.cb-dlg` nodes in
      // document order, which could only see other dialogs — a popover opened
      // from inside a dialog was not counted, and both closed at once (M16.1).
      // `ownsEscape`, not `isTopLayer`: the latter skips tooltips, which is
      // right for the Tab trap below and wrong here, where a visible tooltip
      // is exactly what the keystroke is aimed at (M16.35).
      if (!ownsEscape(layerId)) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onTab = (e: KeyboardEvent) => {
      const card = cardRef.current;
      if (e.key !== 'Tab' || !card) return;
      if (!isTopLayer(layerId)) return;
      const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const active = document.activeElement;
      const inside = card.contains(active);
      // Focus parked outside the card by something other than the browser's own
      // tabbing (a portal, a click on the scrim) is left alone; only <body> —
      // where a click on the scrim lands — is pulled back in.
      if (!inside && active !== document.body && active !== null) return;
      if (items.length === 0) {
        e.preventDefault();
        card.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onEscape);
    document.addEventListener('keydown', onTab, true);
    return () => {
      document.removeEventListener('keydown', onEscape);
      document.removeEventListener('keydown', onTab, true);
    };
  }, [onClose, layerId]);

  return (
    <div
      className="cb-dlg-scrim"
      onMouseDown={(e: React.MouseEvent) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div
        ref={cardRef}
        className="cb-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ maxWidth: width, ...style }}
      >
        <div className="cb-dlg-hd">
          <h2 id={titleId}>{title}</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        <div className="cb-dlg-bd">{children}</div>
        {primaryAction || secondaryAction || footerNote ? (
          <div className="cb-dlg-ft">
            {footerNote ? (
              <span className="cb-dlg-note">{footerNote}</span>
            ) : (
              <span className="cb-dlg-note"></span>
            )}
            {secondaryAction ? (
              <Button onClick={secondaryAction.onClick}>{secondaryAction.label}</Button>
            ) : null}
            {primaryAction ? (
              <Button
                variant="primary"
                disabled={primaryAction.disabled}
                onClick={primaryAction.onClick}
              >
                {primaryAction.label}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
