// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import type { ComponentProps, ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { httpUrl } from '@/engine/ai/sources';
import type { SourceRef } from '@/engine/ai/types';
import type { CollapsibleOpenProps } from './Collapsible';
import { plural, useStepOpen, vaultPathOf, type VaultPathProps } from './StepLine';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './Trace';
import './trace-steps.css';
import './trace-results.css';

/**
 * What a reply drew on (M91.9, shadcn's Sources): one line, "Used 3 sources",
 * that opens onto a line per source, in the order the turn met them
 * (engine/ai/sources.ts). A web page is a link that opens in the browser, and
 * says so to a screen reader; a vault page is a button that opens it in the
 * app, through the caller, never an href (CV-16). A source that is neither —
 * a URL that is not http(s), a path outside the vault — is text.
 */

/** The element's words. */
export const SOURCES_WORDS = {
  used: (count: number) => `Used ${plural(count, 'source', 'sources')}`,
  newTab: ' (opens in a new tab)',
  open: 'Open ',
} as const;

/** A URL's host as a reader knows it, without "www.", or null for text that
 *  is no URL. */
export function sourceHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/** What a source is called: the title it was given, else its host, else its
 *  address as written. */
export function sourceName(source: SourceRef): string {
  const title = source.title?.trim();
  if (title) return title;
  if (source.kind === 'vault') return source.path;
  return sourceHost(source.url) ?? source.url;
}

export type SourceProps = VaultPathProps & {
  source: SourceRef;
  /** Quieter words after its name, inside the row and never cut short: where
   *  the source stands ("replaced"), as a step's count is drawn. */
  description?: ReactNode;
  className?: string;
  /** An explicit tab stop for the link or the button: WebKit leaves a native
   *  button without one out of the Tab order, so a caller that wants the
   *  row reached says so. A row of text takes none. */
  tabIndex?: number;
};

/**
 * One source, as a row of the list: a link for a web page, a button for a
 * vault page the caller can open, else a line of text. A titled web page
 * names its host after the title, since the title is the page's word and the
 * host is where the link goes.
 */
export function Source({
  source,
  description,
  onOpenPath,
  isVaultPath,
  className,
  tabIndex,
}: SourceProps) {
  const name = sourceName(source);
  const slot = {
    'data-slot': 'source',
    'data-kind': source.kind,
    'data-via': source.via,
  };
  const words = description !== undefined && description !== null && description !== '' && (
    <TraceDescription>{description}</TraceDescription>
  );
  if (source.kind === 'url') {
    const url = httpUrl(source.url);
    const host = url === null ? null : sourceHost(url);
    const line = (
      <TraceLine>
        <TraceIcon>
          <Icon name="globe" size={16} />
        </TraceIcon>
        <TraceTitle>{name}</TraceTitle>
        {host !== null && host !== name && <TraceDescription>{host}</TraceDescription>}
        {words}
        {url !== null && (
          <>
            <span className="sr-only">{SOURCES_WORDS.newTab}</span>
            <TraceIcon>
              <Icon name="arrow-up-right" size={16} />
            </TraceIcon>
          </>
        )}
      </TraceLine>
    );
    if (url === null) {
      return (
        <div {...slot} className={className}>
          {line}
        </div>
      );
    }
    return (
      <a
        {...slot}
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        title={url}
        tabIndex={tabIndex}
        className={className}
      >
        {line}
      </a>
    );
  }
  const path = onOpenPath === undefined ? null : vaultPathOf(source.path, isVaultPath);
  const line = (
    <TraceLine>
      <TraceIcon>
        <Icon name="file-text" size={16} />
      </TraceIcon>
      <TraceTitle>
        {path !== null && <span className="sr-only">{SOURCES_WORDS.open}</span>}
        {name}
      </TraceTitle>
      {words}
    </TraceLine>
  );
  if (path === null || onOpenPath === undefined) {
    return (
      <div {...slot} title={source.path} className={className}>
        {line}
      </div>
    );
  }
  return (
    <button
      type="button"
      {...slot}
      title={source.path}
      tabIndex={tabIndex}
      className={['cb-ai-step-link', className].filter(Boolean).join(' ')}
      onClick={() => onOpenPath(path)}
    >
      {line}
    </button>
  );
}

export type SourcesProps = Omit<ComponentProps<'div'>, 'title' | 'children'> &
  CollapsibleOpenProps &
  VaultPathProps & {
    sources: readonly SourceRef[];
    /** The line's sentence; left out, "Used 3 sources". */
    title?: ReactNode;
    /** An icon name for the line; a book by default. */
    icon?: string;
  };

/** The sources. They start closed, and a reply that drew on none draws
 *  nothing. */
export function Sources({
  sources,
  title,
  icon = 'book-open',
  onOpenPath,
  isVaultPath,
  open,
  defaultOpen,
  onOpenChange,
  className,
  ...props
}: SourcesProps) {
  const opened = useStepOpen({ open, defaultOpen, onOpenChange }, false);
  if (sources.length === 0) return null;
  return (
    <TraceCollapsible
      data-slot="sources"
      {...props}
      className={className}
      open={opened.open}
      onOpenChange={opened.onOpenChange}
    >
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon>
            <Icon name={icon} size={16} />
          </TraceIcon>
          <TraceTitle>{title ?? SOURCES_WORDS.used(sources.length)}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted>
        <Trace data-slot="sources-list">
          {sources.map((source, index) => (
            <Source
              // Deduped by collectSources; the place keeps a repeat apart.
              key={`${index}:${source.kind === 'url' ? source.url : source.path}`}
              source={source}
              onOpenPath={onOpenPath}
              isVaultPath={isVaultPath}
            />
          ))}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
