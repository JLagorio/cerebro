import { isFileRefusal, type FileRefusal } from './fileBytes';
export type FileActionOutcome =
  | { state: 'opened' | 'revealed' | 'previewed' | 'cancelled' }
  | { state: 'saved'; destination: string };
export interface FileActionRefusal {
  code: string;
  message: string;
}
export type FileActionResult = FileActionOutcome | FileActionRefusal;
export const DESKTOP_ONLY: FileActionRefusal = {
  code: 'desktop_only',
  message: 'Desktop app only',
};
const CODES = ['denied', 'inside_vault', 'changed', 'macos_only', 'desktop_failed', 'desktop_only'];
export function isFileActionRefusal(value: unknown): value is FileActionRefusal | FileRefusal {
  if (isFileRefusal(value)) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    typeof value.code === 'string' &&
    CODES.includes(value.code) &&
    typeof value.message === 'string'
  );
}
/** Silent on successful hand-offs and cancel; a saved copy has a useful destination. */
export function fileActionWords(result: FileActionResult): string | null {
  if (isFileActionRefusal(result)) return result.message;
  return result.state === 'saved' ? `Saved a copy to ${result.destination}` : null;
}
export function fileSizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
