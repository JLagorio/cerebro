/** Thumbnail sizes and typed outcomes (D3: thumbnail-cases.json). */
export type ThumbSize = 128 | 256 | 512;
export type ThumbReason =
  'tooLarge' | 'unsupported' | 'corrupt' | 'noPreview' | 'notFound' | 'toolMissing' | 'timedOut';
export type ThumbSource = 'image' | 'fig' | 'psd' | 'quickLook';
export type Thumbnail =
  | {
      state: 'ready';
      dataUrl: string;
      width: number | null;
      height: number | null;
      source: ThumbSource;
    }
  | { state: 'none'; reason: ThumbReason };
export function snapThumbSize(size: number): ThumbSize {
  return !Number.isFinite(size) || size <= 128 ? 128 : size <= 256 ? 256 : 512;
}
const WORDS: Record<ThumbReason, string> = {
  tooLarge: 'Too large to preview',
  unsupported: 'No preview for this kind of file',
  corrupt: "This file couldn't be read",
  noPreview: 'This file carries no preview',
  toolMissing: 'Previews of this kind need Quick Look (macOS)',
  timedOut: 'The preview took too long',
  notFound: 'File not found',
};
export const thumbReason = (reason: ThumbReason): string => WORDS[reason];
export const thumbSource = (source: ThumbSource): string | null =>
  source === 'quickLook'
    ? 'Preview from Quick Look'
    : source === 'fig' || source === 'psd'
      ? 'Preview stored in the file'
      : null;
