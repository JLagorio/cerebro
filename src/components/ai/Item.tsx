// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { createContext, useContext, type ComponentProps, type ReactElement } from 'react';
import { renderPart, type PartProps } from './renderPart';
import './foundation.css';

/**
 * A row of media, content and actions — a source, a file, a queued step
 * (M91.7, shadcn's Item). Items in an ItemGroup are its list's items; a
 * separator between them is drawn, not read.
 */

export type ItemVariant = 'default' | 'outline' | 'muted';
export type ItemSize = 'default' | 'sm' | 'xs';
export type ItemMediaVariant = 'default' | 'icon' | 'image';

/** Whether an item sits in an ItemGroup's list. */
const InItemGroup = createContext(false);

/** A list of items. */
export function ItemGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <InItemGroup value>
      <div
        role="list"
        data-slot="item-group"
        {...props}
        className={['cb-ai-item-group', className].filter(Boolean).join(' ')}
      />
    </InItemGroup>
  );
}

/** A rule between items: decoration, hidden from assistive tech, so a list
 *  holds only its items. */
export function ItemSeparator({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="item-separator"
      {...props}
      aria-hidden="true"
      className={['cb-ai-item-separator', className].filter(Boolean).join(' ')}
    />
  );
}

export type ItemProps = ComponentProps<'div'> & {
  variant?: ItemVariant;
  size?: ItemSize;
  /** Draw as this element instead of a div — a link — with the item's classes
   *  and slot added to it. */
  render?: ReactElement<PartProps>;
};

/** One row. Inside an ItemGroup, drawn as its own div, it is a listitem. */
export function Item({
  variant = 'default',
  size = 'default',
  render,
  className,
  ...props
}: ItemProps) {
  const listed = useContext(InItemGroup);
  return renderPart('div', render, {
    role: listed && render === undefined ? 'listitem' : undefined,
    'data-slot': 'item',
    ...props,
    'data-variant': variant,
    'data-size': size,
    className: [
      'cb-ai-item',
      variant !== 'default' && `cb-ai-item-${variant}`,
      size !== 'default' && `cb-ai-item-${size}`,
      className,
    ]
      .filter(Boolean)
      .join(' '),
  });
}

/** The row's icon or picture. A picture is drawn by one of the app's image
 *  components (CV-61); this only sizes it. */
export function ItemMedia({
  variant = 'default',
  className,
  ...props
}: ComponentProps<'div'> & { variant?: ItemMediaVariant }) {
  return (
    <div
      data-slot="item-media"
      {...props}
      data-variant={variant}
      className={[
        'cb-ai-item-media',
        variant !== 'default' && `cb-ai-item-media-${variant}`,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  );
}

export function ItemContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="item-content"
      {...props}
      className={['cb-ai-item-content', className].filter(Boolean).join(' ')}
    />
  );
}

export function ItemTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="item-title"
      {...props}
      className={['cb-ai-item-title', className].filter(Boolean).join(' ')}
    />
  );
}

/** At most two lines of quieter text under the title. */
export function ItemDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="item-description"
      {...props}
      className={['cb-ai-item-description', className].filter(Boolean).join(' ')}
    />
  );
}

export function ItemActions({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="item-actions"
      {...props}
      className={['cb-ai-item-actions', className].filter(Boolean).join(' ')}
    />
  );
}

/** A full-width row above the item's media and content. */
export function ItemHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="item-header"
      {...props}
      className={['cb-ai-item-header', className].filter(Boolean).join(' ')}
    />
  );
}

/** A full-width row below the item's media and content. */
export function ItemFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="item-footer"
      {...props}
      className={['cb-ai-item-footer', className].filter(Boolean).join(' ')}
    />
  );
}
