import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ownsEscape, useLayer } from '@/components/ui/layers';

/**
 * What marks a drawer: every panel drawn as one carries `data-overlay`
 * (DocSidePanel, DocPagesPanel, the sidebar behind its rail), and the scrim
 * asks it of an Escape's target to tell a field in the drawer from one
 * outside it.
 */
const DRAWER = '[data-overlay]';

/** Inputs that take no typing, and so hold no draft an Escape could lose. */
const UNTYPED = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** A field that takes typing, and so has a value an Escape could lose. */
function isField(node: EventTarget | null): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    (node.isContentEditable ||
      node instanceof HTMLTextAreaElement ||
      (node instanceof HTMLInputElement && !UNTYPED.has(node.type)))
  );
}

/**
 * The ways out of a drawer (M52): Escape, and a press on what it covers.
 *
 * A drawer is a panel the layout had no room for, opened on request over the
 * content beside it — a page's folded side or Pages panel, the sidebar behind
 * its rail. Its header toggle was the only way to close one, so a drawer
 * opened over the reading column stayed there until you found that button
 * again. Mount this beside the drawer, under it: it covers what the drawer
 * covers, takes the press that dismisses it, and registers the drawer as a
 * layer, so Escape closes the drawer before anything behind it.
 *
 * `onDismiss` closes the DRAWER, never the panel: a fold is derived, and the
 * stored open flag behind it is the user's word, not the shell's.
 *
 * Escape hands focus back to whatever opened the drawer; a press does not,
 * because a press put the pointer somewhere else on purpose, and focus on the
 * header toggle would pop its tooltip up under nobody's hand.
 *
 * Transparent on purpose. The drawer's own shadow says it floats; a tint
 * would say "modal", and nothing here is waiting on an answer.
 */
export function DrawerScrim({
  onDismiss,
  label,
  className,
  testId,
}: {
  onDismiss: () => void;
  /** What a press here closes, for the one who cannot see the drawer. */
  label: string;
  /** Positions it: the box it covers, and a z-index under the drawer's. */
  className: string;
  testId?: string;
}) {
  // Read during the first render, before the drawer takes focus — see
  // useFocusRestore for why an effect reads the wrong element.
  const [opener] = useState<HTMLElement | null>(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });
  const byKey = useRef(false);
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  const id = useLayer();
  // Escape, in the BUBBLE phase on window — DetailEscapeLayer's, and for the
  // same reason: a field in the drawer has the keystroke first. As a capture
  // layer (`useEscapeLayer`) it had it before the field did, so Escape in a
  // property typed into a drawer closed the drawer and unmounted the field
  // with its draft unsaved, where the same keystroke in the docked panel
  // left the value where it was. A field that claims Escape (the record's
  // property editor abandons its draft) stops it on the way; one that does
  // not is blurred, so its commit runs, and the drawer stays: one keystroke
  // leaves the field, the next closes the drawer. Layout phase, like
  // `useLayer`, so the first keystroke after opening is not missed.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // A menu, a dialog or a tooltip opened over the drawer owns it.
      if (!ownsEscape(id)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const field = isField(e.target) ? e.target : null;
      const drawer = field?.closest<HTMLElement>(DRAWER) ?? null;
      if (field !== null && drawer !== null) {
        field.blur();
        drawer.focus({ preventScroll: true });
        return;
      }
      byKey.current = true;
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);
  useEffect(
    () => () => {
      if (!byKey.current || opener === null || !opener.isConnected) return;
      const now = document.activeElement;
      if (now === null || now === document.body) opener.focus();
    },
    [opener],
  );
  return (
    <button
      type="button"
      // Out of the tab order: Escape is the keyboard's way out, and a second
      // stop that only closes the drawer would sit between it and the page.
      tabIndex={-1}
      aria-label={label}
      data-testid={testId}
      onClick={onDismiss}
      className={`cursor-default border-0 bg-transparent p-0 ${className}`}
    />
  );
}

/**
 * Focus a drawer as it opens (M52), and return the ref that says which.
 *
 * Moving focus in is what a keyboard user needs to reach it at all — and it
 * takes focus off the toggle that opened it, whose tooltip would otherwise
 * appear 400ms later, stack itself above the drawer, and take the first
 * Escape meant for the drawer (layers.ts gives a tooltip its own Escape).
 * The element needs `tabIndex={-1}` to take it.
 */
export function useDrawerFocus<T extends HTMLElement>(open: boolean): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (open) ref.current?.focus({ preventScroll: true });
  }, [open]);
  return ref;
}
