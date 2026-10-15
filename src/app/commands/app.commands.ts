import type { CommandDef } from './index';

/**
 * General: the app-wide keys App.tsx used to read in its own window
 * listener (M65.1), bound in `src/app/useAppCommands.ts` and
 * `src/app/useUndoShortcuts.ts`; then a diagram's own undo and redo, which
 * shadow them.
 */
export const commands: readonly CommandDef[] = [
  {
    id: 'palette.open',
    label: 'Open the command palette',
    keys: ['mod+k'],
    scope: 'app',
    group: 'General',
    inEditor: true,
    inModal: true,
    palette: false,
  },
  {
    // The assistant is a companion to whatever surface you are on (M6).
    id: 'assistant.toggle',
    label: 'Show or hide the assistant',
    keys: ['mod+j'],
    scope: 'app',
    group: 'General',
    inEditor: true,
    inModal: true,
  },
  {
    id: 'capture.new',
    label: 'New capture',
    keys: ['mod+shift+n'],
    scope: 'app',
    group: 'General',
    inEditor: true,
    inModal: true,
  },
  {
    id: 'theme.toggle',
    label: 'Switch light and dark',
    keys: ['mod+shift+l'],
    scope: 'app',
    group: 'General',
    inEditor: true,
    inModal: true,
  },
  // Not inEditor (M15): ⌘[ and ⌘] are outdent and indent inside an editor,
  // and losing the page you are writing on is worse than having no shortcut.
  {
    id: 'nav.back',
    label: 'Back',
    keys: ['mod+['],
    scope: 'app',
    group: 'General',
  },
  {
    id: 'nav.forward',
    label: 'Forward',
    keys: ['mod+]'],
    scope: 'app',
    group: 'General',
  },
  // The person's own changes (M60.7). A text field keeps the browser's and
  // the editor's own history, so neither runs in one.
  {
    id: 'undo',
    label: 'Undo',
    keys: ['mod+z'],
    scope: 'app',
    group: 'General',
  },
  {
    id: 'redo',
    label: 'Redo',
    keys: ['mod+shift+z'],
    scope: 'app',
    group: 'General',
  },
  // A diagram's own history (M29.52, M29.53). Bound by `useDiagramFile` in
  // its page or peek, and by a mermaid block in its own `block` scope while it
  // is editing, so a diagram's ⌘Z stays the diagram's and never reverts a
  // database change behind it.
  {
    id: 'diagram.undo',
    label: 'Undo in the diagram',
    keys: ['mod+z'],
    scope: ['page', 'peek', 'block'],
    group: 'Pages',
    palette: false,
    shadows: ['undo'],
  },
  {
    id: 'diagram.redo',
    label: 'Redo in the diagram',
    keys: ['mod+shift+z'],
    scope: ['page', 'peek', 'block'],
    group: 'Pages',
    palette: false,
    shadows: ['redo'],
  },
];
