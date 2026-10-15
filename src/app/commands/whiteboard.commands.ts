import type { CommandDef } from './index';
import { BOARD_TOOLS } from '@/whiteboard/tools';
export const group = 'Whiteboard';
export const commands: readonly CommandDef[] = [
  {
    id: 'whiteboard.duplicate',
    label: 'Duplicate selected items',
    keys: ['mod+d'],
    scope: 'whiteboard',
    group,
  },
  ...(
    [
      ['front', ']'],
      ['back', '['],
      ['forward', 'alt+]'],
      ['backward', 'alt+['],
    ] as const
  ).map(([to, key]) => ({
    id: `whiteboard.order.${to}`,
    label: `Move ${to}`,
    keys: [key],
    scope: 'whiteboard',
    group,
  })),
  ...BOARD_TOOLS.map((tool) => ({
    id: `whiteboard.tool.${tool.id}`,
    label: tool.label,
    keys: [tool.key],
    scope: 'whiteboard',
    group,
    ...(tool.id === 'eraser' ? { shadows: ['home.done'] } : {}),
  })),
  {
    id: 'whiteboard.editText',
    label: 'Edit selected text',
    keys: ['enter'],
    scope: 'whiteboard',
    group,
    shadows: ['list.open'],
  },
  {
    id: 'whiteboard.selectAll',
    label: 'Select all whiteboard items',
    keys: ['mod+a'],
    scope: 'whiteboard',
    group,
    shadows: ['list.toggleAll'],
  },
  {
    id: 'whiteboard.delete',
    label: 'Delete selected items',
    keys: ['delete', 'backspace'],
    scope: 'whiteboard',
    group,
  },
  ...(['up', 'right', 'down', 'left'] as const).map((direction) => ({
    id: `whiteboard.nudge.${direction}`,
    label: `Nudge ${direction}`,
    keys: [`arrow${direction}`, `shift+arrow${direction}`],
    scope: 'whiteboard',
    group,
    palette: false,
  })),
  {
    id: 'whiteboard.pan',
    label: 'Pan whiteboard',
    keys: ['space'],
    scope: 'whiteboard',
    group,
    palette: false,
  },
  {
    id: 'whiteboard.undo',
    label: 'Undo in whiteboard',
    keys: ['mod+z'],
    scope: 'whiteboard',
    group,
    shadows: ['undo', 'diagram.undo'],
  },
  {
    id: 'whiteboard.redo',
    label: 'Redo in whiteboard',
    keys: ['mod+shift+z', 'mod+y'],
    scope: 'whiteboard',
    group,
    shadows: ['redo', 'diagram.redo'],
  },
];
