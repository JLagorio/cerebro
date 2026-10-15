import { createContext } from 'react';
export const MAX_WHITEBOARD_NESTING = 8;
export const WhiteboardAncestry = createContext<readonly string[]>([]);
export function nestingRefusal(
  ancestors: readonly string[],
  path: string,
): 'self' | 'depth' | null {
  if (ancestors.includes(path)) return 'self';
  return ancestors.length >= MAX_WHITEBOARD_NESTING ? 'depth' : null;
}
