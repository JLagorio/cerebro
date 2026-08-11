import { createContext, useContext } from 'react';

/**
 * Which pane the tree of components below is rendering into.
 *
 * A link inside a document must open in the pane SHOWING that document, not in
 * whichever pane happens to hold focus. With a mouse the two coincide by
 * accident — a pane focuses itself on pointer-down, before the click — but
 * that is event ordering doing the work, and it stops being true the moment a
 * link is followed with the keyboard or a document opens something on its own.
 *
 * Its own module rather than a export from `EditorGroups`, which imports the
 * viewers that need to read it.
 */
export const GroupContext = createContext<string | null>(null);

/** The pane this component is inside, or null outside a pane. */
export const useGroupId = (): string | undefined => useContext(GroupContext) ?? undefined;
