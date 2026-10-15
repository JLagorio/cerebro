import type { CommandDef } from './index';
export const group = 'File viewer';
export const commands: readonly CommandDef[] = [
  {
    id: 'viewer.fit',
    label: 'Fit image',
    keys: ['mod+9'],
    scope: 'file-viewer',
    group,
    desktopOnly: true,
    shadows: ['work.focusGroup'],
  },
  { id: 'viewer.actual', label: 'Image at 100%', keys: ['mod+0'], scope: 'file-viewer', group },
  {
    id: 'viewer.quickLook',
    label: 'Quick Look',
    keys: ['space', 'mod+y'],
    scope: 'file-viewer',
    group,
    desktopOnly: true,
  },
];
