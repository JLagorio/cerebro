import { createContext, useContext } from 'react';

/**
 * Commenting on a page's text (M70.2b): what the selection toolbar's Comment
 * button calls. Only DocPage provides it, and only on a page it lets you
 * edit, so the record peek (Q6) and read-only pages show no button. Null
 * everywhere else.
 */
export interface PageComments {
  /** Anchor a new comment on the current selection, or say why it can't. */
  start(): void;
}

export const PageCommentsContext = createContext<PageComments | null>(null);

export const usePageCommentsContext = (): PageComments | null => useContext(PageCommentsContext);
