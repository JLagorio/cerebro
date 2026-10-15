import { kindFor, type Viewer } from '@/engine/fileKinds';
import type { FileProbe } from '@/engine/fileBytes';
export type ViewerKind = 'doc' | 'code' | 'image' | 'media' | 'table' | 'unknown' | 'pdf';
const VIEWERS: Record<Viewer, ViewerKind> = {
  doc: 'doc',
  code: 'code',
  image: 'image',
  media: 'media',
  table: 'table',
  none: 'unknown',
  pdf: 'pdf',
};
export function viewerFor(path: string, probe: FileProbe): ViewerKind {
  const row = kindFor(path);
  if (row.ext === null) return probe.sniff === 'text' && probe.open !== 'deny' ? 'code' : 'unknown';
  return VIEWERS[row.viewer];
}
