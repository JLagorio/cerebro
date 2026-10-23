import { cloneElement, createElement, type ReactElement, type ReactNode } from 'react';

/** What a part hands the element it draws as. */
export interface PartProps {
  className?: string;
  children?: ReactNode;
  [attribute: string]: unknown;
}

/**
 * shadcn's `render` prop (Base UI's `useRender`) in its element form only: a
 * part draws as `render` — a link, say — instead of its own tag. The part's
 * attributes go on that element; the element's own props win where both name
 * one, its classes come before the part's are added, and its own children, if
 * it has any, replace the part's.
 */
export function renderPart(
  tag: 'div' | 'span',
  render: ReactElement<PartProps> | undefined,
  props: PartProps,
): ReactElement {
  if (render === undefined) return createElement(tag, props);
  const own = render.props;
  return cloneElement(render, {
    ...props,
    ...own,
    className: [own.className, props.className].filter(Boolean).join(' '),
    children: own.children ?? props.children,
  });
}
