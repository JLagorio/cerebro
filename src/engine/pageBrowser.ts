import { isLibraryEntry } from './library';
import { isDocEntry, isRecordEntry } from './typeCatalog';
import type { Entry } from './types';

/** Ordinary content shares the Pages browser. Stationery, system schemas
 * and guarded knowledge retain the surfaces that own their editing rules. */
export function isBrowserPage(entry: Entry): boolean {
  return !isLibraryEntry(entry) && (isDocEntry(entry) || isRecordEntry(entry));
}
