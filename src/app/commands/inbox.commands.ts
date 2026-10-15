import type { CommandDef } from './index';

/** The Inbox's loop runs from the keyboard. Bound in `src/pages/InboxPage.tsx`. */
export const commands: readonly CommandDef[] = [
  {
    // Not inEditor: ⌘E/Ctrl+E is end-of-line in every text field on that
    // screen, the capture body right beside the list included, and filing
    // what you are typing into is not recoverable from the keyboard.
    id: 'inbox.file',
    label: 'File the open capture',
    keys: ['mod+e'],
    scope: 'page',
    group: 'Inbox',
  },
];
