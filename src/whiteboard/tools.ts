export const BOARD_TOOLS = [
  { id: 'select', label: 'Select', key: 'v', icon: 'mouse-pointer-2' },
  { id: 'hand', label: 'Hand', key: 'h', icon: 'hand' },
  { id: 'text', label: 'Text', key: 't', icon: 'type' },
  { id: 'rectangle', label: 'Rectangle', key: 'r', icon: 'square' },
  { id: 'ellipse', label: 'Ellipse', key: 'o', icon: 'circle' },
  { id: 'connector', label: 'Connector', key: 'a', icon: 'move-up-right' },
  { id: 'line', label: 'Line', key: 'l', icon: 'minus' },
  { id: 'pencil', label: 'Pencil', key: 'p', icon: 'pencil' },
  { id: 'eraser', label: 'Eraser', key: 'e', icon: 'eraser' },
] as const;
export type BoardTool = (typeof BOARD_TOOLS)[number]['id'];
export const staysActive = (tool: BoardTool): boolean =>
  ['select', 'hand', 'pencil', 'eraser'].includes(tool);
