/** Attachment liveness comes from the bytes door, never the markdown scan.
 * Session-local: a later launch probes again because a missing file may return. */
const missing = new Map<string, Set<string>>();
export function noteFilePresence(vault: string, path: string, present: boolean): void {
  if (present) {
    missing.get(vault)?.delete(path);
    if (missing.get(vault)?.size === 0) missing.delete(vault);
  } else {
    const paths = missing.get(vault) ?? new Set<string>();
    paths.add(path);
    missing.set(vault, paths);
  }
}
export function missingFiles(vault: string): readonly string[] {
  return [...(missing.get(vault) ?? [])];
}
