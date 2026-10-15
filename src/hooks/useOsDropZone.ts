import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { OsDropKind } from '@/engine/osDrop';
import { registerOsDropZone } from '@/lib/osDrop';

export function useOsDropZone(
  kind: OsDropKind,
  onDrop: (paths: readonly string[], position: { x: number; y: number }) => void | Promise<void>,
) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [over, setOver] = useState(false);
  const handler = useRef(onDrop);
  useLayoutEffect(() => {
    handler.current = onDrop;
  }, [onDrop]);
  useEffect(() => {
    if (element === null) return;
    return registerOsDropZone(element, {
      over: setOver,
      drop: (paths, position) => handler.current(paths, position),
    });
  }, [element]);
  return { zoneProps: { ref: setElement, 'data-os-drop': kind }, over };
}
