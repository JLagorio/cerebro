// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import type { ComponentProps, ReactElement } from 'react';
import { renderPart, type PartProps } from './renderPart';
import './foundation.css';

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' | 'link';

export type BadgeProps = ComponentProps<'span'> & {
  variant?: BadgeVariant;
  /** Draw as this element instead of a span — a link — with the badge's
   *  classes and slot added to it. */
  render?: ReactElement<PartProps>;
};

/**
 * A short label beside a title — a model, a count, a file (M91.7, shadcn's
 * Badge). `default` is the filled action ink, `secondary` a quiet fill,
 * `destructive` danger on its own ground, `outline` a hairline, `ghost`
 * nothing until hovered, `link` link ink.
 */
export function Badge({ variant = 'default', render, className, ...props }: BadgeProps) {
  return renderPart('span', render, {
    'data-slot': 'badge',
    ...props,
    'data-variant': variant,
    className: ['cb-ai-badge', `cb-ai-badge-${variant}`, className].filter(Boolean).join(' '),
  });
}
