import {
  cloneElement,
  isValidElement,
  useEffect,
  useState,
  type AnimationEvent,
  type DetailsHTMLAttributes,
  type ReactNode,
} from 'react';
import { LEAVE_CAP_MS, type ArrivalProps } from '@/components/ui/motion';

/**
 * What a fold reveals in the conversation — a call's input and result, the
 * reads a row folds, a file's patch, a card's details — drops in from under
 * its header each time the person opens it (chat.css), and at no other time.
 *
 * Like an arrival (components/ui/motion.ts), the mark is state, taken as the
 * fold opens, and it comes off once the reveal has played, or after the cap
 * when nothing reports its end. Folded onto its button the conversation is
 * hidden, and `display: none` lifting starts every animation under it again,
 * so a fold left open would otherwise drop in each time the conversation
 * opened. A body that mounts open — a card's detail drawn on its first
 * unfold — is opening too.
 */
export function Unfold({ open, children }: { open: boolean; children: ReactNode }) {
  // The open state it last drew, so an opening is seen once, as it happens.
  const [seen, setSeen] = useState(false);
  const [revealing, setRevealing] = useState(false);
  if (open !== seen) {
    setSeen(open);
    setRevealing(open);
  }
  useEffect(() => {
    if (!revealing) return;
    const timer = setTimeout(() => setRevealing(false), LEAVE_CAP_MS);
    return () => clearTimeout(timer);
  }, [revealing]);
  if (!revealing || !isValidElement<ArrivalProps>(children)) return children;
  const own = children.props;
  return cloneElement(children, {
    'data-arrive': '',
    onAnimationEnd: (event: AnimationEvent<HTMLElement>) => {
      own.onAnimationEnd?.(event);
      // Its own reveal, not a child's ending and bubbling up through it.
      if (event.target === event.currentTarget) setRevealing(false);
    },
  });
}

/**
 * A `<details>` whose body unfolds: its open state is the element's own,
 * read back from its `toggle`, so the body drops in when the person opens
 * it. `summary` is the `<summary>` element, as the caller draws it.
 */
export function UnfoldDetails({
  summary,
  children,
  ...details
}: Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'children' | 'onToggle'> & {
  summary: ReactNode;
  children: ReactNode;
  'data-testid'?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details {...details} onToggle={(event) => setOpen(event.currentTarget.open)}>
      {summary}
      <Unfold open={open}>{children}</Unfold>
    </details>
  );
}
