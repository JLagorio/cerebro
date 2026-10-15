import { NO_DROP_ZONE, type OsDropEvent } from '@/engine/osDrop';
import { listenOsFileDrop } from './ipc';
import { useUiStore } from '@/stores/uiStore';

interface Zone {
  over: (hovered: boolean) => void;
  drop: (paths: readonly string[], position: { x: number; y: number }) => void | Promise<void>;
}
const zones = new Map<HTMLElement, Zone>();
let paths: readonly string[] = [];
let active: Zone | undefined;
let users = 0;
let installed: { live: boolean; ready: Promise<() => void> } | undefined;

function hover(zone?: Zone): void {
  if (active === zone) return;
  active?.over(false);
  active = zone;
  active?.over(true);
}
function hit(position: { x: number; y: number }): Zone | undefined {
  let element = document.elementFromPoint(position.x, position.y);
  while (element !== null) {
    const zone = zones.get(element as HTMLElement);
    if (zone !== undefined) return zone;
    element = element.parentElement;
  }
  return undefined;
}
export function routeOsDrop(event: OsDropEvent): void {
  if (event.type === 'leave') {
    paths = [];
    hover();
    return;
  }
  if (event.type === 'enter' || event.type === 'drop') paths = event.paths;
  if (paths.length === 0) {
    hover();
    return;
  }
  const zone = hit(event.position);
  if (event.type !== 'drop') {
    hover(zone);
    return;
  }
  const dropped = paths;
  paths = [];
  hover();
  if (zone === undefined) {
    useUiStore.getState().toast(NO_DROP_ZONE);
    return;
  }
  const failed = (error: unknown) =>
    useUiStore
      .getState()
      .toast(`Couldn't add the files — ${error instanceof Error ? error.message : String(error)}`);
  // Capture the target's lifetime at the actual drop, before a navigation or
  // rerender can replace its callback in the next microtask.
  try {
    void Promise.resolve(zone.drop(dropped, event.position)).catch(failed);
  } catch (error) {
    failed(error);
  }
}

/** One native listener shared by the app and all mounted zones. The app
 * keeps it alive even on a page with no zones, so unsupported drops explain. */
export function retainOsDropRouter(): () => void {
  users += 1;
  if (installed === undefined) {
    const subscription = { live: true, ready: Promise.resolve(() => {}) };
    subscription.ready = listenOsFileDrop((event) => {
      if (subscription.live) routeOsDrop(event);
    }).catch((error: unknown) => {
      if (subscription.live)
        useUiStore
          .getState()
          .toast(
            `File drops unavailable — ${error instanceof Error ? error.message : String(error)}`,
          );
      return () => {};
    });
    installed = subscription;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
    if (users === 0) {
      const pending = installed;
      if (pending !== undefined) pending.live = false;
      installed = undefined;
      paths = [];
      hover();
      void pending?.ready.then((stop) => stop());
    }
  };
}
export function registerOsDropZone(element: HTMLElement, zone: Zone): () => void {
  zones.set(element, zone);
  const release = retainOsDropRouter();
  return () => {
    if (active === zone) hover();
    if (zones.get(element) === zone) zones.delete(element);
    release();
  };
}
