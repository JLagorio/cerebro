/** Modified primary clicks reach this capture listener even when an editor
 * stops propagation below it. The intent lasts only through this event. */
let beside = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let installs = 0;
export const openBesideIntent = (): boolean => beside;
export function withOpenBesideIntent<T>(value: boolean, run: () => T): T {
  const previous = beside;
  beside = value;
  try {
    return run();
  } finally {
    beside = previous;
  }
}
function capture(event: MouseEvent): void {
  beside = event.button === 0 && (event.metaKey || event.ctrlKey);
  clearTimeout(timer);
  timer = setTimeout(() => {
    beside = false;
    timer = undefined;
  }, 0);
}
export function installOpenIntent(): () => void {
  if (installs++ === 0) document.addEventListener('click', capture, true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--installs !== 0) return;
    document.removeEventListener('click', capture, true);
    clearTimeout(timer);
    timer = undefined;
    beside = false;
  };
}
